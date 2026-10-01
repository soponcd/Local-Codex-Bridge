import assert from "node:assert/strict";
import test from "node:test";
import { AppServerManager } from "../src/app-server.js";
import { CheckpointStore } from "../src/checkpoint.js";
import { QUEUE_ACTIONS } from "../src/queue.js";
import { RuntimeStore } from "../src/runtime.js";
import { ControlSurface, TOOL_DEFINITIONS } from "../src/tools.js";

class QueueNativeStub extends AppServerManager {
  readonly requests: Array<{ method: string; params: unknown }> = [];
  constructor(private readonly handle: (method: string, params: unknown) => unknown) {
    super(new RuntimeStore(), { executable: "unused-queue-fixture" });
  }
  override async request(method: string, params: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    return this.handle(method, params);
  }
}
const scope = { thread_id: "queue-thread" };
const text = "  Follow-up B 🌱  ";
const input = [{ type: "text", text, text_elements: [] }];
const item = (extra = {}) => ({ id: "queued-b", input, clientUserMessageId: "caller-b", futureField: { preserved: true }, ...extra });

test("queue actions forward exactly one native request without resume, start, checkpoint or queue state", async () => {
  const cases = [
    { action: "list", fields: {}, params: { limit: 20 }, response: { data: [], nextCursor: null } },
    { action: "list", fields: { limit: 1, cursor: "opaque-next" }, params: { limit: 1, cursor: "opaque-next" }, response: { data: [item()], nextCursor: "another-cursor", futurePage: "preserved" } },
    { action: "add", fields: { text, client_user_message_id: "caller-b" }, params: { input, clientUserMessageId: "caller-b" }, response: { queuedSubmission: item(), futureEnvelope: [true, null] } },
    { action: "update", fields: { text, queued_submission_id: "queued-b" }, params: { input, queuedSubmissionId: "queued-b" }, response: { queuedSubmission: item() } },
    ...[true, false].map(deleted => ({ action: "delete", fields: { queued_submission_id: "queued-b" }, params: { queuedSubmissionId: "queued-b" }, response: { deleted } })),
    { action: "reorder", fields: { queued_submission_ids: ["queued-c", "queued-b"] }, params: { queuedSubmissionIds: ["queued-c", "queued-b"] }, response: { futureEnvelope: "preserved" } },
    { action: "reorder", fields: { queued_submission_ids: [] }, params: { queuedSubmissionIds: [] }, response: {} },
  ];
  for (const { action, fields, params, response } of cases) {
    const manager = new QueueNativeStub(() => response);
    const checkpoints = new Proxy({} as CheckpointStore, { get() { throw new Error("queue must not touch checkpoints"); } });
    const result = await new ControlSurface(manager, checkpoints).call("codex_queue", { action, ...scope, ...fields });
    assert.strictEqual(result, response);
    assert.deepEqual(manager.requests, [{ method: `thread/queue/${action}`, params: { threadId: "queue-thread", ...params } }]);
    assert.equal(manager.runtime.observe("queue-thread", 0, 50), null);
  }
});

test("queue listing keeps native empty-page continuation and complete non-text native inputs", async () => {
  const responses = [
    { data: [], nextCursor: "opaque-empty-page-next" },
    { data: [item({ input: [{ type: "image", fileId: "native-file" }, { type: "futureInput", field: [1, null] }] })], nextCursor: null },
    { data: Array.from({ length: 100 }, (_, i) => item({ id: `native-${i}`, input: [] })), nextCursor: null },
  ];
  for (const response of responses) {
    const manager = new QueueNativeStub(() => response);
    assert.strictEqual(await new ControlSurface(manager).call("codex_queue", { action: "list", ...scope, limit: 100 }), response);
    assert.equal(manager.requests.length, 1);
  }
});

test("queue validation rejects action-mismatched fields, invalid identities, bounds and unsupported start", async () => {
  const valid: Record<string, Record<string, unknown>> = {
    list: {}, add: { text, client_user_message_id: "caller-b" },
    update: { text, queued_submission_id: "queued-b" }, delete: { queued_submission_id: "queued-b" },
    reorder: { queued_submission_ids: [] },
  };
  const forbidden: Record<string, string[]> = {
    list: ["text", "client_user_message_id", "queued_submission_id", "queued_submission_ids"],
    add: ["queued_submission_id", "queued_submission_ids", "cursor", "limit"],
    update: ["client_user_message_id", "queued_submission_ids", "cursor", "limit"],
    delete: ["text", "client_user_message_id", "queued_submission_ids", "cursor", "limit"],
    reorder: ["text", "client_user_message_id", "queued_submission_id", "cursor", "limit"],
  };
  const invalid: Record<string, unknown>[] = [
    {}, { ...scope }, { action: "start", ...scope }, { action: "list", ...scope, model: "extra" },
    ...["", " ", "x".repeat(201), null, 42].map(thread_id => ({ action: "list", thread_id })),
    ...[0, 101, 1.5, null, "1"].map(limit => ({ action: "list", ...scope, limit })),
    ...["", " ", "x".repeat(10001), null, 2].map(cursor => ({ action: "list", ...scope, cursor })),
    ...["", " ", "x".repeat(200001), null, 2].map(text => ({ action: "add", ...scope, client_user_message_id: "caller-b", text })),
    ...[undefined, "", " ", "x".repeat(201), null].map(client_user_message_id => ({ action: "add", ...scope, text, client_user_message_id })),
    ...[undefined, "", " ", "x".repeat(201), null].map(queued_submission_id => ({ action: "delete", ...scope, queued_submission_id })),
    ...[null, "queued-b", [""], [" "], [null], [1], ["x".repeat(201)], Array(101).fill("queued-b")].map(queued_submission_ids => ({ action: "reorder", ...scope, queued_submission_ids })),
    ...QUEUE_ACTIONS.flatMap(action => forbidden[action]!.map(key => ({ action, ...scope, ...valid[action], [key]: null }))),
  ];
  for (const args of invalid) {
    const manager = new QueueNativeStub(() => { throw new Error("unexpected native call"); });
    await assert.rejects(new ControlSurface(manager).call("codex_queue", args));
    assert.equal(manager.requests.length, 0);
  }
});

