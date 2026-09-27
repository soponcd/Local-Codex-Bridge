import assert from "node:assert/strict";
import test from "node:test";

import { AppServerManager } from "../src/app-server.js";
import { CheckpointStore } from "../src/checkpoint.js";
import { GOAL_STATUSES } from "../src/goal.js";
import { RuntimeStore } from "../src/runtime.js";
import { ControlSurface, TOOL_DEFINITIONS } from "../src/tools.js";

class GoalNativeStub extends AppServerManager {
  readonly requests: Array<{ method: string; params: unknown }> = [];
  constructor(private readonly handle: (method: string, params: unknown) => unknown) {
    super(new RuntimeStore(), { executable: "unused-goal-fixture" });
  }
  override async request(method: string, params: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    return this.handle(method, params);
  }
}

const nativeGoal = (extra = {}) => ({
  threadId: "goal-thread", objective: "Native fixture objective 🌱", status: "paused",
  tokenBudget: 500, tokensUsed: 23, timeUsedSeconds: 4, createdAt: 100, updatedAt: 105,
  ...extra,
});
const input = { thread_id: "goal-thread" };

test("goal mapping makes one native call and preserves omissions, nulls, and native values", async () => {
  const cases = [
    { args: { action: "get", ...input }, params: { threadId: "goal-thread" }, result: { goal: null } },
    { args: { action: "get", ...input }, params: { threadId: "goal-thread" }, result: { goal: nativeGoal({ status: "futureNativeStatus", additive: { exact: true } }), futureEnvelope: [1, null] } },
    { args: { action: "clear", ...input }, params: { threadId: "goal-thread" }, result: { cleared: false, futureField: "exact" } },
    { args: { action: "clear", ...input }, params: { threadId: "goal-thread" }, result: { cleared: true } },
    { args: { action: "set", ...input, budget_mode: "preserve" }, params: { threadId: "goal-thread" }, result: { goal: nativeGoal() } },
    { args: { action: "set", ...input, budget_mode: "unlimited", objective: null, status: null }, params: { threadId: "goal-thread", objective: null, status: null, tokenBudget: null }, result: { goal: nativeGoal({ tokenBudget: null }) } },
    { args: { action: "set", ...input, budget_mode: "fixed", token_budget: Number.MAX_SAFE_INTEGER }, params: { threadId: "goal-thread", tokenBudget: Number.MAX_SAFE_INTEGER }, result: { goal: nativeGoal({ tokenBudget: Number.MAX_SAFE_INTEGER }) } },
    { args: { action: "set", ...input, budget_mode: "fixed", token_budget: 1 }, params: { threadId: "goal-thread", tokenBudget: 1 }, result: { goal: nativeGoal({ tokenBudget: 1 }) } },
  ];
  for (const { args, params, result } of cases) {
    const manager = new GoalNativeStub(() => result);
    const checkpoints = new Proxy({} as CheckpointStore, { get() { throw new Error("Goal must not touch checkpoint"); } });
    const control = new ControlSurface(manager, checkpoints);
    assert.strictEqual(await control.call("codex_goal", args), result);
    assert.deepEqual(manager.requests, [{ method: `thread/goal/${args.action}`, params }]);
    assert.equal(manager.runtime.observe("goal-thread", 0, 50), null, "response must not reconstruct live runtime");
  }
});

test("goal objective validation stays native and Bridge never trims or counts Unicode", async () => {
  for (const objective of ["  Native objective 🌱  ", "", " ", "🌱".repeat(4001)]) {
    const nativeError = new Error("native objective rejected");
    const manager = new GoalNativeStub(() => { throw nativeError; });
    await assert.rejects(new ControlSurface(manager).call("codex_goal", {
      ...input, action: "set", budget_mode: "preserve", objective,
    }), error => error === nativeError);
    assert.deepEqual(manager.requests, [{ method: "thread/goal/set", params: { threadId: "goal-thread", objective } }]);
  }
});

test("goal forwards every installed native status without deriving lifecycle", async () => {
  for (const status of GOAL_STATUSES) {
    const response = { goal: nativeGoal({ status }) };
    const manager = new GoalNativeStub(() => response);
    assert.strictEqual(await new ControlSurface(manager).call("codex_goal", { ...input, action: "set", budget_mode: "preserve", status }), response);
    assert.deepEqual(manager.requests, [{ method: "thread/goal/set", params: { threadId: "goal-thread", status } }]);
  }
});

test("goal validates action-specific shape and lossless budget bounds before native mutation", async () => {
  const invalid = [
    {}, { ...input }, { ...input, action: "resume" }, { action: "get", thread_id: " " },
    { action: "get", thread_id: "t".repeat(201) },
    { ...input, action: "set", budget_mode: "preserve", objective: 4 }, { ...input, action: "set", budget_mode: "preserve", status: "budget_limited" },
    ...[undefined, null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, "5", true].map(token_budget => ({ ...input, action: "set", budget_mode: "fixed", token_budget })),
    ...["get", "clear"].flatMap(action => ["objective", "status", "budget_mode", "token_budget"].map(key => ({ ...input, action, [key]: null }))),
    ...[undefined, null, "", "auto", false].map(budget_mode => ({ ...input, action: "set", budget_mode })),
    ...["preserve", "unlimited"].flatMap(budget_mode => [undefined, null, 1].map(token_budget => ({ ...input, action: "set", budget_mode, token_budget }))),
    { ...input, action: "set", token_budget: 500 }, { ...input, action: "set", token_budget: null },
    { ...input, action: "set", unexpected: true },
  ];
  for (const args of invalid) {
    const manager = new GoalNativeStub(() => { throw new Error("Must not reach native"); });
    await assert.rejects(new ControlSurface(manager).call("codex_goal", args));
    assert.equal(manager.requests.length, 0);
  }
});

