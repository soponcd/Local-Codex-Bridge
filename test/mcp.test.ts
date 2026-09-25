import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import test from "node:test";

import type { AppServerManager } from "../src/app-server.js";
import { CHECKPOINT_DIRECTORY_ENV, CheckpointStore } from "../src/checkpoint.js";
import { McpStdioServer } from "../src/mcp.js";
import { RuntimeStore } from "../src/runtime.js";
import { ControlSurface, TOOL_NAMES } from "../src/tools.js";

type RpcId = string | number;

class TestClient {
  readonly child: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<string, (message: Record<string, unknown>) => void>();
  readonly #unclaimed: Record<string, unknown>[] = [];
  #buffer = "";

  constructor(environment: NodeJS.ProcessEnv = process.env, entry = fileURLToPath(new URL("../src/index.js", import.meta.url))) {
    this.child = spawn(process.execPath, [entry], {
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.#buffer += chunk;
      while (true) {
        const newline = this.#buffer.indexOf("\n");
        if (newline < 0) return;
        const line = this.#buffer.slice(0, newline).replace(/\r$/, "");
        this.#buffer = this.#buffer.slice(newline + 1);
        if (!line) continue;
        const message = JSON.parse(line) as Record<string, unknown>;
        const id = message.id;
        if (typeof id === "string" || typeof id === "number") {
          const key = `${typeof id}:${String(id)}`;
          const pending = this.#pending.get(key);
          if (pending) {
            pending(message);
            this.#pending.delete(key);
          } else {
            this.#unclaimed.push(message);
          }
        }
      }
    });
  }

  request(id: RpcId, method: string, params: unknown = {}): Promise<Record<string, unknown>> {
    const response = this.expect(id, method);
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return response;
  }

  expect(id: RpcId, label = "response"): Promise<Record<string, unknown>> {
    const key = `${typeof id}:${String(id)}`;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), 3_000);
      this.#pending.set(key, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
  }

  writeRaw(value: string): void {
    this.child.stdin.write(value);
  }

  takeUnclaimed(): Record<string, unknown>[] {
    return this.#unclaimed.splice(0);
  }

  async close(): Promise<number | null> {
    this.child.stdin.end();
    return await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.child.kill();
        reject(new Error("MCP server did not exit after stdin EOF"));
      }, 3_000);
      this.child.once("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  }
}

function toolPayload(response: Record<string, unknown>): Record<string, unknown> {
  const result = response.result as Record<string, unknown>;
  const content = result.content as Array<Record<string, unknown>>;
  assert.equal(content.length, 1);
  assert.equal(content[0]?.type, "text");
  assert.equal(typeof content[0]?.text, "string");
  return JSON.parse(content[0]?.text as string) as Record<string, unknown>;
}

