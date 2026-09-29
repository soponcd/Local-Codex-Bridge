import { hasSecretText, isSecretKey } from "./redaction.js";

export type ContentPolicy = "protected" | "exact";

// Defensive serialization guard, not an MCP or native data-depth contract.
// Node 24.14.1 Windows probes: stringify fails near 4770 container levels,
// or 919 with --stack-size=200. 256 leaves room for callers and MCP wrappers.
export const MAX_EXACT_JSON_DEPTH = 256;

export class ExactJsonError extends Error {
  constructor(readonly reason: "structure" | "content_policy") {
    super(reason === "content_policy"
      ? "content_policy: protected content matched secret detection; exact is an explicit per-call option that may expose sensitive native content"
      : "structure: response is not JSON-safe or exceeds the defensive serialization guard; inspect native data outside this page");
  }
}

// Validate without rewriting, recursive traversal, or observe field budgets.
// Native JSON cannot contain cycles; an active-path set also makes stubs safe
// while allowing repeated (non-cyclic) references to serialize normally.
export function encodeExactJson(value: unknown, policy: ContentPolicy = "exact"): string {
  type Visit = { value: unknown; depth: number } |
    { children: Iterator<[string | number, unknown]>; parent: object; depth: number };
  const stack: Visit[] = [{ value, depth: 0 }];
  const active = new Set<object>();
  let sensitive = false;
  function* entries(object: Record<string, unknown>): Generator<[string, unknown]> {
    for (const key in object) if (Object.hasOwn(object, key)) yield [key, object[key]];
  }
  while (stack.length) {
    const frame = stack.pop()!;
    if ("children" in frame) {
      const next = frame.children.next();
      if (next.done) { active.delete(frame.parent); continue; }
      const [key, child] = next.value;
      if (policy === "protected" && typeof key === "string" && isSecretKey(key)) sensitive = true;
      stack.push(frame, { value: child, depth: frame.depth });
      continue;
    }
    const current = frame.value;
    if (current === null || typeof current === "boolean") continue;
    if (typeof current === "string") {
      if (policy === "protected" && hasSecretText(current)) sensitive = true;
      continue;
    }
    if (typeof current === "number" && Number.isFinite(current)) continue;
    if (typeof current !== "object" || frame.depth >= MAX_EXACT_JSON_DEPTH || active.has(current)) {
      throw new ExactJsonError("structure");
    }
    const array = Array.isArray(current);
    if (!array && Object.getPrototypeOf(current) !== Object.prototype && Object.getPrototypeOf(current) !== null) {
      throw new ExactJsonError("structure");
    }
    active.add(current);
    // Iterator frames bound traversal memory by depth, not array width.
    stack.push({ parent: current, depth: frame.depth + 1,
      children: array ? current.entries() : entries(current as Record<string, unknown>) });
  }
  if (sensitive) throw new ExactJsonError("content_policy");
  try { return JSON.stringify(value); }
  catch { throw new ExactJsonError("structure"); }
}

// Bridge reserve for generated fields/envelopes, not a native maximum or a
// deliverability guarantee. Queue fixture list overhead is +8/+14/+86 bytes
// versus add; 4 KiB also covers 200-character escaped IDs and goal accounting.
// Native schema leaves generated IDs/cursors and future fields unbounded.
export const MUTATION_DELIVERY_RESERVE_BYTES = 4 * 1024;

export function preflightEcho(value: unknown, maxBytes: number, domain: "goal" | "queue"): void {
  if (Buffer.byteLength(encodeExactJson(value), "utf8") + MUTATION_DELIVERY_RESERVE_BYTES > maxBytes) {
    throw new Error(`${domain}_input_too_large: known echoed fields exceed the defensive delivery byte budget; no native mutation was sent`);
  }
}
