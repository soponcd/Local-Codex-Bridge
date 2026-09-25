import assert from "node:assert/strict";
import test from "node:test";

import { AppServerManager } from "../src/app-server.js";
import {
  exactHistoryResponse,
  historyMcpBytes,
  HISTORY_MCP_WRAPPER_ALLOWANCE_BYTES,
  MAX_HISTORY_MCP_BYTES,
} from "../src/history.js";
import { RuntimeStore } from "../src/runtime.js";
import { ControlSurface, TOOL_DEFINITIONS } from "../src/tools.js";

interface Request { method: string; params: Record<string, unknown> }

class StubAppServer extends AppServerManager {
  readonly calls: Request[] = [];
  constructor(readonly handler: (method: string, params: Record<string, unknown>) => unknown,
              runtime = new RuntimeStore()) {
    super(runtime, { executable: "unused-test-codex" });
  }
  override async request(method: string, params: unknown): Promise<unknown> {
    const request = { method, params: params as Record<string, unknown> };
    this.calls.push(request);
    return this.handler(method, request.params);
  }
}

const page = (data: unknown[] = [], nextCursor: string | null = null,
              backwardsCursor: string | null = null) => ({ data, nextCursor, backwardsCursor });
const callHistory = (surface: ControlSurface, history: Record<string, unknown>) =>
  surface.call("codex_threads", { thread_id: "thread-1", history });

test("history schema and pre-RPC parameter matrix match the two native page modes", async () => {
  const schema = TOOL_DEFINITIONS.find((tool) => tool.name === "codex_threads")?.inputSchema;
  assert.ok(schema?.oneOf);
  const historySchema = (schema.properties as Record<string, unknown>).history as Record<string, unknown>;
  const branches = historySchema.oneOf as Array<Record<string, unknown>>;
  assert.equal(branches.length, 2);
  assert.deepEqual(branches.map((branch) => branch.required), [["kind"], ["kind", "turn_id"]]);
  assert.deepEqual(branches.map((branch) => branch.additionalProperties), [false, false]);

  const manager = new StubAppServer(() => { throw new Error("native call forbidden"); });
  const surface = new ControlSurface(manager);
  const invalid = [
    { history: { kind: "turns" } },
    { thread_id: "thread-1", history: { kind: "turns" }, include_turns: false },
    { thread_id: "thread-1", history: { kind: "items" }, include_turns: true },
    { thread_id: "thread-1", include_turns: true },
    { include_turns: false },
    { thread_id: "thread-1", cwd: "D:\\work" },
    { thread_id: "thread-1", history: { kind: "turns" }, cursor: "list-cursor" },
    { thread_id: "thread-1", history: { kind: "turns" }, limit: 1 },
    { thread_id: "thread-1", history: null },
    { thread_id: "thread-1", history: [] },
    { thread_id: "thread-1", history: { kind: "unknown" } },
    { thread_id: "thread-1", history: { kind: "turns", turn_id: "turn-1" } },
    { thread_id: "thread-1", history: { kind: "items" } },
    { thread_id: "thread-1", history: { kind: "items", turn_id: "" } },
    { thread_id: "thread-1", history: { kind: "items", turn_id: null } },
    { thread_id: "thread-1", history: { kind: "turns", cursor: null } },
    { thread_id: "thread-1", history: { kind: "turns", cursor: "" } },
    { thread_id: "thread-1", history: { kind: "turns", sort_direction: null } },
    { thread_id: "thread-1", history: { kind: "turns", sort_direction: "sideways" } },
    { thread_id: "thread-1", history: { kind: "turns", limit: 0 } },
    { thread_id: "thread-1", history: { kind: "turns", limit: 51 } },
    { thread_id: "thread-1", history: { kind: "turns", limit: 1.5 } },
    { thread_id: "thread-1", history: { kind: "items", turn_id: "turn-1", limit: 21 } },
    { thread_id: "thread-1", history: { kind: "items", turn_id: "turn-1", extra: true } },
  ];
  for (const args of invalid) {
    await assert.rejects(surface.call("codex_threads", args), /./, JSON.stringify(args));
    assert.equal(manager.calls.length, 0, JSON.stringify(args));
  }
  await assert.rejects(surface.call("codex_threads", { thread_id: "thread-1", include_turns: true }),
    /include_turns:true.*history/);
  assert.equal(manager.calls.length, 0);
});

