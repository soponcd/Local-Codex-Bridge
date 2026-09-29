import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import * as fs from "node:fs";
import { resolve } from "node:path";
import { AppServerManager } from "../src/app-server.js";
import { ControlSurface } from "../src/tools.js";

import { RuntimeStore } from "../src/runtime.js";
import {
  AtomicUxProjection,
  createUxProjectionFromEnvironment,
  LEGACY_UX_PROJECTION_ENV,
  UX_PROJECTION_ENV,
  type UxProjectionDocument,
  type UxProjectionIO,
} from "../src/ux-projection.js";

const testRoot = join(process.cwd(), "_test_tmp", "ux-projection");

function readProjection(path: string): UxProjectionDocument {
  return JSON.parse(readFileSync(path, "utf8")) as UxProjectionDocument;
}

test.beforeEach(() => {
  rmSync(testRoot, { recursive: true, force: true });
  mkdirSync(testRoot, { recursive: true });
});

test.after(() => rmSync(join(process.cwd(), "_test_tmp"), { recursive: true, force: true }));

test("projection resolves canonical and legacy environment aliases deterministically", () => {
  const canonicalPath = join(testRoot, "canonical.json");
  const legacyPath = join(testRoot, "legacy.json");
  const canonical = createUxProjectionFromEnvironment({ [UX_PROJECTION_ENV]: canonicalPath });
  assert.ok(canonical instanceof AtomicUxProjection);
  assert.equal((canonical as AtomicUxProjection).filePath, canonicalPath);
  canonical?.close();

  const legacy = createUxProjectionFromEnvironment({ [LEGACY_UX_PROJECTION_ENV]: legacyPath });
  assert.ok(legacy instanceof AtomicUxProjection);
  assert.equal((legacy as AtomicUxProjection).filePath, legacyPath);
  legacy?.close();

  const canonicalWins = createUxProjectionFromEnvironment({
    [UX_PROJECTION_ENV]: canonicalPath,
    [LEGACY_UX_PROJECTION_ENV]: legacyPath,
  });
  assert.ok(canonicalWins instanceof AtomicUxProjection);
  assert.equal((canonicalWins as AtomicUxProjection).filePath, canonicalPath);
  canonicalWins?.close();
});

test("projection is opt-in, atomic-shaped, bounded, monotonic, and content-free", () => {
  assert.equal(createUxProjectionFromEnvironment({}), undefined);
  const path = join(testRoot, "projection.json");
  const projection = new AtomicUxProjection(path, 2);
  const runtime = new RuntimeStore(8, projection);

  runtime.markTurnAccepted("thread-secret", "turn-1");
  runtime.recordServerRequest("approval-1", "item/commandExecution/requestApproval", {
    threadId: "thread-secret",
    turnId: "turn-1",
    command: "DO_NOT_PROJECT_COMMAND",
    prompt: "DO_NOT_PROJECT_PROMPT",
  });
  runtime.recordServerRequest("approval-1", "item/commandExecution/requestApproval", {
    threadId: "thread-secret",
    turnId: "turn-1",
  });
  runtime.recordServerRequest("input-1", "item/tool/requestUserInput", {
    threadId: "thread-secret",
    turnId: "turn-1",
    questions: ["DO_NOT_PROJECT_QUESTION"],
  });
  runtime.recordNotification("turn/completed", {
    threadId: "thread-secret",
    turn: {
      id: "turn-1",
      status: "completed",
      items: [{ type: "agentMessage", text: "DO_NOT_PROJECT_RESULT" }],
    },
  });

  const raw = readFileSync(path, "utf8");
  const document = readProjection(path);
  assert.equal(document.sequence, 3);
  assert.deepEqual(document.signals.map((signal) => signal.sequence), [2, 3]);
  assert.deepEqual(document.signals.map((signal) => signal.kind), ["waiting_user_input", "terminal"]);
  assert.deepEqual(document.counts, { active: 0, waiting: 0, terminal: 1 });
  assert.doesNotMatch(raw, /DO_NOT_PROJECT/);
  assert.deepEqual(Object.keys(document).sort(), ["counts", "generation", "schema_version", "sequence", "signals"]);
  assert.equal(document.generation.pid, process.pid);
  assert.match(document.generation.id, /^[0-9a-f-]{36}$/);
  projection.close();
  assert.throws(() => readFileSync(path));
});