test("MCP history pages serialize exactly and errors keep stable prefixes without partial data", async () => {
  const fixture = fileURLToPath(new URL("./history-mcp-fixture.js", import.meta.url));
  const client = new TestClient(process.env, fixture);
  try {
    await initialize(client, 1);
    const turns = successfulToolPayload(await client.request(2, "tools/call", {
      name: "codex_threads", arguments: { thread_id: "thread-1", history: { kind: "turns" } },
    }));
    assert.deepEqual(turns, {
      source: "codex_app_server", mode: "history", coverage: "native_persisted_history",
      kind: "turns", thread_id: "thread-1", data: [{ id: "turn-1", status: "completed", items: [] }],
      nextCursor: "next-turn", backwardsCursor: "reverse-turn",
    });
    const items = successfulToolPayload(await client.request(3, "tools/call", {
      name: "codex_threads", arguments: { thread_id: "thread-1", history: { kind: "items", turn_id: "turn-1" } },
    }));
    assert.deepEqual(items.data, [{ turnId: "turn-1", item: { id: "item-1", type: "agentMessage", text: "🌱 exact" } }]);
    const boundary = successfulToolPayload(await client.request(5, "tools/call", {
      name: "codex_threads", arguments: { thread_id: "thread-1", history: { kind: "turns", cursor: "near-boundary" } },
    }));
    assert.equal((boundary.data as unknown[]).length, 10);
    const oversizedId = "request-" + "x".repeat(2_000);
    const tooLargeFrame = await client.request(oversizedId, "tools/call", {
      name: "codex_threads", arguments: { thread_id: "thread-1", history: { kind: "turns", cursor: "near-boundary" } },
    });
    assert.equal((tooLargeFrame.result as Record<string, unknown>).isError, true);
    assert.match(toolPayload(tooLargeFrame).error as string, /^history_page_too_large:/);
    for (const [cursor, prefix] of [
      ["malformed", "history_upstream_invalid:"],
      ["redacted", "history_page_not_lossless:"],
      ["oversized", "history_page_too_large:"],
    ] as const) {
      const response = await client.request(cursor, "tools/call", {
        name: "codex_threads", arguments: { thread_id: "thread-1", history: { kind: "turns", cursor } },
      });
      assert.equal((response.result as Record<string, unknown>).isError, true);
      const error = toolPayload(response);
      assert.match(error.error as string, new RegExp(`^${prefix}`));
      assert.deepEqual(Object.keys(error), ["error"]);
    }
    const stale = await client.request(4, "tools/call", {
      name: "codex_threads", arguments: { thread_id: "thread-1", history: { kind: "turns", cursor: "stale" } },
    });
    assert.match(toolPayload(stale).error as string, /native invalid cursor/);
  } finally {
    assert.equal(await client.close(), 0);
  }
});

function successfulToolPayload(response: Record<string, unknown>): Record<string, unknown> {
  const result = response.result as Record<string, unknown>;
  assert.notEqual(result.isError, true, "expected successful MCP tools/call result");
  return structuredToolPayload(response);
}

async function initialize(client: TestClient, id: RpcId): Promise<void> {
  const response = await client.request(id, "initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  });
  assert.equal(response.error, undefined);
}

function structuredToolPayload(response: Record<string, unknown>): Record<string, unknown> {
  assert.equal(response.error, undefined);
  const result = response.result as Record<string, unknown>;
  assert.deepEqual(Object.keys(result).sort(), ["content", "structuredContent"]);
  const content = result.content as Array<{ type: string; text: string }>;
  assert.deepEqual(content, [{ type: "text", text: "structured result" }]);
  assert.ok(Buffer.byteLength(JSON.stringify(content), "utf8") <= 64, "content must remain tiny");
  assert.equal(content[0]!.text.includes(JSON.stringify(result.structuredContent)), false);
  assert.ok(result.structuredContent !== null && typeof result.structuredContent === "object");
  assert.equal(Array.isArray(result.structuredContent), false, "success payload must be an object");
  return result.structuredContent as Record<string, unknown>;
}

type InMemoryRequest = (id: number, method: string, params?: unknown) => Promise<Record<string, unknown>>;

async function withInMemoryMcp(control: ControlSurface, run: (request: InMemoryRequest) => Promise<void>): Promise<void> {
  const input = new PassThrough();
  const output = new PassThrough();
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process, "stdin")!;
  const stdoutDescriptor = Object.getOwnPropertyDescriptor(process, "stdout")!;
  const server = new McpStdioServer(control, { onClose: () => undefined });
  const request: InMemoryRequest = async (id, method, params = {}) => {
    const response = new Promise<Record<string, unknown>>((resolve) => {
      output.once("data", (chunk: Buffer) => resolve(JSON.parse(chunk.toString("utf8")) as Record<string, unknown>));
    });
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return await response;
  };
  Object.defineProperty(process, "stdin", { configurable: true, value: input });
  Object.defineProperty(process, "stdout", { configurable: true, value: output });
  try {
    server.start();
    assert.equal((await request(0, "initialize", {
      protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "observe-transport-test", version: "1" },
    })).error, undefined);
    await run(request);
  } finally {
    await server.close();
    Object.defineProperty(process, "stdin", stdinDescriptor);
    Object.defineProperty(process, "stdout", stdoutDescriptor);
    input.destroy();
    output.destroy();
  }
}

