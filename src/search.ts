import { encodeExactJson, ExactJsonError, type ContentPolicy } from "./exact-json.js";

export const SEARCH_PAGE_LIMIT = 100;
export const MAX_SEARCH_RESULT_BYTES = 256 * 1024;
export type SearchKind = "threads" | "occurrences";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
function cursor(value: unknown): boolean {
  return value === null || identifier(value);
}

export function exactSearchResponse(value: unknown, kind: SearchKind, limit: number, policy: ContentPolicy = "protected"): Record<string, unknown> {
  const fail = (reason: string): never => {
    throw new Error(`search_result_not_deliverable: native search returned success but its page cannot be delivered losslessly (${reason}). No partial data/cursor, fallback search or history read was performed. Size failures may allow a smaller limit; a single oversized result requires native inspection.`);
  };
  const page = record(value);
  if (!page || !Array.isArray(page.data) || page.data.length > limit || !cursor(page.nextCursor) ||
      (kind === "threads" && !cursor(page.backwardsCursor))) return fail("invalid page or cursor");
  for (const value of page.data) {
    const item = record(value);
    if (!item || typeof item.snippet !== "string") return fail("invalid result or snippet");
    if (kind === "threads") {
      if (!identifier(record(item.thread)?.id)) return fail("invalid thread identity");
    } else {
      const range = record(item.snippetMatchRange);
      if (!identifier(item.turnId) || !identifier(item.itemId) || !identifier(item.turnCursor) ||
          !range || !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) ||
          (range.start as number) < 0 || (range.end as number) < (range.start as number) ||
          (range.end as number) > item.snippet.length) return fail("invalid occurrence identity or UTF-16 range");
    }
  }
  // Never shorten/redact a snippet while returning native offsets or cursors.
  let encoded: string;
  try { encoded = encodeExactJson(page, policy); }
  catch (error) { return fail(error instanceof ExactJsonError ? error.message : "structure: unrepresentable response"); }
  if (Buffer.byteLength(encoded, "utf8") > MAX_SEARCH_RESULT_BYTES) return fail("size: result exceeds the transport byte bound");
  return page;
}