test("atomic projection faults remain optional and the next natural snapshot recovers", (t) => {
  const diagnostics: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => diagnostics.push(args));
  for (const operation of ["mkdirSync", "writeFileSync", "renameSync", "rmSync"] as const) {
    let fail = true;
    const io: UxProjectionIO = { ...fs, [operation]: (...args: any[]) => {
      if (fail) { fail = false; throw new Error("synthetic password=do-not-log"); }
      return (fs[operation] as (...args: any[]) => unknown)(...args);
    } };
    const path = join(testRoot, operation + ".json");
    const runtime = new RuntimeStore(8, new AtomicUxProjection(path, 32, io));
    runtime.markTurnAccepted("t", "u");
    assert.equal(runtime.observe("t", 0, 50)!.active_turn_id, "u");
    assert.equal(readProjection(path).counts.active, 1);
    // A failed signal write remains in the sink's bounded signal ring.
    fail = true;
    runtime.recordServerRequest(1, "item/tool/requestUserInput", { threadId: "t", turnId: "u" });
    assert.equal(runtime.pendingForThread("t").length, 1);
    const request = runtime.claimPending(1, { threadId: "t", turnId: "u", method: "item/tool/requestUserInput" });
    runtime.completePending(request);
    assert.equal(runtime.pendingForThread("t").length, 0);
    assert.equal(readProjection(path).counts.waiting, 0);
    assert.equal(readProjection(path).signals.at(-1)!.kind, "waiting_user_input");
    fail = true;
    assert.doesNotThrow(() => runtime.closeUxProjection());
    fail = false; runtime.closeUxProjection();
  }
  // Cleanup-only failures are best-effort, the other three report once each.
  assert.ok(diagnostics.length >= 3 && diagnostics.length <= 4);
  assert.doesNotMatch(JSON.stringify(diagnostics), /do-not-log/);
});

test("projection failures cannot poison accepted turn, respond, or JSONL dispatch", async (t) => {
  const diagnostics: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => diagnostics.push(args));
  let fail = false;
  const io: UxProjectionIO = { ...fs, renameSync(...args) {
    if (fail) { fail = false; throw new Error("synthetic rename EPERM"); }
    fs.renameSync(...args);
  } };
  const runtime = new RuntimeStore(256, new AtomicUxProjection(join(testRoot, "integration.json"), 32, io));
  const manager = new AppServerManager(runtime, { executable: process.execPath, prefixArgs: [resolve("test/fake-codex.mjs")] });
  const surface = new ControlSurface(manager);
  try {
    fail = true;
    const accepted = await surface.call("codex_turn", { cwd: process.cwd(), text: "fixture" }) as any;
    assert.equal(accepted.accepted, true);
    fail = true; // Fail on the next notification-driven publish too.
    let snapshot = runtime.observe(accepted.thread_id, 0, 50)!;
    for (let i = 0; i < 4 && !snapshot.pending_requests.length; i++) {
      await runtime.observeWithWait(accepted.thread_id, snapshot.next_cursor, 50, 1000);
      snapshot = runtime.observe(accepted.thread_id, snapshot.next_cursor, 50)!;
    }
    assert.equal(snapshot.pending_requests.length, 1);
    assert.notEqual(snapshot.runtime_status, "appServerExited");
    fail = true;
    const responded = await surface.call("codex_respond", { thread_id: accepted.thread_id, turn_id: accepted.turn_id,
      request_id: "approval-1", method: "item/commandExecution/requestApproval", decision: "accept" }) as any;
    assert.equal(responded.responded, true);
    assert.equal(runtime.pendingForThread(accepted.thread_id).length, 0);
    for (let i = 0; i < 5 && snapshot.terminal === null; i++) {
      await runtime.observeWithWait(accepted.thread_id, snapshot.next_cursor, 50, 1000);
      snapshot = runtime.observe(accepted.thread_id, snapshot.next_cursor, 50)!;
    }
    assert.equal(snapshot.terminal!.status, "completed");
    assert.equal(readProjection(join(testRoot, "integration.json")).counts.terminal, 1);
    assert.equal(diagnostics.length, 1);
  } finally { await manager.close(); runtime.closeUxProjection(); }
});