for (const view of ["compact", "raw"] as const) {
  test(`MCP ${view} observe preserves the complete result as structuredContent with tiny text`, { timeout: 3_000 }, async (t) => {
    const runtime = new RuntimeStore();
    const threadId = "observe-transport-thread";
    const turnId = "observe-transport-turn";
    runtime.markTurnAccepted(threadId, turnId);
    const finalItem = { type: "agentMessage", id: "final-message", phase: "final_answer", text: "Observe transport final" };
    runtime.recordNotification("item/completed", { threadId, turnId, completedAtMs: 1, item: finalItem });
    const pendingMethod = "item/commandExecution/requestApproval";
    const pendingParams = { threadId, turnId, itemId: "command-1", command: "echo transport", reason: "test approval" };
    runtime.recordServerRequest(7, pendingMethod, pendingParams);
    const control = new ControlSurface({ runtime } as unknown as AppServerManager);
    const call = control.call.bind(control);
    let original: unknown;
    t.mock.method(control, "call", async (...args: Parameters<ControlSurface["call"]>) => {
      original = await call(...args);
      return original;
    });
    await withInMemoryMcp(control, async (request) => {
      let id = 1;
      const observe = async (cursor: number, limit = 50): Promise<Record<string, unknown>> => {
        const response = await request(id++, "tools/call", {
          name: "codex_observe", arguments: { thread_id: threadId, cursor, limit, view },
        });
        const payload = structuredToolPayload(response);
        assert.deepEqual(payload, original, "transport must preserve the original ControlSurface result");
        return payload;
      };
      const first = await observe(0, 1);
      assert.equal(first.has_more, true);
      assert.equal((first.events as unknown[]).length, 1);
      const pending = first.pending_requests as Array<Record<string, unknown>>;
      assert.equal(pending[0]!.request_id, 7);
      assert.deepEqual(pending[0]!.params, pendingParams);
      if (view === "raw") {
        for (const key of ["runtime_available", "runtime_status", "active_turn_id", "events", "next_cursor", "current_cursor", "cursor_floor", "cursor_lost", "has_more", "pending_requests", "terminal"]) {
          assert.equal(Object.hasOwn(first, key), true, `raw envelope must retain ${key}`);
        }
        assert.deepEqual(first.events, runtime.observe(threadId, 0, 1)!.events);
        assert.equal(first.cursor_floor, 0);
        assert.equal(first.cursor_lost, false);
      }
      const continued = await observe(first.next_cursor as number);
      assert.ok((continued.next_cursor as number) > (first.next_cursor as number));
      assert.deepEqual(await observe(0, 1), first, "old-cursor replay must survive transport");

      runtime.completePending(runtime.claimPending(7, { threadId, turnId, method: pendingMethod }));
      runtime.recordNotification("turn/completed", { threadId, turn: { id: turnId, status: "completed", items: [finalItem] } });
      const completed = await observe(continued.next_cursor as number);
      assert.equal(completed.runtime_status, "completed");
      assert.equal((completed.terminal as Record<string, unknown>).status, "completed");
    });
  });
}

test("MCP all successful tools use structuredContent without JSON-as-text", { timeout: 3_000 }, async (t) => {
  const appServer = new Proxy({} as AppServerManager, {
    get() { throw new Error("Transport test must not access native Codex"); },
  });
  const control = new ControlSurface(appServer);
  const original = { nested: { list: ["transport", 7, null] }, has_more: false };
  t.mock.method(control, "call", async () => original);
  await withInMemoryMcp(control, async (request) => {
    let id = 1;
    for (const name of TOOL_NAMES) {
      const response = await request(id++, "tools/call", { name, arguments: {} });
      assert.equal(response.error, undefined);
      assert.deepEqual(structuredToolPayload(response), original, name);
    }
  });
});

