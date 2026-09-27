import { sanitizeForTransport } from "./runtime.js";

export const QUEUE_ACTIONS = ["list", "add", "update", "delete", "reorder"] as const;
export type QueueAction = typeof QUEUE_ACTIONS[number];

// Transport bounds, not native queue capacity or scheduling policy.
export const QUEUE_PAGE_LIMIT = 100;
export const MAX_QUEUE_RESULT_BYTES = 256 * 1024;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function submission(value: unknown): Record<string, unknown> | null {
  const item = record(value);
  return item && typeof item.id === "string" && item.id.length > 0 &&
    typeof item.clientUserMessageId === "string" && Array.isArray(item.input)
    ? item : null;
}

export function exactQueueResponse(
  value: unknown,
  action: QueueAction,
  expected: { submissionId?: string; clientUserMessageId?: string } = {},
): Record<string, unknown> {
  const fail = (reason: string): never => {
    const acknowledgement = action === "list"
      ? "native thread/queue/list returned success"
      : `native thread/queue/${action} returned success; the mutation was acknowledged`;
    throw new Error(
      `queue_result_not_deliverable: ${acknowledgement}, but its result cannot be delivered losslessly (${reason}). No retry or compensation was performed. Read native queue and execution state before deciding on another mutation.`,
    );
  };
  const response = record(value);
  if (!response) return fail("invalid response envelope");
  if (action === "list") {
    if (!Array.isArray(response.data) || response.data.length > QUEUE_PAGE_LIMIT ||
        !response.data.every(item => submission(item) !== null) ||
        !(response.nextCursor === null || typeof response.nextCursor === "string")) {
      return fail("invalid queue page or cursor");
    }
  } else if (action === "add" || action === "update") {
    const item = submission(response.queuedSubmission);
    if (!item || (expected.submissionId !== undefined && item.id !== expected.submissionId) ||
        (expected.clientUserMessageId !== undefined && item.clientUserMessageId !== expected.clientUserMessageId)) {
      return fail("invalid queued submission identity or fields");
    }
  } else if (action === "delete" && typeof response.deleted !== "boolean") {
    return fail("invalid deleted field");
  }

  let encoded: string;
  let projected: string;
  try {
    encoded = JSON.stringify(response);
    projected = JSON.stringify(sanitizeForTransport(response, { maxArrayItems: QUEUE_PAGE_LIMIT }));
  } catch { return fail("unrepresentable response"); }
  if (encoded !== projected) return fail("redaction or transport truncation required");
  if (Buffer.byteLength(encoded, "utf8") > MAX_QUEUE_RESULT_BYTES) {
    return fail("result exceeds the transport byte bound");
  }
  return response;
}