test("metadata/list remain distinct and native history pages preserve cursors, order and empty/end", async () => {
  const manager = new StubAppServer((method, params) => {
    if (method === "thread/read") return { thread: { id: params.threadId, turns: [] } };
    if (method === "thread/list") return page([{ id: "thread-1" }], "list-next");
    if (method === "thread/turns/list") {
      if (params.cursor === "reverse") return page([{ id: "turn-2", items: [] }], null);
      if (params.cursor === "turn-next") return page([], "turn-next-2", "reverse");
      return page([{ id: "turn-2", items: [] }, { id: "turn-1", items: [] }], "turn-next", "reverse");
    }
    if (method === "thread/items/list") {
      if (params.cursor === "item-next") return page([{ turnId: "turn-2", item: { id: "i2", type: "agentMessage", text: "二 🌱" } }], null, "item-back");
      return page([{ turnId: "turn-2", item: { id: "i1", type: "agentMessage", text: "one" } }], "item-next");
    }
    throw new Error("unexpected native method");
  });
  const surface = new ControlSurface(manager);
  assert.deepEqual(await surface.call("codex_threads", { thread_id: "thread-1", include_turns: false }),
    { source: "codex_app_server", mode: "read", thread: { id: "thread-1", turns: [] } });
  assert.deepEqual(manager.calls.at(-1), { method: "thread/read", params: { threadId: "thread-1", includeTurns: false } });
  assert.equal((await surface.call("codex_threads", { cwd: "D:\\work", search_term: "x", cursor: "list-cursor", limit: 2 }) as Record<string, unknown>).nextCursor, "list-next");
  assert.deepEqual(manager.calls.at(-1), { method: "thread/list", params: { limit: 2, sortKey: "updated_at", sortDirection: "desc", cwd: "D:\\work", searchTerm: "x", cursor: "list-cursor" } });

  const first = await callHistory(surface, { kind: "turns" }) as Record<string, unknown>;
  assert.deepEqual(manager.calls.at(-1), { method: "thread/turns/list", params: { threadId: "thread-1", limit: 20, sortDirection: "desc", itemsView: "notLoaded" } });
  assert.deepEqual(first, { source: "codex_app_server", mode: "history", coverage: "native_persisted_history", kind: "turns", thread_id: "thread-1", data: [{ id: "turn-2", items: [] }, { id: "turn-1", items: [] }], nextCursor: "turn-next", backwardsCursor: "reverse" });
  const empty = await callHistory(surface, { kind: "turns", cursor: "turn-next", limit: 50 });
  assert.deepEqual((empty as Record<string, unknown>).data, []);
  assert.equal((empty as Record<string, unknown>).nextCursor, "turn-next-2");
  const reverse = await callHistory(surface, { kind: "turns", cursor: "reverse", sort_direction: "asc" }) as Record<string, unknown>;
  assert.deepEqual(reverse.data, [{ id: "turn-2", items: [] }]);
  assert.equal(reverse.nextCursor, null);
  assert.deepEqual(manager.calls.at(-1)?.params, { threadId: "thread-1", cursor: "reverse", limit: 20, sortDirection: "asc", itemsView: "notLoaded" });

  const item1 = await callHistory(surface, { kind: "items", turn_id: "turn-2" }) as Record<string, unknown>;
  assert.deepEqual(manager.calls.at(-1), { method: "thread/items/list", params: { threadId: "thread-1", turnId: "turn-2", limit: 10, sortDirection: "asc" } });
  assert.equal(item1.nextCursor, "item-next");
  const item2 = await callHistory(surface, { kind: "items", turn_id: "turn-2", cursor: "item-next", limit: 20 }) as Record<string, unknown>;
  assert.deepEqual(item2.data, [{ turnId: "turn-2", item: { id: "i2", type: "agentMessage", text: "二 🌱" } }]);
  assert.equal(item2.nextCursor, null);
  assert.equal(item2.backwardsCursor, "item-back");
  assert.deepEqual(manager.calls.at(-1)?.params, { threadId: "thread-1", turnId: "turn-2", cursor: "item-next", limit: 20, sortDirection: "asc" });
  await callHistory(surface, { kind: "items", turn_id: "turn-2", cursor: "item-back", sort_direction: "desc" });
  assert.equal(manager.calls.at(-1)?.params.sortDirection, "desc");
  assert.equal(manager.runtime.hasThread("thread-1"), false);
});