test("MCP all tool failures retain the original text-only isError envelope", { timeout: 3_000 }, async (t) => {
  const appServer = new Proxy({} as AppServerManager, {
    get() { throw new Error("Transport test must not access native Codex"); },
  });
  const control = new ControlSurface(appServer);
  t.mock.method(control, "call", async () => { throw new Error("Synthetic tool failure"); });
  await withInMemoryMcp(control, async (request) => {
    let id = 1;
    for (const name of TOOL_NAMES) {
      const requestId = id++;
      assert.deepEqual(await request(requestId, "tools/call", { name, arguments: {} }), {
        jsonrpc: "2.0", id: requestId,
        result: {
          content: [{ type: "text", text: JSON.stringify({ error: "Synthetic tool failure" }) }],
          isError: true,
        },
      }, name);
    }
  });
});

test("MCP models, turn ack, and checkpoint preserve original handler results", { timeout: 3_000 }, async (t) => {
  const checkpointDirectory = mkdtempSync(join(tmpdir(), "structured-transport-checkpoint-"));
  const runtime = new RuntimeStore();
  const threadId = "structured-transport-thread";
  const turnId = "structured-transport-turn";
  const modelPage = {
    data: [{ id: "transport-model", supportedReasoningEfforts: [{ reasoningEffort: "high", description: "Transport fixture" }] }],
    nextCursor: "next-model-page",
  };
  const nativeMethods: string[] = [];
  const appServer = {
    runtime,
    async request(method: string) {
      nativeMethods.push(method);
      switch (method) {
        case "model/list": return modelPage;
        case "thread/resume": return { thread: { id: threadId } };
        case "turn/start": return { turn: { id: turnId, status: "inProgress" } };
        default: throw new Error("Unexpected fake app-server request: " + method);
      }
    },
  } as unknown as AppServerManager;
  const control = new ControlSurface(appServer, new CheckpointStore(checkpointDirectory));
  const call = control.call.bind(control);
  let original: unknown;
  t.mock.method(control, "call", async (...args: Parameters<ControlSurface["call"]>) => {
    original = await call(...args);
    return original;
  });
  try {
    await withInMemoryMcp(control, async (request) => {
      let id = 1;
      const invoke = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
        const payload = structuredToolPayload(await request(id++, "tools/call", { name, arguments: args }));
        assert.deepEqual(payload, original, name + " must preserve the original ControlSurface result");
        return payload;
      };
      assert.deepEqual(await invoke("codex_models", { limit: 1 }), {
        source: "codex_app_server_model_list", ...modelPage,
      });
      assert.deepEqual(await invoke("codex_turn", { thread_id: threadId, text: "Synthetic transport turn" }), {
        accepted: true, thread_id: threadId, turn_id: turnId,
        event_cursor: runtime.currentCursor(threadId), status: "inProgress",
      });
      assert.deepEqual(await invoke("codex_checkpoint", { action: "read", thread_id: threadId }), {
        source: "local_codex_bridge_checkpoint", found: false, thread_id: threadId, checkpoint: null,
      });
      const initialized = await invoke("codex_checkpoint", {
        action: "update", thread_id: threadId,
        original_goal: "Verify structured transport.",
        original_constraints: "Use synthetic fixtures only.",
        original_acceptance: "Preserve the complete handler result.",
        current_understanding: "Checkpoint content is nested.",
        current_decision: "Check exact transport equality.",
        acceptance_status: "Transport test in progress.",
        next_step: "Read the checkpoint.",
      });
      assert.equal(initialized.operation, "initialized");
      const recovered = await invoke("codex_checkpoint", { action: "read", thread_id: threadId });
      assert.deepEqual(recovered.checkpoint, initialized.checkpoint);
      assert.deepEqual(nativeMethods, ["model/list", "thread/resume", "turn/start"]);
    });
  } finally {
    rmSync(checkpointDirectory, { recursive: true, force: true });
  }
});