test("native owns queue membership, order and duplicate client IDs without Bridge reconciliation", async () => {
  const nativeError = new Error("native queue changed or duplicate client identity rejected");
  for (const args of [
    { action: "add", text, client_user_message_id: "caller-already-used" },
    { action: "update", text, queued_submission_id: "already-consumed" },
    { action: "reorder", queued_submission_ids: [" c ", "b", "b"] },
  ]) {
    const manager = new QueueNativeStub(() => { throw nativeError; });
    await assert.rejects(new ControlSurface(manager).call("codex_queue", { ...scope, ...args }), error => error === nativeError);
    assert.equal(manager.requests.length, 1);
    if (args.action === "reorder") assert.deepEqual((manager.requests[0]!.params as Record<string, unknown>).queuedSubmissionIds, args.queued_submission_ids);
  }
});

test("queue malformed or oversized success is acknowledged and never retried or partially returned", async () => {
  const addFields = { text, client_user_message_id: "caller-b" };
  const cases = [
    ...[null, [], {}, { queuedSubmission: null }, { queuedSubmission: item({ clientUserMessageId: "wrong-client" }) }, { queuedSubmission: item({ id: "" }) }, { queuedSubmission: item({ input: "not-an-array" }) }, { queuedSubmission: item({ future: Array.from({ length: 8 }, () => "\u0001".repeat(10000)) }) }].map(response => ({ action: "add", fields: addFields, response })),
    { action: "update", fields: { text, queued_submission_id: "queued-b" }, response: { queuedSubmission: item({ id: "wrong-submission" }) } },
    { action: "delete", fields: { queued_submission_id: "queued-b" }, response: { deleted: "yes" } },
    { action: "reorder", fields: { queued_submission_ids: [] }, response: [] },
  ];
  for (const { action, fields, response } of cases) {
    const manager = new QueueNativeStub(() => response);
    await assert.rejects(new ControlSurface(manager).call("codex_queue", { ...scope, action, ...fields }), error => {
      assert.match(String(error), /queue_result_not_deliverable:.*mutation was acknowledged/);
      assert.doesNotMatch(String(error), /UNKNOWN|synthetic-only|wrong-client|wrong-submission/);
      return true;
    });
    assert.equal(manager.requests.length, 1);
  }
});

test("queue read delivery errors cannot claim a mutation or invent a cursor", async () => {
  for (const response of [null, {}, { data: [], nextCursor: 4 }, { data: [] }, { data: [item({ input: null })], nextCursor: "native-next" }, { data: Array.from({ length: 101 }, () => item()), nextCursor: null }]) {
    const manager = new QueueNativeStub(() => response);
    await assert.rejects(new ControlSurface(manager).call("codex_queue", { ...scope, action: "list" }), error => {
      assert.match(String(error), /native thread\/queue\/list returned success/);
      assert.doesNotMatch(String(error), /mutation was acknowledged|UNKNOWN/);
      return true;
    });
    assert.equal(manager.requests.length, 1);
  }
});

test("queue ambiguous mutation errors pass through without readback, retry or compensation", async () => {
  for (const [action, fields] of [
    ["add", { text, client_user_message_id: "caller-b" }],
    ["update", { text, queued_submission_id: "queued-b" }],
    ["delete", { queued_submission_id: "queued-b" }],
    ["reorder", { queued_submission_ids: [] }],
  ] as const) {
    const nativeError = new Error("acknowledgement timed out; outcome is UNKNOWN");
    const manager = new QueueNativeStub(() => { throw nativeError; });
    await assert.rejects(new ControlSurface(manager).call("codex_queue", { ...scope, action, ...fields }), error => error === nativeError);
    assert.equal(manager.requests.length, 1);
  }
});

test("queue tool is conservatively annotated and exposes only native active-workflow management", () => {
  const definition = TOOL_DEFINITIONS.find(tool => tool.name === "codex_queue")!;
  assert.deepEqual(definition.annotations, { title: "Codex Native Queue", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
  const fields = definition.inputSchema.properties as Record<string, Record<string, unknown>>;
  assert.deepEqual(fields.action!.enum, ["list", "add", "update", "delete", "reorder"]);
  assert.equal(fields.queued_submission_ids!.maxItems, 100);
  assert.equal(TOOL_DEFINITIONS.length, 12);
  assert.equal(TOOL_DEFINITIONS.at(-1)!.name, "codex_checkpoint");
  assert.equal("model" in fields || "resume" in fields || "start" in fields || "cwd" in fields, false);
});
