import { encodeExactJson, ExactJsonError } from "./exact-json.js";

export const GOAL_STATUSES = [
  "active", "paused", "blocked", "usageLimited", "budgetLimited", "complete",
] as const;

export type GoalAction = "get" | "set" | "clear";

// A result-body transport bound, not a goal or execution budget.
export const MAX_GOAL_RESULT_BYTES = 256 * 1024;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function exactGoalResponse(
  value: unknown,
  action: GoalAction,
  threadId: string,
): Record<string, unknown> {
  const fail = (reason: string): never => {
    const acknowledgement = action === "get"
      ? "native thread/goal/get returned success"
      : `native thread/goal/${action} returned success; the mutation was acknowledged`;
    throw new Error(
      `goal_result_not_deliverable: ${acknowledgement}, but its result cannot be delivered losslessly (${reason}). No retry or compensation was performed. Inspect native goal state before another mutation; if this Bridge read remains undeliverable, use the native interface.`,
    );
  };

  const response = record(value);
  if (!response) return fail("invalid response envelope");
  if (action === "clear") {
    if (typeof response.cleared !== "boolean") return fail("invalid cleared field");
  } else if (!(action === "get" && response.goal === null)) {
    const goal = record(response.goal);
    if (!goal || goal.threadId !== threadId ||
        typeof goal.objective !== "string" || typeof goal.status !== "string") {
      return fail("invalid goal identity or fields");
    }
    // Keep future status strings and additive fields; these checks only protect
    // the installed required numeric contract from JavaScript precision loss.
    for (const key of ["tokensUsed", "timeUsedSeconds", "createdAt", "updatedAt"]) {
      if (!Number.isSafeInteger(goal[key])) return fail("invalid or unsafe goal number");
    }
    if (goal.tokenBudget !== undefined && goal.tokenBudget !== null &&
        !Number.isSafeInteger(goal.tokenBudget)) {
      return fail("unsafe goal budget number");
    }
  }

  let encoded: string;
  try { encoded = encodeExactJson(response); }
  catch (error) { return fail(error instanceof ExactJsonError ? error.message : "structure: unrepresentable response"); }
  if (Buffer.byteLength(encoded, "utf8") > MAX_GOAL_RESULT_BYTES) {
    return fail("size: result exceeds the transport byte bound");
  }
  return response;
}