test("MCP stdio initializes idempotently and lists exactly eight fully annotated tools", async () => {
  const client = new TestClient();
  try {
    const initializeLine = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {
          roots: { listChanged: true },
          sampling: {},
        },
        clientInfo: { name: "test", version: "1" },
      },
    });
    const initializeResponse = client.expect(1, "fragmented initialize");
    client.writeRaw(initializeLine.slice(0, 35));
    client.writeRaw(`${initializeLine.slice(35)}\n`);
    const initialized = await initializeResponse;
    assert.equal(
      (initialized.result as Record<string, unknown>).protocolVersion,
      "2025-03-26",
    );
    assert.deepEqual(
      (initialized.result as Record<string, unknown>).serverInfo,
      {
        name: "local-codex-bridge",
        title: "Local Codex Bridge",
        version: "2.1.3",
      },
    );

    // A second initialize reuses the first negotiated result with its own response id.
    const repeated = await client.request(0, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {
        roots: { listChanged: true },
        sampling: {},
      },
      clientInfo: { name: "test", version: "1" },
    });
    assert.equal(initialized.id, 1);
    assert.equal(repeated.id, 0);
    assert.equal(initialized.error, undefined);
    assert.equal(repeated.error, undefined);
    assert.deepEqual(repeated.result, initialized.result);

    const reordered = await client.request(2, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {
        sampling: {},
        roots: { listChanged: true },
      },
      clientInfo: { version: "1", name: "test" },
    });
    assert.equal(reordered.error, undefined);
    assert.deepEqual(reordered.result, initialized.result);

    client.writeRaw(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

    const pingPromise = client.expect(3, "batched ping");
    const listPromise = client.expect(4, "batched tools/list");
    client.writeRaw(
      `${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ping", params: {} })}\n` +
      `${JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list", params: {} })}\n`,
    );
    const [ping, listed] = await Promise.all([pingPromise, listPromise]);
    assert.deepEqual(ping.result, {});
    const tools = (listed.result as Record<string, unknown>).tools as Array<Record<string, unknown>>;
    assert.deepEqual(tools.map((tool) => tool.name), [
      "codex_threads",
      "codex_models",
      "codex_turn",
      "codex_observe",
      "codex_steer",
      "codex_respond",
      "codex_interrupt",
      "codex_checkpoint",
    ]);
    for (const tool of tools) {
      assert.equal(typeof tool.title, "string");
      assert.equal(typeof tool.description, "string");
      assert.equal((tool.inputSchema as Record<string, unknown>).type, "object");
      const annotations = tool.annotations as Record<string, unknown>;
      for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
        assert.equal(typeof annotations[hint], "boolean", `${String(tool.name)} ${hint}`);
      }
    }
    const modelsTool = tools.find((tool) => tool.name === "codex_models");
    assert.match(modelsTool?.description as string, /model\/list/);
    const modelProperties = (modelsTool?.inputSchema as Record<string, unknown>)
      .properties as Record<string, unknown>;
    assert.ok("cursor" in modelProperties);
    assert.ok("include_hidden" in modelProperties);
    const respondTool = tools.find((tool) => tool.name === "codex_respond");
    assert.equal(
      (respondTool?.annotations as Record<string, unknown>).idempotentHint,
      false,
    );
    const checkpointTool = tools.find((tool) => tool.name === "codex_checkpoint");
    assert.match(
      checkpointTool?.description as string,
      /Initialization is not tied to crossing a ChatGPT window or round/,
    );
    assert.match(checkpointTool?.description as string, /Do not use for one-shot work/);
    assert.match(
      checkpointTool?.description as string,
      /Before final acceptance of a checkpointed task, read it once/,
    );
  } finally {
    assert.equal(await client.close(), 0);
  }
});

test("MCP rejects materially different repeated initialize identities", async () => {
  const client = new TestClient();
  try {
    const first = await client.request(1, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    assert.equal(first.error, undefined);

    const mismatches: Array<[string, Record<string, unknown>]> = [
      ["protocolVersion", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      }],
      ["capabilities", {
        protocolVersion: "2025-03-26",
        capabilities: { sampling: {} },
        clientInfo: { name: "test", version: "1" },
      }],
      ["clientInfo", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "other", version: "1" },
      }],
    ];
    for (const [field, params] of mismatches) {
      const response = await client.request(field, "initialize", params);
      const error = response.error as Record<string, unknown>;
      assert.equal(error.code, -32602);
      assert.match(error.message as string, new RegExp(field));
    }
  } finally {
    assert.equal(await client.close(), 0);
  }
});

