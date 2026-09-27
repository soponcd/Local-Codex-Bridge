import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import { AppServerManager } from "../src/app-server.js";
import { CheckpointStore } from "../src/checkpoint.js";
import { McpStdioServer } from "../src/mcp.js";
import { WINDOWS_PLATFORM_POLICY } from "../src/platform.js";
import { RuntimeStore } from "../src/runtime.js";
import { ControlSurface, TOOL_DEFINITIONS } from "../src/tools.js";

class MetadataNativeStub extends AppServerManager {
  readonly requests: Array<{ method: string; params: unknown }> = [];
  constructor(private readonly handle: (method: string, params: unknown) => unknown) {
    super(new RuntimeStore(), { executable: "unused-lineage-fixture" });
  }
  override async request(method: string, params: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    return this.handle(method, params);
  }
}

const nativeThread = (capability: boolean | null | undefined) => ({
  id: "child", sessionId: "native-session", forkedFromId: "fork-origin", parentThreadId: "parent",
  source: { subAgent: { thread_spawn: { parent_thread_id: "parent", depth: 2, agent_path: "/root/child", agent_nickname: null, agent_role: "worker" } } },
  originator: "native-originator", threadSource: "native-analytics-source", agentNickname: null, agentRole: "worker",
  ...(capability === undefined ? {} : { canAcceptDirectInput: capability }),
  status: { type: "notLoaded" }, futureField: { preserved: true }, turns: [],
});

test("thread metadata retains native capability true/false/null/absence and distinct lineage facts", async () => {
  for (const capability of [true, false, null, undefined]) {
    const thread = nativeThread(capability);
    const manager = new MetadataNativeStub(method => method === "thread/list"
      ? { data: [thread], nextCursor: "native-next", backwardsCursor: "native-back" }
      : { thread });
    const checkpoints = new Proxy({} as CheckpointStore, { get() { throw new Error("metadata must not touch checkpoints"); } });
    const surface = new ControlSurface(manager, checkpoints, WINDOWS_PLATFORM_POLICY);
    const read = await surface.call("codex_threads", { thread_id: "child" }) as { thread: unknown };
    assert.deepEqual(read.thread, thread);
    const page = await surface.call("codex_threads", {}) as { data: unknown[]; nextCursor: string; backwardsCursor: string };
    assert.deepEqual(page.data, [thread]);
    assert.equal(page.nextCursor, "native-next");
    assert.equal(page.backwardsCursor, "native-back");
    for (const view of ["compact", "raw"]) {
      const fallback = await surface.call("codex_observe", { thread_id: "child", view, wait_ms: 0 }) as { stored_thread: unknown; runtime_available: boolean };
      assert.equal(fallback.runtime_available, false);
      assert.deepEqual(fallback.stored_thread, thread);
    }
    assert.equal(manager.runtime.observe("child", 0, 50), null);
    assert.deepEqual(manager.requests.map(request => request.method), ["thread/read", "thread/list", "thread/read", "thread/read"]);
    assert.deepEqual(manager.requests[0]?.params, { threadId: "child", includeTurns: false });
  }
});

test("lineage list mapping preserves filter omissions, nulls, empty source arrays, order and duplicates", async () => {
  const cases = [
    { args: {}, expected: {} },
    { args: { parent_thread_id: "parent", source_kinds: ["subAgentThreadSpawn"] }, expected: { parentThreadId: "parent", sourceKinds: ["subAgentThreadSpawn"] } },
    { args: { ancestor_thread_id: "ancestor", source_kinds: ["subAgent", "cli", "subAgent"] }, expected: { ancestorThreadId: "ancestor", sourceKinds: ["subAgent", "cli", "subAgent"] } },
    { args: { parent_thread_id: null, ancestor_thread_id: null, source_kinds: null }, expected: { parentThreadId: null, ancestorThreadId: null, sourceKinds: null } },
    { args: { parent_thread_id: "parent", ancestor_thread_id: null, source_kinds: [] }, expected: { parentThreadId: "parent", ancestorThreadId: null, sourceKinds: [] } },
    { args: { parent_thread_id: null, ancestor_thread_id: "ancestor" }, expected: { parentThreadId: null, ancestorThreadId: "ancestor" } },
    { args: { parent_thread_id: " parent " }, expected: { parentThreadId: " parent " } },
  ];
  for (const { args, expected } of cases) {
    const manager = new MetadataNativeStub(() => ({ data: [], nextCursor: "native-empty-page-next" }));
    const page = await new ControlSurface(manager, undefined, WINDOWS_PLATFORM_POLICY).call("codex_threads", {
      cwd: "D:\\work", search_term: "title", cursor: "opaque-native-cursor", limit: 2, ...args,
    }) as { nextCursor: string };
    assert.deepEqual(manager.requests, [{ method: "thread/list", params: {
      limit: 2, sortKey: "updated_at", sortDirection: "desc", cwd: "D:\\work", searchTerm: "title", cursor: "opaque-native-cursor", ...expected,
    } }]);
    assert.equal(page.nextCursor, "native-empty-page-next");
  }
});

