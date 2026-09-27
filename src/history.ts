import { sanitizeForTransport } from "./runtime.js";

// Count the actual success envelope: one structured result and a tiny text marker.
// Reserve framing/request-id headroom before the final MCP check with the real id.
export const MAX_HISTORY_MCP_BYTES = 256 * 1024;
export const HISTORY_MCP_WRAPPER_ALLOWANCE_BYTES = 1024;

export function structuredToolResult(response: unknown): Record<string, unknown> {
  return { content: [{ type: "text", text: "structured result" }], structuredContent: response };
}

export function historyMcpBytes(response: unknown, id: string | number): number {
  return Buffer.byteLength(JSON.stringify({
    jsonrpc: "2.0",
    id,
    result: structuredToolResult(response),
  }) + "\n", "utf8");
}

export interface HistoryPage {
  data: unknown[];
  nextCursor: string | null;
  backwardsCursor: string | null;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function validateHistoryPage(value: unknown, limit: number, kind: "turns" | "items"): HistoryPage {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("history_upstream_invalid: response must be an object");
  }
  const page = value as Record<string, unknown>;
  if (!Array.isArray(page.data) || page.data.length > limit) {
    throw new Error("history_upstream_invalid: data must be an array within the requested limit");
  }
  for (const key of ["nextCursor", "backwardsCursor"] as const) {
    if (page[key] !== null && (typeof page[key] !== "string" || page[key].length === 0)) {
      throw new Error(`history_upstream_invalid: ${key} must be an opaque string or null`);
    }
  }
  for (const entry of page.data) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("history_upstream_invalid: data entries must be objects");
    }
    const record = entry as Record<string, unknown>;
    if (kind === "turns") {
      if (typeof record.id !== "string" || record.id.length === 0) {
        throw new Error("history_upstream_invalid: turn entries require an id");
      }
    } else if (typeof record.turnId !== "string" || record.turnId.length === 0 ||
               record.item === null || typeof record.item !== "object" || Array.isArray(record.item)) {
      throw new Error("history_upstream_invalid: item entries require turnId and item");
    }
  }
  return page as unknown as HistoryPage;
}

export function exactHistoryResponse(response: Record<string, unknown>): Record<string, unknown> {
  // Check redaction before size so a secret cannot be mislabeled as a page
  // that can necessarily be recovered by reducing limit.
  let policyProjection: unknown;
  try {
    policyProjection = sanitizeForTransport(response, {
      maxStringChars: Number.MAX_SAFE_INTEGER,
      maxDepth: 128,
      maxArrayItems: Number.MAX_SAFE_INTEGER,
      maxObjectKeys: Number.MAX_SAFE_INTEGER,
      totalCharBudget: Number.MAX_SAFE_INTEGER,
    });
  } catch {
    throw new Error("history_page_not_lossless: sanitizer cannot project the page");
  }
  if (!jsonEqual(response, policyProjection)) {
    throw new Error("history_page_not_lossless: redaction or sanitizer policy would alter the page");
  }

  if (historyMcpBytes(response, "") + HISTORY_MCP_WRAPPER_ALLOWANCE_BYTES > MAX_HISTORY_MCP_BYTES) {
    throw new Error("history_page_too_large: received page exceeds the lossless MCP byte budget; paginated pages may retry the same cursor with a smaller limit; a legacy turn at limit:1 cannot be made smaller");
  }

  // Keep the current transport sanitizer as the eligibility policy, then
  // return the original response so successful pages are never rewritten.
  let transportProjection: unknown;
  try {
    transportProjection = sanitizeForTransport(response);
  } catch {
    throw new Error("history_page_not_lossless: sanitizer cannot project the page");
  }
  if (!jsonEqual(response, transportProjection)) {
    throw new Error("history_page_not_lossless: transport sanitizer would alter the page");
  }
  return response;
}