test("MCP rejects duplicate active typed request ids without disturbing distinct ids", async () => {
  const client = new TestClient();
  try {
    await initialize(client, 1);
    const numeric = client.expect(17, "first numeric tools/list");
    const string = client.expect("17", "distinct string tools/list");
    client.writeRaw(
      `${JSON.stringify({ jsonrpc: "2.0", id: 17, method: "tools/list", params: {} })}\n` +
      `${JSON.stringify({ jsonrpc: "2.0", id: 17, method: "tools/list", params: {} })}\n` +
      `${JSON.stringify({ jsonrpc: "2.0", id: "17", method: "tools/list", params: {} })}\n`,
    );
    const [first, distinct] = await Promise.all([numeric, string]);
    assert.equal(first.id, 17);
    assert.equal(distinct.id, "17");
    await new Promise<void>((resolve) => setImmediate(resolve));
    const duplicateErrors = client.takeUnclaimed();
    assert.equal(duplicateErrors.length, 1);
    assert.deepEqual(duplicateErrors[0]?.error, {
      code: -32600,
      message: "Duplicate request id is already active",
    });
    assert.equal(duplicateErrors[0]?.id, 17);
  } finally {
    assert.equal(await client.close(), 0);
  }
});

test("MCP duplicate active typed id preserves cancellation suppression and safe reuse", async () => {
  const runtime = new RuntimeStore();
  const threadId = "thread-duplicate-cancellation";
  const turnId = "turn-duplicate-cancellation";
  runtime.markTurnAccepted(threadId, turnId);
  const control = new ControlSurface({ runtime } as unknown as AppServerManager);
  const input = new PassThrough();
  const output = new PassThrough();
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process, "stdin");
  const stdoutDescriptor = Object.getOwnPropertyDescriptor(process, "stdout");
  const messages: Record<string, unknown>[] = [];
  const waiting: Array<{
    resolve: (message: Record<string, unknown>) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];
  let buffer = "";
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => {
    buffer += chunk;
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) {
        return;
      }
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (!line) {
        continue;
      }
      const message = JSON.parse(line) as Record<string, unknown>;
      const waiter = waiting.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      } else {
        messages.push(message);
      }
    }
  });
  const nextMessage = (): Promise<Record<string, unknown>> => {
    const message = messages.shift();
    if (message) {
      return Promise.resolve(message);
    }
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("timeout waiting for MCP response"));
      }, 2_000);
      timer.unref();
      waiting.push({ resolve, reject, timer });
    });
  };
  const send = (message: Record<string, unknown>): void => {
    input.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  };
  const tick = async (): Promise<void> => {
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  let server: McpStdioServer | undefined;

  Object.defineProperty(process, "stdin", { configurable: true, value: input });
  Object.defineProperty(process, "stdout", { configurable: true, value: output });
  try {
    server = new McpStdioServer(control, { onClose: () => undefined });
    server.start();
    send({
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "direct-test", version: "1" },
      },
    });
    assert.equal((await nextMessage()).error, undefined);

    const observe = {
      name: "codex_observe",
      arguments: { thread_id: threadId, cursor: 0, wait_ms: 1_000 },
    };
    send({ id: 17, method: "tools/call", params: observe });
    await new Promise<void>((resolve) => setTimeout(resolve, 25));

    // Keep the original request active while cancellation and the duplicate
    // arrive in the same input batch. The duplicate error must not consume
    // the cancellation marker that suppresses the original response.
    input.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: 17, reason: "deterministic duplicate lifecycle test" },
      })}\n` +
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 17,
        method: "tools/call",
        params: observe,
      })}\n`,
    );
    const duplicate = await nextMessage();
    assert.equal(duplicate.id, 17);
    assert.deepEqual(duplicate.error, {
      code: -32600,
      message: "Duplicate request id is already active",
    });

    send({ id: "17", method: "ping" });
    const distinct = await nextMessage();
    assert.equal(distinct.id, "17");
    assert.deepEqual(distinct.result, {});

    assert.equal(messages.length, 0);
    await new Promise<void>((resolve) => setTimeout(resolve, 1_100));
    assert.equal(messages.length, 0, "cancelled first request must not emit a late response");

    // The first request's finally cleanup must release only its own lifecycle;
    // the same typed id can be reused and its new waiter must still wake.
    send({ id: 17, method: "tools/call", params: observe });
    await tick();
    runtime.recordNotification("item/started", {
      threadId,
      turnId,
      item: { type: "commandExecution", id: "after-id-reuse" },
    });
    const replacement = await nextMessage();
    assert.equal(replacement.id, 17);
    assert.equal(replacement.error, undefined);
    const payload = structuredToolPayload(replacement);
    assert.deepEqual(
      (payload.events as Array<Record<string, unknown>>).map((event) => event.method),
      ["item/started"],
    );
  } finally {
    if (server) {
      await server.close();
    }
    input.destroy();
    output.destroy();
    if (stdinDescriptor) {
      Object.defineProperty(process, "stdin", stdinDescriptor);
    }
    if (stdoutDescriptor) {
      Object.defineProperty(process, "stdout", stdoutDescriptor);
    }
  }
});

