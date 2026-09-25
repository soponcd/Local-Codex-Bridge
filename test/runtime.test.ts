import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";

import type { AppServerManager } from "../src/app-server.js";
import {
  MAX_OBSERVE_WAIT_MS,
  MAX_STREAMED_AGENT_TEXT_CHARS,
  RuntimeStore,
  sanitizeForTransport,
  type RuntimeObservation,
} from "../src/runtime.js";
import {
  ControlSurface,
  TOOL_DEFINITIONS,
} from "../src/tools.js";

async function within<T>(promise: Promise<T>, milliseconds = 150): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Promise did not settle within ${milliseconds} ms`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function controlFor(runtime: RuntimeStore): ControlSurface {
  const appServer = {
    runtime,
    request: async (method: string): Promise<unknown> => {
      assert.equal(method, "thread/read");
      return { thread: { id: "stored-thread", turns: [] } };
    },
  } as unknown as AppServerManager;
  return new ControlSurface(appServer);
}

test("sanitizer redacts obvious secrets and bounds strings", () => {
  const result = sanitizeForTransport(
    {
      api_key: "abc123",
      OPENAI_API_KEY: "prefixed-secret",
      GITHUB_TOKEN: "prefixed-token",
      nested: { authorization: "Bearer secret-value", token_count: 42 },
      text: `Bearer abcdefghijklmnop OPENAI_API_KEY=also-secret ${"x".repeat(100)}`,
    },
    { maxStringChars: 30, totalCharBudget: 500 },
  ) as Record<string, unknown>;
  assert.equal(result.api_key, "[REDACTED]");
  assert.equal(result.OPENAI_API_KEY, "[REDACTED]");
  assert.equal(result.GITHUB_TOKEN, "[REDACTED]");
  assert.deepEqual((result.nested as Record<string, unknown>).token_count, 42);
  assert.equal((result.nested as Record<string, unknown>).authorization, "[REDACTED]");
  assert.match(result.text as string, /Bearer \[REDACTED\]/);
  assert.doesNotMatch(result.text as string, /also-secret/);
  assert.match(result.text as string, /truncated/);
});

test("runtime ring uses monotonic cursors, scopes pending raw ids, and captures terminal output", () => {
  const runtime = new RuntimeStore(2);
  runtime.markTurnAccepted("thread-1", "turn-1");
  runtime.recordNotification("turn/started", {
    threadId: "thread-1",
    turn: { id: "turn-1", status: "inProgress" },
  });
  runtime.recordServerRequest("raw-7", "item/fileChange/requestApproval", {
    threadId: "thread-1",
    turnId: "turn-1",
    password: "secret",
  });
  const pending = runtime.claimPending("raw-7", {
    threadId: "thread-1",
    turnId: "turn-1",
    method: "item/fileChange/requestApproval",
  });
  assert.equal(pending.rawId, "raw-7");
  runtime.completePending(pending);
  assert.throws(
    () => runtime.claimPending(7, {
      threadId: "thread-1",
      method: "item/fileChange/requestApproval",
    }),
    /No pending/,
  );
  runtime.recordNotification("item/completed", {
    threadId: "thread-1",
    turnId: "turn-1",
    item: { type: "agentMessage", text: "DONE" },
  });
  runtime.recordNotification("turn/completed", {
    threadId: "thread-1",
    turn: {
      id: "turn-1",
      status: "completed",
      items: [{ type: "agentMessage", text: "DONE" }],
    },
  });
  const observed = runtime.observe("thread-1", 0, 10)!;
  assert.equal(observed.cursor_lost, true);
  assert.equal(observed.events.length, 2);
  assert.equal(observed.terminal?.final_result, "DONE");
  assert.equal(observed.runtime_status, "completed");
});

test("turn/completed without a usable status projects unknown", () => {
  const runtime = new RuntimeStore();
  runtime.markTurnAccepted("thread-unknown", "turn-unknown");

  runtime.recordNotification("turn/completed", {
    threadId: "thread-unknown",
    turn: { id: "turn-unknown", items: [] },
  });

  const observed = runtime.observe("thread-unknown", 0, 10)!;
  assert.equal(observed.runtime_status, "unknown");
  assert.equal(observed.terminal?.status, "unknown");
});

test("streamed agent text stays unchanged under its bound and retains the tail over it", () => {
  const underBound = new RuntimeStore();
  underBound.markTurnAccepted("thread-under", "turn-under");
  underBound.recordNotification("item/agentMessage/delta", {
    threadId: "thread-under",
    turnId: "turn-under",
    delta: "answer: ",
  });
  underBound.recordNotification("item/agentMessage/delta", {
    threadId: "thread-under",
    turnId: "turn-under",
    delta: "FINAL_CONCLUSION",
  });
  underBound.recordNotification("turn/completed", {
    threadId: "thread-under",
    turn: { id: "turn-under", status: "completed", items: [] },
  });
  assert.equal(
    underBound.observe("thread-under", 0, 10)?.terminal?.final_result,
    "answer: FINAL_CONCLUSION",
  );

  const overBound = new RuntimeStore();
  const conclusion = "FINAL_CONCLUSION";
  overBound.markTurnAccepted("thread-over", "turn-over");
  overBound.recordNotification("item/agentMessage/delta", {
    threadId: "thread-over",
    turnId: "turn-over",
    delta: "x".repeat(MAX_STREAMED_AGENT_TEXT_CHARS),
  });
  overBound.recordNotification("item/agentMessage/delta", {
    threadId: "thread-over",
    turnId: "turn-over",
    delta: conclusion,
  });
  overBound.recordNotification("turn/completed", {
    threadId: "thread-over",
    turn: { id: "turn-over", status: "completed", items: [] },
  });

  const retained = overBound.observe("thread-over", 0, 10)?.terminal?.final_result;
  assert.equal(retained?.length, MAX_STREAMED_AGENT_TEXT_CHARS);
  assert.equal(retained?.endsWith(conclusion), true);
  assert.equal(
    retained,
    `${"x".repeat(MAX_STREAMED_AGENT_TEXT_CHARS - conclusion.length)}${conclusion}`,
  );
});

test("pending app-server request ids preserve typed identity and cannot be replaced while responding", () => {
  const runtime = new RuntimeStore();
  runtime.markTurnAccepted("thread-original", "turn-original");
  assert.equal(
    runtime.recordServerRequest(17, "item/fileChange/requestApproval", {
      threadId: "thread-original",
      turnId: "turn-original",
      marker: "original",
    }),
    "recorded",
  );
  const original = runtime.claimPending(17, {
    threadId: "thread-original",
    turnId: "turn-original",
    method: "item/fileChange/requestApproval",
  });

  assert.equal(
    runtime.recordServerRequest(17, "item/commandExecution/requestApproval", {
      threadId: "thread-duplicate",
      turnId: "turn-duplicate",
      marker: "must-not-replace",
    }),
    "duplicate",
  );
  assert.equal(
    runtime.recordServerRequest("17", "item/tool/requestUserInput", {
      threadId: "thread-string",
      turnId: "turn-string",
    }),
    "recorded",
  );
  assert.equal(runtime.hasThread("thread-duplicate"), false);
  const stillOriginal = runtime.pendingForThread("thread-original") as Array<Record<string, unknown>>;
  assert.equal(stillOriginal.length, 1);
  assert.equal(stillOriginal[0]?.request_id, 17);
  assert.equal(
    ((stillOriginal[0]?.params as Record<string, unknown>).marker),
    "original",
  );
  assert.equal(
    (runtime.pendingForThread("thread-string")[0] as Record<string, unknown>).request_id,
    "17",
  );

  runtime.releasePending(original);
  const retried = runtime.claimPending(17, {
    threadId: "thread-original",
    turnId: "turn-original",
    method: "item/fileChange/requestApproval",
  });
  runtime.releasePending(retried);

  runtime.recordNotification("serverRequest/resolved", {
    threadId: "thread-original",
    turnId: "turn-original",
    requestId: 17,
  });
  assert.equal(
    runtime.recordServerRequest(17, "item/fileChange/requestApproval", {
      threadId: "thread-reused",
      turnId: "turn-reused",
      marker: "reused",
    }),
    "recorded",
  );
  runtime.completePending(original);
  runtime.releasePending(original);
  const reused = runtime.pendingForThread("thread-reused") as Array<Record<string, unknown>>;
  assert.equal(reused.length, 1);
  assert.equal((reused[0]?.params as Record<string, unknown>).marker, "reused");
});

test("late turn acknowledgements preserve same-turn terminals but replace older terminal state", () => {
  const sameTurn = new RuntimeStore();
  sameTurn.markTurnAccepted("thread-same-terminal", "turn-terminal");
  sameTurn.recordNotification("turn/completed", {
    threadId: "thread-same-terminal",
    turn: {
      id: "turn-terminal",
      status: "completed",
      items: [{ type: "agentMessage", text: "DONE" }],
    },
  });
  sameTurn.reconcileLateMutationSuccess({
    method: "turn/start",
    threadId: "thread-same-terminal",
    turnId: "turn-terminal",
    status: "inProgress",
    timedOutAt: "2026-08-12T00:00:00.000Z",
  });
  const preserved = sameTurn.observe("thread-same-terminal", 0, 10)!;
  assert.equal(preserved.active_turn_id, null);
  assert.equal(preserved.terminal?.turn_id, "turn-terminal");
  assert.equal(
    (preserved.events.at(-1)?.data as Record<string, unknown>).reason,
    "terminal_present",
  );

  const oldTerminal = new RuntimeStore();
  oldTerminal.markTurnAccepted("thread-old-terminal", "turn-old");
  oldTerminal.recordNotification("item/completed", {
    threadId: "thread-old-terminal",
    turnId: "turn-old",
    item: { type: "agentMessage", text: "OLD_TEXT" },
  });
  oldTerminal.recordNotification("turn/completed", {
    threadId: "thread-old-terminal",
    turn: { id: "turn-old", status: "completed", items: [] },
  });
  const timeoutAfterOldTerminal = new Date(Date.now() + 1_000).toISOString();
  oldTerminal.reconcileLateMutationSuccess({
    method: "turn/start",
    threadId: "thread-old-terminal",
    turnId: "turn-new",
    status: "inProgress",
    timedOutAt: timeoutAfterOldTerminal,
  });
  const activated = oldTerminal.observe("thread-old-terminal", 0, 10)!;
  assert.equal(activated.active_turn_id, "turn-new");
  assert.equal(activated.terminal, null);
  assert.equal(
    (activated.events.at(-1)?.data as Record<string, unknown>).action,
    "turn_activated",
  );
  oldTerminal.recordNotification("turn/completed", {
    threadId: "thread-old-terminal",
    turn: { id: "turn-new", status: "completed", items: [] },
  });
  assert.equal(
    oldTerminal.observe("thread-old-terminal", 0, 20)?.terminal?.final_result,
    null,
  );

  const newerActive = new RuntimeStore();
  newerActive.markTurnAccepted("thread-newer", "turn-current");
  newerActive.reconcileLateMutationSuccess({
    method: "turn/start",
    threadId: "thread-newer",
    turnId: "turn-stale",
    status: "inProgress",
    timedOutAt: "2026-08-12T00:00:02.000Z",
  });
  assert.equal(
    newerActive.observe("thread-newer", 0, 10)?.active_turn_id,
    "turn-current",
  );

  const newerTerminal = new RuntimeStore();
  const timeoutBeforeNewerTerminal = new Date(Date.now() - 1_000).toISOString();
  newerTerminal.markTurnAccepted("thread-newer-terminal", "turn-newer");
  newerTerminal.recordNotification("turn/completed", {
    threadId: "thread-newer-terminal",
    turn: { id: "turn-newer", status: "completed", items: [] },
  });
  newerTerminal.reconcileLateMutationSuccess({
    method: "turn/start",
    threadId: "thread-newer-terminal",
    turnId: "turn-stale-different",
    status: "inProgress",
    timedOutAt: timeoutBeforeNewerTerminal,
  });
  const newerTerminalObserved = newerTerminal.observe(
    "thread-newer-terminal",
    0,
    10,
  )!;
  assert.equal(newerTerminalObserved.active_turn_id, null);
  assert.equal(newerTerminalObserved.terminal?.turn_id, "turn-newer");
  assert.equal(
    (newerTerminalObserved.events.at(-1)?.data as Record<string, unknown>).reason,
    "newer_terminal_present",
  );
});

test("observe wait defaults to immediate and buffered events bypass waiting", async () => {
  const runtime = new RuntimeStore();
  runtime.markTurnAccepted("thread-immediate", "turn-immediate");
  const control = controlFor(runtime);

  const immediate = await within(control.call("codex_observe", {
    thread_id: "thread-immediate",
    cursor: 0,
    view: "raw",
  }));
  assert.deepEqual(immediate, runtime.observe("thread-immediate", 0, 50));
  assert.deepEqual(await within(control.call("codex_observe", {
    thread_id: "thread-immediate",
    cursor: 0,
    wait_ms: 0,
    view: "raw",
  })), immediate);

  runtime.recordNotification("item/started", {
    threadId: "thread-immediate",
    turnId: "turn-immediate",
    item: { type: "commandExecution", id: "command-buffered" },
  });
  const buffered = await within(control.call("codex_observe", {
    thread_id: "thread-immediate",
    cursor: 0,
    wait_ms: MAX_OBSERVE_WAIT_MS,
    view: "raw",
  }));
  const events = (buffered as Record<string, unknown>).events as Array<Record<string, unknown>>;
  assert.equal(events.length, 1);
  assert.equal(events[0]?.method, "item/started");
});

test("active observe wait wakes on an injected runtime event and otherwise times out", async () => {
  const runtime = new RuntimeStore();
  runtime.markTurnAccepted("thread-wait", "turn-wait");
  const control = controlFor(runtime);

  const waiting = control.call("codex_observe", {
    thread_id: "thread-wait",
    cursor: 0,
    wait_ms: 120_000,
  });
  runtime.recordNotification("item/started", {
    threadId: "thread-wait",
    turnId: "turn-wait",
    item: { type: "commandExecution", id: "command-wakeup" },
  });
  const woken = await within(waiting);
  const wokenEvents = (woken as Record<string, unknown>).events as Array<Record<string, unknown>>;
  assert.equal(wokenEvents.length, 1);
  assert.equal(wokenEvents[0]?.method, "item/started");

  const startedAt = performance.now();
  const timedOut = await within(control.call("codex_observe", {
    thread_id: "thread-wait",
    cursor: runtime.currentCursor("thread-wait"),
    wait_ms: 40,
  }), 500);
  const elapsed = performance.now() - startedAt;
  assert.ok(elapsed >= 25, `observe returned too early after ${elapsed.toFixed(1)} ms`);
  assert.ok(elapsed < 500, `observe exceeded its bounded deadline: ${elapsed.toFixed(1)} ms`);
  assert.deepEqual(timedOut, {
    runtime_available: true,
    runtime_status: "inProgress",
    active_turn_id: "turn-wait",
    next_cursor: runtime.currentCursor("thread-wait"),
    no_change: true,
  });
});

test("observe no-change deadlines omit seen output and preserve the continuation cursor", async () => {
  const runtime = new RuntimeStore();
  runtime.markTurnAccepted("thread-quiet", "turn-quiet");
  runtime.recordNotification("item/completed", {
    threadId: "thread-quiet",
    turnId: "turn-quiet",
    item: { type: "commandExecution", id: "seen-command", aggregatedOutput: "SEEN_OUTPUT" },
  });
  const control = controlFor(runtime);
  const seen = await control.call("codex_observe", {
    thread_id: "thread-quiet",
    cursor: 0,
    view: "raw",
  }) as RuntimeObservation;
  assert.match(JSON.stringify(seen), /SEEN_OUTPUT/);

  for (let index = 0; index < 2; index += 1) {
    const quiet = await within(control.call("codex_observe", {
      thread_id: "thread-quiet",
      cursor: seen.next_cursor,
      wait_ms: 10,
      view: "raw",
    }));
    assert.deepEqual(quiet, {
      runtime_available: true,
      runtime_status: "inProgress",
      active_turn_id: "turn-quiet",
      next_cursor: seen.next_cursor,
      no_change: true,
    });
    assert.equal(runtime.currentCursor("thread-quiet"), seen.next_cursor);
  }

  const waiting = control.call("codex_observe", {
    thread_id: "thread-quiet",
    cursor: seen.next_cursor,
    wait_ms: 40,
    view: "raw",
  });
  runtime.recordNotification("item/commandExecution/outputDelta", {
    threadId: "thread-quiet",
    turnId: "turn-quiet",
    itemId: "new-command",
    delta: "NEW_OUTPUT",
  });
  const changed = await within(waiting);
  assert.deepEqual(changed, runtime.observe("thread-quiet", seen.next_cursor, 50));
  assert.match(JSON.stringify(changed), /NEW_OUTPUT/);
  assert.doesNotMatch(JSON.stringify(changed), /SEEN_OUTPUT/);
});

test("observe waits preserve full snapshots on native and revision-only changes", async () => {
  const changes: Array<{ name: string; mutate: (runtime: RuntimeStore) => void }> = [
    {
      name: "native status event",
      mutate: (runtime) => runtime.recordNotification("thread/status/changed", {
        threadId: "thread-change",
        status: { type: "active" },
      }),
    },
    {
      name: "pending request",
      mutate: (runtime) => runtime.recordServerRequest(7, "item/fileChange/requestApproval", {
        threadId: "thread-change",
        turnId: "turn-change",
      }),
    },
    {
      name: "terminal result",
      mutate: (runtime) => runtime.recordNotification("turn/completed", {
        threadId: "thread-change",
        turn: {
          id: "turn-change",
          status: "completed",
          items: [{ type: "agentMessage", text: "NEW_FINAL_OUTPUT" }],
        },
      }),
    },
    {
      name: "turn accepted without a native event",
      mutate: (runtime) => runtime.markTurnAccepted("thread-change", "turn-next"),
    },
    {
      name: "app-server exit",
      mutate: (runtime) => runtime.markAppServerExited("test exit"),
    },
  ];
  for (const { name, mutate } of changes) {
    const runtime = new RuntimeStore();
    runtime.markTurnAccepted("thread-change", "turn-change");
    const waiting = controlFor(runtime).call("codex_observe", {
      thread_id: "thread-change",
      cursor: 0,
      wait_ms: 40,
      view: "raw",
    });
    mutate(runtime);
    assert.deepEqual(await within(waiting), runtime.observe("thread-change", 0, 50), name);
  }
});

test("observe cursor recovery and buffered pagination retain full snapshots", async () => {
  const runtime = new RuntimeStore(2);
  runtime.markTurnAccepted("thread-cursors", "turn-cursors");
  for (let index = 0; index < 3; index += 1) {
    runtime.recordNotification("item/started", {
      threadId: "thread-cursors",
      turnId: "turn-cursors",
      item: { type: "commandExecution", id: "command-" + index },
    });
  }
  const control = controlFor(runtime);
  for (const cursor of [0, 1]) {
    const observed = await within(control.call("codex_observe", {
      thread_id: "thread-cursors",
      cursor,
      limit: 1,
      wait_ms: MAX_OBSERVE_WAIT_MS,
      view: "raw",
    }));
    assert.deepEqual(observed, runtime.observe("thread-cursors", cursor, 1));
    assert.equal((observed as RuntimeObservation).cursor_lost, cursor === 0);
    assert.equal((observed as RuntimeObservation).has_more, true);
  }
});

test("cancelling one same-thread observe wait leaves the other waiter intact", async () => {
  const runtime = new RuntimeStore();
  runtime.markTurnAccepted("thread-cancel-one", "turn-cancel-one");
  const control = controlFor(runtime);
  const firstController = new AbortController();
  const secondController = new AbortController();

  const first = control.call("codex_observe", {
    thread_id: "thread-cancel-one",
    cursor: 0,
    wait_ms: 1_000,
  }, firstController.signal);
  const second = control.call("codex_observe", {
    thread_id: "thread-cancel-one",
    cursor: 0,
    wait_ms: 1_000,
  }, secondController.signal);

  firstController.abort();
  await assert.rejects(within(first), /MCP request cancelled/);

  runtime.recordNotification("item/started", {
    threadId: "thread-cancel-one",
    turnId: "turn-cancel-one",
    item: { type: "commandExecution", id: "command-after-cancel" },
  });
  const observed = await within(second);
  const events = (observed as Record<string, unknown>).events as Array<Record<string, unknown>>;
  assert.equal(events.length, 1);
  assert.equal(events[0]?.method, "item/started");
});

test("observe cancellation before waiter registration settles immediately", async () => {
  const controller = new AbortController();
  const runtime = new RuntimeStore();
  runtime.markTurnAccepted("thread-cancel-before-register", "turn-cancel-before-register");
  const control = controlFor(runtime);
  controller.abort();

  await assert.rejects(
    within(control.call("codex_observe", {
      thread_id: "thread-cancel-before-register",
      cursor: 0,
      wait_ms: 1_000,
    }, controller.signal)),
    /MCP request cancelled/,
  );
});

test("observe wait handoff cannot lose a mutation between snapshot and registration", async () => {
  class HandoffRuntimeStore extends RuntimeStore {
    #injected = false;

    override observe(
      threadId: string,
      cursor: number | undefined,
      limit: number,
    ): RuntimeObservation | null {
      const snapshot = super.observe(threadId, cursor, limit);
      if (!this.#injected && snapshot?.active_turn_id) {
        this.#injected = true;
        this.recordNotification("item/started", {
          threadId,
          turnId: snapshot?.active_turn_id,
          item: { type: "commandExecution", id: "command-handoff" },
        });
      }
      return snapshot;
    }
  }

  const runtime = new HandoffRuntimeStore();
  runtime.markTurnAccepted("thread-handoff", "turn-handoff");
  const observed = await within(
    runtime.observeWithWait("thread-handoff", 0, 10, 1_000),
  );
  assert.ok(observed && "events" in observed);
  assert.equal(observed.events.length, 1);
  assert.equal(observed.events[0]?.method, "item/started");
});

test("completed, pending, inactive, and unavailable observe states do not wait", async () => {
  const completedRuntime = new RuntimeStore();
  completedRuntime.markTurnAccepted("thread-completed", "turn-completed");
  completedRuntime.recordNotification("turn/completed", {
    threadId: "thread-completed",
    turn: { id: "turn-completed", status: "completed", items: [] },
  });
  const completed = await within(controlFor(completedRuntime).call("codex_observe", {
    thread_id: "thread-completed",
    cursor: completedRuntime.currentCursor("thread-completed"),
    wait_ms: MAX_OBSERVE_WAIT_MS,
  }));
  assert.equal(
    ((completed as Record<string, unknown>).terminal as Record<string, unknown>).status,
    "completed",
  );

  const pendingRuntime = new RuntimeStore();
  pendingRuntime.markTurnAccepted("thread-pending", "turn-pending");
  pendingRuntime.recordServerRequest(7, "item/fileChange/requestApproval", {
    threadId: "thread-pending",
    turnId: "turn-pending",
  });
  const pending = await within(controlFor(pendingRuntime).call("codex_observe", {
    thread_id: "thread-pending",
    cursor: pendingRuntime.currentCursor("thread-pending"),
    wait_ms: MAX_OBSERVE_WAIT_MS,
  }));
  assert.equal(
    ((pending as Record<string, unknown>).pending_requests as unknown[]).length,
    1,
  );

  const inactiveRuntime = new RuntimeStore();
  inactiveRuntime.ensureThread("thread-inactive");
  const inactive = await within(controlFor(inactiveRuntime).call("codex_observe", {
    thread_id: "thread-inactive",
    wait_ms: MAX_OBSERVE_WAIT_MS,
  }));
  assert.equal((inactive as Record<string, unknown>).active_turn_id, null);

  const unavailable = await within(controlFor(new RuntimeStore()).call("codex_observe", {
    thread_id: "thread-unavailable",
    wait_ms: MAX_OBSERVE_WAIT_MS,
  }));
  assert.equal((unavailable as Record<string, unknown>).runtime_available, false);
});

test("observe wait schema and validation preserve bounded optional semantics", async () => {
  const observeTool = TOOL_DEFINITIONS.find((tool) => tool.name === "codex_observe");
  const properties = (observeTool?.inputSchema.properties ?? {}) as Record<string, unknown>;
  assert.deepEqual(properties.wait_ms, {
    type: "integer",
    minimum: 0,
    maximum: 120_000,
    default: 0,
    description:
      "Optional fixed per-call wait for a supervision wake or deadline in compact view; raw retains its existing event wait. 0 drains currently available events immediately. This is not stall detection.",
  });
  assert.match(observeTool?.description ?? "", /Optional wait_ms performs one bounded event-driven wait/);
  assert.match(observeTool?.description ?? "", /fixed per-call deadline/);
  assert.match(observeTool?.description ?? "", /absence of new command activity alone is not evidence of a stall/);
  assert.match(observeTool?.description ?? "", /repeated bounded-wait observe calls until terminal.*one snapshot is inProgress/);
  assert.match(observeTool?.description ?? "", /After every wake or deadline return, inspect the newly available events\/state.*before starting the next bounded wait/);
  assert.deepEqual(properties.view, {
    type: "string",
    enum: ["compact", "raw"],
    default: "compact",
    description: "Compact facts by default; raw returns the existing sanitized native event envelope. Raw retains native pagination and its existing wait behavior.",
  });

  const runtime = new RuntimeStore();
  runtime.ensureThread("thread-validation");
  const control = controlFor(runtime);
  for (const waitMs of [-1, 120_001, 1.5]) {
    await assert.rejects(
      control.call("codex_observe", {
        thread_id: "thread-validation",
        wait_ms: waitMs,
      }),
      /wait_ms must be an integer from 0 to 120000/,
    );
    await assert.rejects(
      runtime.observeWithWait("thread-validation", undefined, 50, waitMs),
      /wait_ms must be an integer from 0 to 120000/
    );
  }
  await within(control.call("codex_observe", {
    thread_id: "thread-validation",
    wait_ms: 0,
  }));
  await within(control.call("codex_observe", {
    thread_id: "thread-validation",
    wait_ms: MAX_OBSERVE_WAIT_MS,
  }));
});