test("goal native errors including ambiguous mutations propagate once without read/modify/retry", async () => {
  for (const action of ["get", "set", "clear"]) {
    for (const nativeError of [new Error("native rejected"), new Error("mutation outcome UNKNOWN")]) {
      const manager = new GoalNativeStub(() => { throw nativeError; });
      await assert.rejects(new ControlSurface(manager).call("codex_goal", { ...input, action, ...(action === "set" ? { budget_mode: "preserve" } : {}) }), error => error === nativeError);
      assert.equal(manager.requests.length, 1);
    }
  }
});

test("goal success that cannot be delivered reports acknowledgement, never UNKNOWN or partial data", async () => {
  const invalidResults = [
    null, [], {}, { goal: null }, { goal: nativeGoal({ threadId: "other-thread" }) },
    { goal: nativeGoal({ tokensUsed: Number.MAX_SAFE_INTEGER + 1 }) },
    { goal: nativeGoal({ tokenBudget: Number.MAX_SAFE_INTEGER + 1 }) },
    { goal: nativeGoal({ objective: "password=synthetic-test-only" }) },
    { goal: nativeGoal(), futureSecret: "synthetic-test-only" },
    { goal: nativeGoal(), future: Array.from({ length: 51 }, () => "item") },
    { goal: nativeGoal(), future: "x".repeat(12001) },
    // Escaping exceeds the byte bound while ordinary sanitizer budgets fit.
    { goal: nativeGoal(), future: Array.from({ length: 8 }, () => "\u0001".repeat(10000)) },
  ];
  for (const result of invalidResults) {
    const manager = new GoalNativeStub(() => result);
    await assert.rejects(new ControlSurface(manager).call("codex_goal", { ...input, action: "set", budget_mode: "preserve" }), error => {
      assert.match(String(error), /^Error: goal_result_not_deliverable:/);
      assert.match(String(error), /native thread\/goal\/set returned success; the mutation was acknowledged/);
      assert.doesNotMatch(String(error), /UNKNOWN|synthetic-test-only/);
      return true;
    });
    assert.equal(manager.requests.length, 1);
  }
  for (const action of ["get", "clear"]) {
    const manager = new GoalNativeStub(() => ({ wrong: true }));
    await assert.rejects(new ControlSurface(manager).call("codex_goal", { ...input, action }), error => {
      assert.match(String(error), /returned success/);
      assert.equal(String(error).includes("mutation was acknowledged"), action === "clear");
      assert.doesNotMatch(String(error), /UNKNOWN/);
      return true;
    });
  }
});

test("goal schema has no defaults or competing objective length policy and conservative annotations", () => {
  const definition = TOOL_DEFINITIONS.find(tool => tool.name === "codex_goal")!;
  const properties = definition.inputSchema.properties as Record<string, Record<string, unknown>>;
  assert.deepEqual(definition.annotations, {
    title: "Manage Native Codex Goal", readOnlyHint: false, destructiveHint: true,
    idempotentHint: false, openWorldHint: true,
  });
  assert.deepEqual(properties.status!.enum, [...GOAL_STATUSES, null]);
  assert.equal(properties.objective!.maxLength, undefined);
  assert.equal(properties.token_budget!.maximum, Number.MAX_SAFE_INTEGER);
  assert.equal(properties.token_budget!.type, "integer");
  assert.deepEqual(properties.budget_mode!.enum, ["preserve", "unlimited", "fixed"]);
  const setBranch = (definition.inputSchema.oneOf as Array<Record<string, any>>)[0]!;
  assert.deepEqual(setBranch.required, ["budget_mode"]);
  assert.deepEqual(setBranch.oneOf[0].required, ["token_budget"]);
  assert.match(properties.token_budget!.description as string, /lossless transport bound/);
  for (const field of Object.values(properties)) assert.equal(Object.hasOwn(field, "default"), false);
});

test("goal notifications wake compact observation and remain replayable in raw without a goal registry", async () => {
  for (const method of ["thread/goal/updated", "thread/goal/cleared"]) {
    const runtime = new RuntimeStore();
    runtime.markTurnAccepted("goal-thread", "test-turn");
    const control = new ControlSurface({ runtime } as AppServerManager);
    const pending = control.call("codex_observe", { ...input, cursor: 0, wait_ms: 1000 });
    const params = method.endsWith("updated")
      ? { threadId: "goal-thread", turnId: null, goal: nativeGoal() }
      : { threadId: "goal-thread" };
    runtime.recordNotification(method, params);
    const compact = await pending as Record<string, any>;
    assert.notEqual(compact.no_change, true);
    assert.ok(compact.events.some((event: any) => event.type === "diagnostic_passthrough" && event.method === method));
    const raw = await control.call("codex_observe", { ...input, cursor: 0, view: "raw" }) as Record<string, any>;
    assert.deepEqual(raw.events.at(-1).data, params);
    assert.equal(raw.active_turn_id, "test-turn", "goal notification must not change turn identity");
  }
});