test("invalid lineage combinations fail before native and read mode rejects list-only fields", async () => {
  const invalid = [
    { parent_thread_id: "parent", ancestor_thread_id: "ancestor" },
    ...["parent_thread_id", "ancestor_thread_id"].flatMap(key => ["", " ", "x".repeat(201), 1, [], {}].map(value => ({ [key]: value }))),
    ...["subAgent", ["all"], [null], [4], true, {}, Array(101).fill("cli")].map(source_kinds => ({ source_kinds })),
    ...["parent_thread_id", "ancestor_thread_id", "source_kinds"].map(key => ({ thread_id: "thread", [key]: null })),
    { parent_thread_id: "parent", include_turns: false },
    { ancestor_thread_id: "ancestor", recursive: true },
  ];
  for (const args of invalid) {
    const manager = new MetadataNativeStub(() => { throw new Error("unexpected native request"); });
    await assert.rejects(new ControlSurface(manager).call("codex_threads", args));
    assert.equal(manager.requests.length, 0);
  }
});

test("source kinds match installed native vocabulary without remapping or implicit defaults", async () => {
  const kinds = ["cli", "vscode", "exec", "appServer", "subAgent", "subAgentReview", "subAgentCompact", "subAgentThreadSpawn", "subAgentOther", "unknown"];
  const manager = new MetadataNativeStub(() => ({ data: [], nextCursor: null }));
  await new ControlSurface(manager).call("codex_threads", { source_kinds: kinds });
  assert.deepEqual((manager.requests[0]?.params as { sourceKinds: unknown }).sourceKinds, kinds);
  const tool = TOOL_DEFINITIONS.find(candidate => candidate.name === "codex_threads")!;
  const properties = tool.inputSchema.properties as Record<string, Record<string, unknown>>;
  assert.deepEqual((properties.source_kinds!.items as { enum: unknown }).enum, kinds);
  assert.equal(TOOL_DEFINITIONS.length, 12);
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(properties.parent_thread_id!.maxLength, 200);
  assert.equal(properties.ancestor_thread_id!.maxLength, 200);
});

test("native filter errors propagate once without walking descendants, retry or fallback", async () => {
  const error = new Error("native experimental lineage unsupported");
  const manager = new MetadataNativeStub(() => { throw error; });
  await assert.rejects(new ControlSurface(manager).call("codex_threads", { ancestor_thread_id: "ancestor", source_kinds: ["subAgent"] }), value => value === error);
  assert.equal(manager.requests.length, 1);
});

test("native capability metadata does not become a Bridge turn permission gate", async () => {
  for (const capability of [true, false, null, undefined]) {
    const nativeError = new Error("native turn input decision");
    const manager = new MetadataNativeStub(method => {
      if (method === "thread/resume") return { thread: nativeThread(capability) };
      if (method === "turn/start") throw nativeError;
      throw new Error(`unexpected ${method}`);
    });
    await assert.rejects(new ControlSurface(manager).call("codex_turn", { thread_id: "child", text: "continue" }), error => error === nativeError);
    assert.deepEqual(manager.requests.map(request => request.method), ["thread/resume", "turn/start"]);
  }
});

test("MCP structured result carries filtered lineage metadata and native capability null", { timeout: 3_000 }, async () => {
  const thread = nativeThread(null);
  const manager = new MetadataNativeStub(() => ({ data: [thread], nextCursor: null, backwardsCursor: null }));
  const input = new PassThrough();
  const output = new PassThrough();
  const server = new McpStdioServer(new ControlSurface(manager), { onClose: () => undefined });
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process, "stdin")!;
  const stdoutDescriptor = Object.getOwnPropertyDescriptor(process, "stdout")!;
  let buffer = "";
  const pending = new Map<number, (message: Record<string, unknown>) => void>();
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const boundary = buffer.indexOf("\n");
      const response = JSON.parse(buffer.slice(0, boundary)) as Record<string, unknown>;
      buffer = buffer.slice(boundary + 1);
      const resolve = pending.get(response.id as number);
      if (resolve) { pending.delete(response.id as number); resolve(response); }
    }
  });
  const request = (id: number, method: string, params: unknown) => new Promise<Record<string, unknown>>(resolve => {
    pending.set(id, resolve);
    input.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  Object.defineProperty(process, "stdin", { configurable: true, value: input });
  Object.defineProperty(process, "stdout", { configurable: true, value: output });
  try {
    server.start();
    await request(1, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "lineage-test", version: "1" } });
    input.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const result = (await request(2, "tools/call", { name: "codex_threads", arguments: { ancestor_thread_id: "ancestor", source_kinds: ["subAgent"] } })).result as Record<string, unknown>;
    assert.deepEqual(result.content, [{ type: "text", text: "structured result" }]);
    assert.deepEqual(result.structuredContent, { source: "codex_app_server", mode: "list", data: [thread], nextCursor: null, backwardsCursor: null });
    assert.deepEqual(manager.requests, [{ method: "thread/list", params: { limit: 20, sortKey: "updated_at", sortDirection: "desc", ancestorThreadId: "ancestor", sourceKinds: ["subAgent"] } }]);
  } finally {
    await server.close();
    Object.defineProperty(process, "stdin", stdinDescriptor);
    Object.defineProperty(process, "stdout", stdoutDescriptor);
    input.destroy(); output.destroy();
  }
});
