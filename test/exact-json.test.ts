import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";
import { encodeExactJson, MAX_EXACT_JSON_DEPTH, MUTATION_DELIVERY_RESERVE_BYTES, preflightEcho } from "../src/exact-json.js";
import { hasSecretText } from "../src/redaction.js";
import { exactHistoryResponse, historyMcpBytes } from "../src/history.js";
import { exactSearchResponse } from "../src/search.js";
import { exactGoalResponse } from "../src/goal.js";
import { MAX_QUEUE_RESULT_BYTES, exactQueueResponse } from "../src/queue.js";
import { AppServerManager } from "../src/app-server.js";
import { RuntimeStore } from "../src/runtime.js";
import { ControlSurface } from "../src/tools.js";

test("exact JSON keeps wide/deep native data and has a deterministic low-stack serialization guard", () => {
  const response = { data: [{ items: Array.from({ length: 60 }, (_, id) => ({ id, text: "x".repeat(3000) })),
    fields: Object.fromEntries(Array.from({ length: 70 }, (_, i) => [String(i), i])),
    result: { structuredContent: { a: { b: { c: { d: { e: { f: { g: true } } } } } } } } }] };
  assert.strictEqual(exactHistoryResponse(response), response);
  assert.ok(historyMcpBytes(response, 1) < 256 * 1024);
  const deep = (n: number) => JSON.parse("[".repeat(n) + "0" + "]".repeat(n)) as unknown;
  assert.equal(encodeExactJson(deep(MAX_EXACT_JSON_DEPTH)).length, 513);
  assert.throws(() => encodeExactJson(deep(MAX_EXACT_JSON_DEPTH + 1)), /structure:/);
  const circular: unknown[] = []; circular.push(circular);
  for (const value of [circular, { a: undefined }, { a: Infinity }, { a: 1n }, new Date()]) {
    assert.throws(() => encodeExactJson(value), /structure:/);
  }
  const shared = { value: 1 }; assert.equal(encodeExactJson([shared, shared]), JSON.stringify([shared, shared]));
  const probe = spawnSync(process.execPath, ["--stack-size=200", "--input-type=module", "-e",
    `import { exactHistoryResponse, historyMcpBytes } from ${JSON.stringify(new URL("../src/history.js", import.meta.url).href)};
     let data = 0; for (let i=0; i<250; i++) data=[data]; historyMcpBytes(exactHistoryResponse({data}), 1);`
  ], { encoding: "utf8" });
  assert.equal(probe.status, 0, probe.stderr);
});

test("protected detection is stateless across long/short strings and exact is per-call", () => {
  for (let i = 0; i < 3; i++) {
    assert.equal(hasSecretText("padding ".repeat(30) + "password: fixture-long"), true);
    assert.equal(hasSecretText("password: x"), true);
    assert.equal(hasSecretText("ordinary code"), false);
    // Test both orders: a single matching sibling cannot hide behind regex state.
    for (const text of [["password: x", "ordinary"], ["ordinary", "password: x"]]) {
      assert.throws(() => encodeExactJson({ data: text }, "protected"), /content_policy:/);
    }
  }
  for (const item of [{ text: "interface Login { password: string }" }, { arguments: { page_token: "cursor" } }]) {
    const page = { data: [item] };
    assert.throws(() => exactHistoryResponse(page), /content_policy:/);
    assert.strictEqual(exactHistoryResponse(page, "exact"), page);
    assert.throws(() => exactHistoryResponse(page), /content_policy:/);
  }
  const snippet = "🌱 password: fixture-only";
  const page = { data: [{ turnId: "t", itemId: "i", turnCursor: "anchor", snippet,
    snippetMatchRange: { start: 3, end: 11 } }], nextCursor: "next" };
  assert.throws(() => exactSearchResponse(page, "occurrences", 1), /content_policy:/);
  assert.strictEqual(exactSearchResponse(page, "occurrences", 1, "exact"), page);
});

test("Queue and Goal JSONL round trips recover ordinary code, long input and native readback", async () => {
  for (const domain of ["queue", "goal"]) {
    const manager = new AppServerManager(undefined, { executable: process.execPath,
      prefixArgs: [resolve("test", `${domain}-codex.mjs`)] });
    const surface = new ControlSurface(manager);
    try {
      if (domain === "queue") {
        for (const text of ["password: string; api_key=example-only", "x".repeat(12001), "x".repeat(200000), "🌱中".repeat(1000)]) {
          const added = await surface.call("codex_queue", { action: "add", thread_id: "t", text, client_user_message_id: "c" }) as any;
          const first = await surface.call("codex_queue", { action: "list", thread_id: "t", limit: 1 }) as any;
          assert.deepEqual(first.data, [added.queuedSubmission]);
          const updated = await surface.call("codex_queue", { action: "update", thread_id: "t", text: text.slice(0, -1) + "!", queued_submission_id: first.data[0].id }) as any;
          assert.deepEqual((await surface.call("codex_queue", { action: "list", thread_id: "t", limit: 1 }) as any).data, [updated.queuedSubmission]);
          await surface.call("codex_queue", { action: "delete", thread_id: "t", queued_submission_id: first.data[0].id });
        }
      } else {
        const set = await surface.call("codex_goal", { action: "set", thread_id: "t", objective: "Fix password: field", budget_mode: "preserve" });
        assert.deepEqual(await surface.call("codex_goal", { action: "get", thread_id: "t" }), set);
      }
      const before = await manager.request("test/requests", {}) as unknown[];
      for (const text of ["中".repeat(100000), "\u0001".repeat(50000)]) {
        await assert.rejects(surface.call(`codex_${domain}`, domain === "queue"
          ? { action: "add", thread_id: "t", client_user_message_id: "c", text }
          : { action: "set", thread_id: "t", objective: text, budget_mode: "preserve" }), /input_too_large:.*no native mutation/);
      }
      assert.deepEqual(await manager.request("test/requests", {}), before);
    } finally { await manager.close(); }
  }
});

