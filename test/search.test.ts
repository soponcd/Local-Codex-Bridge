import assert from "node:assert/strict";
import test from "node:test";
import { AppServerManager } from "../src/app-server.js";
import { CheckpointStore } from "../src/checkpoint.js";
import { RuntimeStore } from "../src/runtime.js";
import { ControlSurface, TOOL_DEFINITIONS } from "../src/tools.js";

class SearchNativeStub extends AppServerManager {
  readonly requests: Array<{ method: string; params: unknown }> = [];
  constructor(private readonly handle: (method: string, params: unknown) => unknown) {
    super(new RuntimeStore(), { executable: "unused-search-fixture" });
  }
  override async request(method: string, params: unknown): Promise<unknown> {
    this.requests.push({ method, params }); return this.handle(method, params);
  }
}
const occurrence = (extra = {}) => ({ turnId: "turn", itemId: "item", snippet: "🌱 Hit hit", snippetMatchRange: { start: 3, end: 6 }, turnCursor: "native-inclusive-turn", ...extra });
const threadResult = { thread: { id: "thread", canAcceptDirectInput: null, turns: [], future: { native: true } }, snippet: "native snippet" };
const query = "  Hit 🌱  ";

test("search maps one native read with exact queries, filters and no hydration or Bridge state", async () => {
  const cases = [
    { args: { kind: "threads", search_term: query }, method: "thread/search", params: { searchTerm: query, limit: 20 }, response: { data: [threadResult], nextCursor: null, backwardsCursor: "back", future: [true, null] } },
    { args: { kind: "threads", search_term: query, cursor: "native-next", limit: 1, sort_key: "recency_at", sort_direction: "asc", source_kinds: ["subAgentThreadSpawn", "subAgentThreadSpawn"], archived: true }, method: "thread/search", params: { searchTerm: query, cursor: "native-next", limit: 1, sortKey: "recency_at", sortDirection: "asc", sourceKinds: ["subAgentThreadSpawn", "subAgentThreadSpawn"], archived: true }, response: { data: [], nextCursor: "empty-page-next", backwardsCursor: null } },
    { args: { kind: "threads", search_term: query, sort_key: null, sort_direction: null, source_kinds: null, archived: null }, method: "thread/search", params: { searchTerm: query, limit: 20, sortKey: null, sortDirection: null, sourceKinds: null, archived: null }, response: { data: [], nextCursor: null, backwardsCursor: null } },
    { args: { kind: "threads", search_term: query, source_kinds: [], archived: false }, method: "thread/search", params: { searchTerm: query, limit: 20, sourceKinds: [], archived: false }, response: { data: [], nextCursor: null, backwardsCursor: null } },
    { args: { kind: "occurrences", thread_id: "thread", search_term: query, limit: 1, cursor: "native-occurrence" }, method: "thread/searchOccurrences", params: { threadId: "thread", searchTerm: query, limit: 1, cursor: "native-occurrence" }, response: { data: [occurrence({ future: "preserved" })], nextCursor: "next-occurrence" } },
  ];
  for (const { args, method, params, response } of cases) {
    const manager = new SearchNativeStub(() => response);
    const checkpoints = new Proxy({} as CheckpointStore, { get() { throw new Error("search must not access checkpoint"); } });
    assert.strictEqual(await new ControlSurface(manager, checkpoints).call("codex_search", args), response);
    assert.deepEqual(manager.requests, [{ method, params }]);
    assert.equal(manager.runtime.observe("thread", 0, 20), null);
  }
});

test("search preserves UTF-16 offsets, duplicate occurrences, full bounded pages and empty continuation", async () => {
  for (const response of [
    { data: [occurrence(), occurrence({ snippetMatchRange: { start: 7, end: 10 } })], nextCursor: null },
    { data: Array.from({ length: 100 }, () => occurrence()), nextCursor: "next" },
    { data: [], nextCursor: "still-more" },
  ]) {
    const manager = new SearchNativeStub(() => response);
    assert.strictEqual(await new ControlSurface(manager).call("codex_search", { kind: "occurrences", thread_id: "thread", search_term: "hit", limit: 100 }), response);
  }
});