test("checkpoint preserves immutable intent and bounded state across MCP process restart", async () => {
  const checkpointDirectory = mkdtempSync(join(tmpdir(), "local-codex-bridge-checkpoint-test-"));
  const environment = {
    ...process.env,
    [CHECKPOINT_DIRECTORY_ENV]: checkpointDirectory,
  };
  const threadId = randomUUID();
  let first: TestClient | undefined;
  let second: TestClient | undefined;

  try {
    first = new TestClient(environment);
    await initialize(first, 1);
    const missing = successfulToolPayload(await first.request(2, "tools/call", {
      name: "codex_checkpoint",
      arguments: { action: "read", thread_id: threadId },
    }));
    assert.deepEqual(missing, {
      source: "local_codex_bridge_checkpoint",
      found: false,
      thread_id: threadId,
      checkpoint: null,
    });
    assert.deepEqual(readdirSync(checkpointDirectory), []);

    const initialized = successfulToolPayload(await first.request(3, "tools/call", {
      name: "codex_checkpoint",
      arguments: {
        action: "update",
        thread_id: threadId,
        original_goal: "Deliver the narrow checkpoint capability.",
        original_constraints: "No database, task layer, monitoring, or production restart.",
        original_acceptance: "Immutable intent and bounded state survive a process restart.",
        current_understanding: "A second supervision round is required for focused validation.",
        current_decision: "Continue only with checkpoint tests.",
        acceptance_status: "Not accepted; persistence is not yet verified.",
        next_step: "Run the first update and restart the MCP process.",
      },
    }));
    assert.equal(initialized.operation, "initialized");
    const initialCheckpoint = initialized.checkpoint as Record<string, unknown>;
    assert.equal(initialCheckpoint.previous, null);

    const updated = successfulToolPayload(await first.request(4, "tools/call", {
      name: "codex_checkpoint",
      arguments: {
        action: "update",
        thread_id: threadId,
        effective_goal: "Deliver the same checkpoint with explicit restart evidence.",
        current_amendment: "The user allows only this experimental checkpoint feature.",
        current_understanding: "The file write succeeded; restart recovery remains unverified.",
        current_decision: "Restart the test MCP process before acceptance.",
        acceptance_status: "Not accepted; restart read is pending.",
        next_step: "Close this process and read from a fresh process.",
      },
    }));
    assert.equal(updated.operation, "updated");
    const updatedCheckpoint = updated.checkpoint as Record<string, unknown>;
    assert.equal(
      (updatedCheckpoint.previous as Record<string, unknown>).current_understanding,
      "A second supervision round is required for focused validation.",
    );
    assert.equal(
      (updatedCheckpoint.current as Record<string, unknown>).current_understanding,
      "The file write succeeded; restart recovery remains unverified.",
    );

    const rejected = await first.request(5, "tools/call", {
      name: "codex_checkpoint",
      arguments: {
        action: "update",
        thread_id: threadId,
        original_goal: "Silently replace the original goal.",
        current_decision: "This update must be rejected.",
      },
    });
    assert.equal((rejected.result as Record<string, unknown>).isError, true);
    assert.match(toolPayload(rejected).error as string, /original_goal is immutable/);

    const firstExitCode = await first.close();
    first = undefined;
    assert.equal(firstExitCode, 0);

    second = new TestClient(environment);
    await initialize(second, 1);
    const recovered = successfulToolPayload(await second.request(2, "tools/call", {
      name: "codex_checkpoint",
      arguments: { action: "read", thread_id: threadId },
    }));
    assert.equal(recovered.found, true);
    const recoveredCheckpoint = recovered.checkpoint as Record<string, unknown>;
    assert.equal(
      (recoveredCheckpoint.original as Record<string, unknown>).original_goal,
      "Deliver the narrow checkpoint capability.",
    );
    assert.equal(
      (recoveredCheckpoint.previous as Record<string, unknown>).current_understanding,
      "A second supervision round is required for focused validation.",
    );
    assert.equal(
      (recoveredCheckpoint.current as Record<string, unknown>).current_understanding,
      "The file write succeeded; restart recovery remains unverified.",
    );

    const rotated = successfulToolPayload(await second.request(3, "tools/call", {
      name: "codex_checkpoint",
      arguments: {
        action: "update",
        thread_id: threadId,
        current_amendment: null,
        current_understanding: "Restart recovery is verified.",
        current_decision: "The checkpoint behavior is ready for acceptance review.",
        acceptance_status: "Acceptance review may proceed.",
        next_step: "Read once before final acceptance.",
      },
    }));
    const rotatedCheckpoint = rotated.checkpoint as Record<string, unknown>;
    assert.equal(
      (rotatedCheckpoint.previous as Record<string, unknown>).current_understanding,
      "The file write succeeded; restart recovery remains unverified.",
    );
    assert.equal(
      (rotatedCheckpoint.current as Record<string, unknown>).current_understanding,
      "Restart recovery is verified.",
    );
    assert.equal(
      (rotatedCheckpoint.current as Record<string, unknown>).current_amendment,
      null,
    );
    assert.deepEqual(Object.keys(rotatedCheckpoint).sort(), [
      "created_at",
      "current",
      "original",
      "previous",
      "schema_version",
      "thread_id",
      "updated_at",
    ]);

    const storedFiles = readdirSync(checkpointDirectory);
    assert.equal(storedFiles.length, 1);
    assert.match(storedFiles[0] ?? "", /^[a-f0-9]{64}\.json$/);
    const stored = JSON.parse(
      readFileSync(join(checkpointDirectory, storedFiles[0]!), "utf8"),
    ) as Record<string, unknown>;
    assert.equal("history" in stored, false);
    assert.equal("events" in stored, false);
  } finally {
    if (first) {
      await first.close();
    }
    if (second) {
      await second.close();
    }
    rmSync(checkpointDirectory, { recursive: true, force: true });
  }
});