test("defensive reserve covers known single-item envelopes without claiming unknown native overhead", () => {
  const text = "\u0001".repeat(42000);
  const known = { data: [{ id: "", input: [{ type: "text", text, text_elements: [] }], clientUserMessageId: "c" }], nextCursor: null };
  preflightEcho(known, MAX_QUEUE_RESULT_BYTES, "queue");
  const item = { ...known.data[0]!, id: "\u0001".repeat(200), clientUserMessageId: "\u0001".repeat(200) };
  const list = { data: [item], nextCursor: "eyJvZmZzZXQiOjEsInRocmVhZCI6IjAxOTljNmQ0LWZiNzItN2UxMi1iYzQzLTU2YjM0NGQ3NmUxMCJ9" };
  assert.ok(Buffer.byteLength(JSON.stringify(list)) - Buffer.byteLength(JSON.stringify(known)) < MUTATION_DELIVERY_RESERVE_BYTES);
  assert.strictEqual(exactQueueResponse(list, "list"), list);
  const near = { data: [{ ...known.data[0]!, input: [{ type: "text", text: "中".repeat(87000), text_elements: [] }] }], nextCursor: null };
  assert.ok(Buffer.byteLength(JSON.stringify(near)) < MAX_QUEUE_RESULT_BYTES);
  assert.throws(() => preflightEcho(near, MAX_QUEUE_RESULT_BYTES, "queue"), /queue_input_too_large/);
  assert.throws(() => exactQueueResponse({ queuedSubmission: { ...item, future: "z".repeat(20000) } }, "add"), /mutation was acknowledged.*size:/);
});

test("Goal Queue and Search retain their actual UTF-8 escaped result-body byte boundaries", () => {
  for (const domain of ["goal", "queue", "search"] as const) {
    const create = (text: string): Record<string, unknown> => domain === "goal"
      ? { goal: { threadId: "t", objective: "task", status: "paused", tokensUsed: 0, timeUsedSeconds: 0, createdAt: 0, updatedAt: 0 }, future: { password: "fixture", text } }
      : domain === "queue" ? { data: [{ id: "q", clientUserMessageId: "c", input: [{ type: "text", text, text_elements: [] }] }], nextCursor: null }
      : { data: [{ thread: { id: "t" }, snippet: text }], nextCursor: null, backwardsCursor: null };
    const deliver = (value: Record<string, unknown>) => domain === "goal" ? exactGoalResponse(value, "get", "t")
      : domain === "queue" ? exactQueueResponse(value, "list") : exactSearchResponse(value, "threads", 1);
    for (const character of ["中", "🌱", "\u0001"]) {
      const overhead = Buffer.byteLength(JSON.stringify(create("")));
      const cost = Buffer.byteLength(JSON.stringify(character)) - 2;
      const count = Math.floor((256 * 1024 - overhead) / cost);
      const page = create(character.repeat(count));
      assert.strictEqual(deliver(page), page);
      assert.throws(() => deliver(create(character.repeat(count + 1))), /size:/);
    }
  }
});

test("content policy validates before reads, is not forwarded natively and does not stick", async () => {
  class Native extends AppServerManager {
    calls: Array<{ method: string; params: unknown }> = [];
    override async request(method: string, params: any) {
      this.calls.push({ method, params });
      if (method === "thread/read") return { thread: { id: "t", historyMode: "legacy" } };
      if (method === "thread/turns/list") return { data: [{ id: "u", items: [{ text: "password: fixture" }] }], nextCursor: null, backwardsCursor: null };
      return { data: [{ thread: { id: "t" }, snippet: "password: fixture" }], nextCursor: null, backwardsCursor: null };
    }
  }
  const native = new Native(new RuntimeStore(), { executable: "unused-fixture" });
  const surface = new ControlSurface(native);
  for (const [tool, fields] of [["codex_history", { thread_id: "t", kind: "turns" }], ["codex_search", { kind: "threads", search_term: "password" }]] as const) {
    const before = native.calls.length;
    for (const content_policy of [null, "trusted_exact", 1]) await assert.rejects(surface.call(tool, { ...fields, content_policy }));
    assert.equal(native.calls.length, before);
    await assert.rejects(surface.call(tool, fields), /content_policy:/);
    await surface.call(tool, { ...fields, content_policy: "exact" });
    await assert.rejects(surface.call(tool, fields), /content_policy:/);
    assert.ok(native.calls.every(call => !Object.hasOwn(call.params as object, "content_policy")));
  }
});