test("invalid upstream pages and upstream cursor errors never fall back to full read", async () => {
  const malformed = [null, {}, { data: null, nextCursor: null, backwardsCursor: null },
    { data: [], nextCursor: undefined, backwardsCursor: null },
    { data: [], nextCursor: null, backwardsCursor: undefined },
    { data: [], nextCursor: 4, backwardsCursor: null },
    { data: [], nextCursor: "", backwardsCursor: null },
    page([1, 2]), page([{}])];
  for (const value of malformed) {
    const manager = new StubAppServer(() => value);
    await assert.rejects(callHistory(new ControlSurface(manager), { kind: "turns", limit: 1 }), /^Error: history_upstream_invalid:/);
    assert.deepEqual(manager.calls.map((call) => call.method), ["thread/turns/list"]);
  }
  const invalidItem = new StubAppServer(() => page([{ turnId: "turn-1" }]));
  await assert.rejects(callHistory(new ControlSurface(invalidItem), { kind: "items", turn_id: "turn-1" }), /^Error: history_upstream_invalid:/);
  assert.deepEqual(invalidItem.calls.map((call) => call.method), ["thread/items/list"]);
  const manager = new StubAppServer(() => { throw new Error("native invalid cursor"); });
  await assert.rejects(callHistory(new ControlSurface(manager), { kind: "items", turn_id: "turn-1", cursor: "stale" }), /native invalid cursor/);
  assert.deepEqual(manager.calls.map((call) => call.method), ["thread/items/list"]);
});

test("history exactness rejects sanitizer mutation, including redaction, without partial pages", async () => {
  const values = [
    { api_key: "secret" },
    { text: "Bearer abcdefghijklmnop" },
    { text: "x".repeat(12_001) },
    { nested: { a: { b: { c: { d: { e: { f: { g: { h: "deep" } } } } } } } } },
    { many: Array.from({ length: 51 }, (_, i) => i) },
    { many: Object.fromEntries(Array.from({ length: 61 }, (_, i) => [`field${i}`, i])) },
    { many: Array.from({ length: 30 }, () => "x".repeat(6_000)) },
  ];
  for (const item of values) {
    const manager = new StubAppServer(() => page([{ turnId: "turn-1", item }]));
    await assert.rejects(callHistory(new ControlSurface(manager), { kind: "items", turn_id: "turn-1" }), /^Error: history_page_not_lossless:/);
    assert.deepEqual(manager.calls.map((call) => call.method), ["thread/items/list"]);
  }
  assert.equal(HISTORY_MCP_WRAPPER_ALLOWANCE_BYTES, 1024);
  assert.equal(MAX_HISTORY_MCP_BYTES, 256 * 1024);
  const unicode = { source: "codex_app_server", mode: "history", data: ["🌱\n\"\\中"] };
  assert.deepEqual(exactHistoryResponse(unicode), unicode);
  const long = "中\n\"\\".repeat(60_000);
  assert.throws(() => exactHistoryResponse({ data: [long] }), /^Error: history_page_too_large:/);
});