test("MCP reports protocol errors and domain tool errors without stdout noise", async () => {
  const client = new TestClient();
  try {
    await client.request(1, "initialize", {
      protocolVersion: "2099-01-01",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    const unknownMethod = await client.request(2, "missing/method");
    assert.deepEqual(unknownMethod, {
      jsonrpc: "2.0", id: 2, error: { code: -32601, message: "Method not found: missing/method" },
    });
    const unknownTool = await client.request(3, "tools/call", { name: "not_a_tool", arguments: {} });
    assert.deepEqual(unknownTool, {
      jsonrpc: "2.0", id: 3, error: { code: -32602, message: "Unknown tool" },
    });
    const invalidArguments = await client.request(5, "tools/call", { name: "codex_models", arguments: [] });
    assert.deepEqual(invalidArguments, {
      jsonrpc: "2.0", id: 5, error: { code: -32602, message: "Tool arguments must be an object" },
    });
    const invalidTool = await client.request(4, "tools/call", {
      name: "codex_observe",
      arguments: {},
    });
    assert.equal(invalidTool.error, undefined);
    assert.deepEqual(invalidTool.result, {
      content: [{ type: "text", text: JSON.stringify({ error: "thread_id must be a non-empty string" }) }],
      isError: true,
    });
  } finally {
    assert.equal(await client.close(), 0);
  }
});