test("search rejects unsupported scope and mismatched fields before upstream calls", async () => {
  const base = { kind: "threads", search_term: "hit" };
  const invalid: Record<string, unknown>[] = [
    {}, { search_term: "hit" }, { ...base, kind: "semantic" }, { ...base, cwd: "D:\\Project" },
    { ...base, parent_thread_id: "parent" }, { ...base, thread_id: null }, { ...base, include_turns: true },
    ...["", " ", null, 4, "x".repeat(501)].map(search_term => ({ ...base, search_term })),
    ...[null, "", " ", 4, "x".repeat(10001)].map(cursor => ({ ...base, cursor })),
    ...[null, 0, 101, 1.5, "2"].map(limit => ({ ...base, limit })),
    { ...base, sort_key: "relevance" }, { ...base, sort_direction: "newest" }, { ...base, archived: "false" },
    ...[{}, ["invalid"], [null], Array(101).fill("cli")].map(source_kinds => ({ ...base, source_kinds })),
    ...[undefined, null, "", " ", "x".repeat(201)].map(thread_id => ({ ...base, kind: "occurrences", thread_id })),
    ...["sort_key", "sort_direction", "source_kinds", "archived"].map(key => ({ ...base, kind: "occurrences", thread_id: "thread", [key]: null })),
  ];
  for (const args of invalid) {
    const manager = new SearchNativeStub(() => { throw new Error("unexpected upstream call"); });
    await assert.rejects(new ControlSurface(manager).call("codex_search", args));
    assert.equal(manager.requests.length, 0);
  }
});

test("search leaves legacy support, cursor validity and all native errors to native without fallbacks", async () => {
  for (const kind of ["threads", "occurrences"]) for (const message of ["requires paginated history", "cursor query mismatch", "native read timed out"]) {
    const error = new Error(message);
    const manager = new SearchNativeStub(() => { throw error; });
    await assert.rejects(new ControlSurface(manager).call("codex_search", { kind, search_term: "hit", ...(kind === "occurrences" ? { thread_id: "thread" } : {}) }), actual => actual === error);
    assert.equal(manager.requests.length, 1);
  }
});

test("search rejects malformed page identities, cursors and UTF-16 ranges without partial delivery", async () => {
  const cases = [
    ...[null, [], {}, { data: [], nextCursor: null }, { data: [threadResult], nextCursor: 4, backwardsCursor: null }, { data: [{ thread: {}, snippet: "text" }], nextCursor: null, backwardsCursor: null }, { data: [threadResult, threadResult], nextCursor: null, backwardsCursor: null }].map(response => ({ kind: "threads", response })),
    ...[
      { data: [], nextCursor: "" },
      ...[{ turnId: "" }, { itemId: null }, { turnCursor: "" }, { snippet: 4 }, { snippetMatchRange: null }, ...[{ start: -1, end: 2 }, { start: 2, end: 1 }, { start: 0, end: 99 }, { start: 1.5, end: 2 }, { start: 0, end: Number.MAX_SAFE_INTEGER + 1 }].map(snippetMatchRange => ({ snippetMatchRange }))].map(extra => ({ data: [occurrence(extra)], nextCursor: null })),
    ].map(response => ({ kind: "occurrences", response })),
  ];
  for (const { kind, response } of cases) {
    const manager = new SearchNativeStub(() => response);
    await assert.rejects(new ControlSurface(manager).call("codex_search", { kind, search_term: "hit", limit: 1, ...(kind === "occurrences" ? { thread_id: "thread" } : {}) }), /search_result_not_deliverable/);
    assert.equal(manager.requests.length, 1);
  }
});

test("search refuses sanitizer or byte-budget changes rather than corrupting snippets and locators", async () => {
  for (const extra of [
    { snippet: "password=synthetic-search-only" }, { futureSecret: "synthetic-search-only" },
    { future: "x".repeat(12001) }, { future: Array(101).fill("item") },
    { future: Array.from({ length: 8 }, () => "\u0001".repeat(10000)) },
  ]) {
    const manager = new SearchNativeStub(() => ({ data: [occurrence(extra)], nextCursor: "native-next" }));
    await assert.rejects(new ControlSurface(manager).call("codex_search", { kind: "occurrences", thread_id: "thread", search_term: "hit" }), error => {
      assert.match(String(error), /search_result_not_deliverable:/);
      assert.doesNotMatch(String(error), /synthetic-search-only|UNKNOWN|mutation was acknowledged/); return true;
    });
    assert.equal(manager.requests.length, 1);
  }
});

test("search tool is read-only, independently scoped and leaves checkpoint last", () => {
  const definition = TOOL_DEFINITIONS.find(tool => tool.name === "codex_search")!;
  assert.deepEqual(definition.annotations, { title: "Search Native Codex History", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  assert.deepEqual(definition.inputSchema.required, ["kind", "search_term"]);
  assert.equal(TOOL_DEFINITIONS.length, 12);
  assert.equal(TOOL_DEFINITIONS.at(-1)!.name, "codex_checkpoint");
  assert.equal("cwd" in (definition.inputSchema.properties as object), false);
});