test("MCP UTF-8 and JSON escaping byte boundary is measured after both serialization layers", () => {
  for (const character of ["\n", "中"]) {
    const candidate = (count: number) => ({ data: Array.from({ length: 10 }, () => ({ text: character.repeat(count) })) });
    let low = 0;
    let high = 12_000;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (historyMcpBytes(candidate(middle), "") + HISTORY_MCP_WRAPPER_ALLOWANCE_BYTES <= MAX_HISTORY_MCP_BYTES) low = middle;
      else high = middle - 1;
    }
    assert.ok(low > 0 && low < 12_000);
    assert.deepEqual(exactHistoryResponse(candidate(low)), candidate(low));
    assert.throws(() => exactHistoryResponse(candidate(low + 1)), /^Error: history_page_too_large:/);
    assert.ok(historyMcpBytes(candidate(low), "x".repeat(2_000)) > MAX_HISTORY_MCP_BYTES);
  }
});

test("received oversized pages can retry the same cursor with a smaller limit", async () => {
  const manager = new StubAppServer((_method, params) => page(params.limit === 2
    ? [{ id: "turn-2", text: "中\n\"\\".repeat(60_000) }]
    : [{ id: "turn-2", text: "short" }], "same-next"));
  const surface = new ControlSurface(manager);
  await assert.rejects(callHistory(surface, { kind: "turns", cursor: "same-cursor", limit: 2 }), /^Error: history_page_too_large:/);
  const retry = await callHistory(surface, { kind: "turns", cursor: "same-cursor", limit: 1 }) as Record<string, unknown>;
  assert.equal(retry.nextCursor, "same-next");
  assert.deepEqual(manager.calls.map((call) => call.params.cursor), ["same-cursor", "same-cursor"]);
  assert.deepEqual(manager.calls.map((call) => call.method), ["thread/turns/list", "thread/turns/list"]);
});

test("runtime-missing observe returns metadata placeholders in compact/raw/wait and never builds runtime", async () => {
  const manager = new StubAppServer((method, params) => {
    assert.equal(method, "thread/read");
    assert.equal(params.includeTurns, false);
    return { thread: { id: "thread-1", historyMode: "paginated", turns: [{ id: "should-not-leak", items: [{ text: "secret-final" }] }] } };
  });
  const surface = new ControlSurface(manager);
  for (const args of [{}, { view: "raw" }, { wait_ms: 10 }, { view: "raw", wait_ms: 10 }]) {
    const observed = await surface.call("codex_observe", { thread_id: "thread-1", ...args }) as Record<string, unknown>;
    assert.equal(observed.runtime_available, false);
    assert.equal(observed.terminal, null);
    assert.equal(observed.active_turn_id, null);
    assert.deepEqual((observed.stored_thread as Record<string, unknown>).turns, []);
    assert.equal(observed.source, "codex_app_server_thread_read_metadata");
    assert.match(observed.note as string, /unknown.*codex_threads\.history/);
    assert.equal("history_cursor" in observed, false);
    assert.equal(manager.runtime.hasThread("thread-1"), false);
  }
  assert.deepEqual(manager.calls.map((call) => call.method), Array(4).fill("thread/read"));

  manager.runtime.markTurnAccepted("thread-1", "turn-live");
  for (let i = 0; i < 300; i += 1) manager.runtime.recordNotification("item/started", { threadId: "thread-1", turnId: "turn-live", item: { id: `item-${i}` } });
  const before = manager.calls.length;
  const observed = await surface.call("codex_observe", { thread_id: "thread-1", cursor: 0, view: "raw" }) as Record<string, unknown>;
  assert.equal(observed.cursor_lost, true);
  assert.equal(manager.calls.length, before);
});

test("cancelled runtime-missing observe does not publish a fabricated fallback", async () => {
  let release: ((value: unknown) => void) | undefined;
  const manager = new StubAppServer(() => new Promise<unknown>((resolve) => { release = resolve; }));
  const controller = new AbortController();
  const waiting = new ControlSurface(manager).call("codex_observe", {
    thread_id: "thread-1", wait_ms: 10,
  }, controller.signal);
  for (let attempt = 0; !release && attempt < 10; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.ok(release);
  controller.abort();
  release({ thread: { id: "thread-1", turns: [] } });
  await assert.rejects(waiting, /MCP request cancelled/);
  assert.deepEqual(manager.calls.map((call) => call.method), ["thread/read"]);
  assert.equal(manager.runtime.hasThread("thread-1"), false);
});
