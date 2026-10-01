// This checks only the structural vocabulary emitted in compact-descriptors.ts.
// It does not accept arbitrary JSON Schema or decide compact projection semantics.
export type CompactShape = boolean | {
  $ref?: string;
  type?: string | string[];
  enum?: unknown[];
  oneOf?: CompactShape[];
  anyOf?: CompactShape[];
  allOf?: CompactShape[];
  items?: CompactShape;
  required?: string[];
  properties?: Record<string, CompactShape>;
  additionalProperties?: CompactShape;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  pattern?: string;
  format?: string;
};

export interface CompactDescriptorBundle {
  methods: Record<string, CompactShape>;
  definitions: Record<string, CompactShape>;
}

const MAX_SHAPE_VISITS = 200_000;
const MAX_SHAPE_DEPTH = 100;

export function matchesCompactShape(bundle: CompactDescriptorBundle, method: string, value: unknown): boolean {
  const root = bundle.methods[method];
  if (root === undefined) return false;
  let visits = 0;
  const matches = (shape: CompactShape, candidate: unknown, depth: number): boolean => {
    if (++visits > MAX_SHAPE_VISITS || depth > MAX_SHAPE_DEPTH) return false;
    if (typeof shape === "boolean") return shape;
    if (shape.$ref) {
      const name = shape.$ref.slice("#/definitions/".length);
      const target = bundle.definitions[name];
      if (target === undefined || !matches(target, candidate, depth + 1)) return false;
    }
    const types = shape.type === undefined ? [] : Array.isArray(shape.type) ? shape.type : [shape.type];
    if (types.length && !types.some((type) => {
      switch (type) {
        case "null": return candidate === null;
        case "object": return candidate !== null && typeof candidate === "object" && !Array.isArray(candidate);
        case "array": return Array.isArray(candidate);
        case "integer": return typeof candidate === "number" && Number.isInteger(candidate);
        case "number": return typeof candidate === "number" && Number.isFinite(candidate);
        case "string": case "boolean": return typeof candidate === type;
        default: return false;
      }
    })) return false;
    if (shape.enum && !shape.enum.some((allowed) => Object.is(allowed, candidate))) return false;
    if (shape.allOf && !shape.allOf.every((branch) => matches(branch, candidate, depth + 1))) return false;
    if (shape.anyOf && !shape.anyOf.some((branch) => matches(branch, candidate, depth + 1))) return false;
    // Current generated oneOf unions use discriminants. At least one matching
    // branch is sufficient for the compact shape membrane's structural purpose.
    if (shape.oneOf && !shape.oneOf.some((branch) => matches(branch, candidate, depth + 1))) return false;
    if (typeof candidate === "number") {
      if (shape.minimum !== undefined && candidate < shape.minimum) return false;
      if (shape.maximum !== undefined && candidate > shape.maximum) return false;
    }
    if (typeof candidate === "string") {
      if (shape.minLength !== undefined && candidate.length < shape.minLength) return false;
      if (shape.maxLength !== undefined && candidate.length > shape.maxLength) return false;
      if (shape.pattern !== undefined && !new RegExp(shape.pattern).test(candidate)) return false;
    }
    if (Array.isArray(candidate)) {
      if (shape.minItems !== undefined && candidate.length < shape.minItems) return false;
      if (shape.maxItems !== undefined && candidate.length > shape.maxItems) return false;
      if (shape.items !== undefined && !candidate.every((entry) => matches(shape.items!, entry, depth + 1))) return false;
    }
    if (candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)) {
      const object = candidate as Record<string, unknown>;
      if (shape.required?.some((key) => !Object.hasOwn(object, key))) return false;
      for (const [key, child] of Object.entries(shape.properties ?? {})) {
        if (Object.hasOwn(object, key) && !matches(child, object[key], depth + 1)) return false;
      }
      if (shape.additionalProperties !== undefined) {
        for (const [key, entry] of Object.entries(object)) {
          if (!Object.hasOwn(shape.properties ?? {}, key) && !matches(shape.additionalProperties, entry, depth + 1)) return false;
        }
      }
    }
    return true;
  };
  return matches(root, value, 0);
}
