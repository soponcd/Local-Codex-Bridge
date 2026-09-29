import { redactText, isSecretKey } from "./redaction.js";
export { redactText } from "./redaction.js";
export type RpcId = string | number;

export const MAX_OBSERVE_WAIT_MS = 120_000;
export const MAX_STREAMED_AGENT_TEXT_CHARS = 48_000;

import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import type {
  UxCounts,
  UxProjectionSink,
  UxSignalInput,
} from "./ux-projection.js";
import { COMPACT_DRAIN_CEILING, COMPACT_DRAIN_CHUNK, CompactAccumulator, prepareCompactRoute, type Route } from "./observe-compact.js";

// The digest is the only plan dedup state retained by a thread runtime.
export function compactPlanSignatureFor(plan: readonly { step: string; status: string }[]): string {
  const hash = createHash("sha256");
  for (const step of plan) hash.update(JSON.stringify([step.step, step.status]));
  return hash.digest("hex");
}

export type EventCategory =
  | "agent"
  | "approval"
  | "command"
  | "file"
  | "status"
  | "event";

export interface RuntimeEvent {
  cursor: number;
  at: string;
  method: string;
  category: EventCategory;
  turn_id?: string;
  data: unknown;
  // Non-enumerable ingestion metadata; raw event JSON remains unchanged.
  compactPlanChanged?: boolean;
  compactSettingsChanged?: boolean;
  compactBoundaryChanged?: boolean;
  compactRoute?: Route;
  streamDelta?: boolean;
}

export interface PendingServerRequest {
  rawId: RpcId;
  method: string;
  threadId: string;
  turnId?: string;
  params: unknown;
  receivedAt: string;
}

export type ServerRequestRecordResult =
  | "recorded"
  | "threadless"
  | "duplicate";

export type LateMutationSuccess =
  | {
      method: "thread/start" | "thread/resume";
      threadId: string;
      timedOutAt: string;
    }
  | {
      method: "turn/start";
      threadId: string;
      turnId: string;
      status?: string;
      timedOutAt: string;
    }
  | {
      method: "turn/steer" | "turn/interrupt";
      threadId: string;
      turnId: string;
      timedOutAt: string;
    };

export interface LateMutationError {
  method: "thread/resume" | "turn/start" | "turn/steer" | "turn/interrupt";
  threadId: string;
  turnId?: string;
  timedOutAt: string;
  error: unknown;
}

export interface FinalResultMetadata {
  complete: boolean;
  source_complete: boolean;
  truncated: boolean;
  observed_chars: number;
  retained_chars: number;
  retained: "head" | "tail";
}
interface AgentTextMetadata {
  itemId: string | null;
  sourceComplete: boolean;
  truncated: boolean;
  observedChars: number;
  retained: "head" | "tail";
}
function emptyAgentTextMetadata(itemId: string | null = null): AgentTextMetadata {
  return { itemId, sourceComplete: false, truncated: false, observedChars: 0, retained: "head" };
}
interface MessageDelivery { cursor: number; complete: boolean; digest: string }
function textDigest(text: string): string { return createHash("sha256").update(text).digest("hex"); }

export interface TerminalSnapshot {
  turn_id: string;
  status: string;
  completed_at: string;
  final_result: string | null;
  final_result_meta?: FinalResultMetadata;
  error: unknown | null;
  turn: unknown;
}

interface ThreadRuntime {
  threadId: string;
  activeTurnId: string | null;
  status: string;
  revision: number;
  nextCursor: number;
  events: RuntimeEvent[];
  lastDroppedStream: number;
  lastDroppedFact: number;
  terminal: TerminalSnapshot | null;
  agentText: string;
  agentTextMetadata: AgentTextMetadata;
  compactPlanSignature: string | null;
  compactSettingsSignature: string | null;
  compactBoundarySignature: string | null;
  agentMessageCursors: Map<string, MessageDelivery>;
  finalMessageDelivery: MessageDelivery | null;
  finalMessageItemId: string | null;
  terminalCursor: number | null;
}

export interface RuntimeObservation {
  runtime_available: true;
  runtime_status: string;
  active_turn_id: string | null;
  events: RuntimeEvent[];
  next_cursor: number;
  current_cursor: number;
  cursor_floor: number;
  cursor_lost: boolean;
  stream_lost: boolean;
  facts_lost: boolean;
  has_more: boolean;
  pending_requests: unknown[];
  terminal: TerminalSnapshot | null;
}

export interface RuntimeNoChangeObservation {
  runtime_available: true;
  runtime_status: string;
  active_turn_id: string;
  next_cursor: number;
  no_change: true;
}

interface SanitizeOptions {
  maxStringChars: number;
  maxDepth: number;
  maxArrayItems: number;
  maxObjectKeys: number;
  totalCharBudget: number;
}

const DEFAULT_SANITIZE: SanitizeOptions = {
  maxStringChars: 12_000,
  maxDepth: 8,
  maxArrayItems: 50,
  maxObjectKeys: 60,
  totalCharBudget: 150_000,
};

const EVENT_SANITIZE: SanitizeOptions = {
  maxStringChars: 8_000,
  maxDepth: 7,
  maxArrayItems: 40,
  maxObjectKeys: 50,
  totalCharBudget: 64_000,
};

// Retention eligibility is independent of compact wake/activity policy. Only
// these pure streaming methods with a valid ORIGINAL native shape may borrow
// fact capacity. New methods and all other notifications conservatively use F.
const STREAM_DELTA_METHODS = new Set([
  "item/agentMessage/delta", "item/plan/delta",
  "item/commandExecution/outputDelta", "item/fileChange/outputDelta",
  "item/reasoning/summaryTextDelta", "item/reasoning/textDelta",
  "command/exec/outputDelta", "process/outputDelta",
]);

export function stringHead(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  let end = maxChars;
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return value.slice(0, end);
}

function truncateString(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const prefix = stringHead(value, maxChars);
  return `${prefix}… [truncated ${value.length - prefix.length} chars]`;
}

export function stringTail(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  let start = value.length - maxChars;
  const first = value.charCodeAt(start);
  if (first >= 0xdc00 && first <= 0xdfff) {
    start += 1;
  }
  return value.slice(start);
}

function appendStreamedAgentTextTail(current: string, delta: string): string {
  if (delta.length >= MAX_STREAMED_AGENT_TEXT_CHARS) {
    return stringTail(delta, MAX_STREAMED_AGENT_TEXT_CHARS);
  }
  const retainedCurrent = stringTail(
    current,
    MAX_STREAMED_AGENT_TEXT_CHARS - delta.length,
  );
  return retainedCurrent + delta;
}

function captureCompletedAgentText(runtime: ThreadRuntime, text: string, itemId: string | null): void {
  const redacted = redactText(text);
  runtime.agentText = stringHead(redacted, MAX_STREAMED_AGENT_TEXT_CHARS);
  runtime.agentTextMetadata = { itemId, sourceComplete: true, truncated: runtime.agentText.length < redacted.length,
    observedChars: text.length, retained: "head" };
}

function finalTextSnapshot(runtime: ThreadRuntime): Pick<TerminalSnapshot, "final_result" | "final_result_meta"> {
  const meta = runtime.agentTextMetadata;
  if (!runtime.agentText && !meta.sourceComplete && meta.observedChars === 0) return { final_result: null };
  const redacted = redactText(runtime.agentText);
  const text = meta.retained === "tail" ? stringTail(redacted, MAX_STREAMED_AGENT_TEXT_CHARS) : stringHead(redacted, MAX_STREAMED_AGENT_TEXT_CHARS);
  const truncated = meta.truncated || text.length < redacted.length;
  return { final_result: text, final_result_meta: {
    complete: meta.sourceComplete && !truncated, source_complete: meta.sourceComplete, truncated,
    observed_chars: meta.observedChars, retained_chars: text.length, retained: meta.retained,
  } };
}

export function sanitizeForTransport(
  value: unknown,
  overrides: Partial<SanitizeOptions> = {},
): unknown {
  const options: SanitizeOptions = { ...DEFAULT_SANITIZE, ...overrides };
  const budget = { remaining: options.totalCharBudget };
  const seen = new WeakSet<object>();

  const visit = (input: unknown, depth: number): unknown => {
    if (budget.remaining <= 0) {
      return "[TRUNCATED: transport budget exhausted]";
    }
    if (
      input === null ||
      typeof input === "boolean" ||
      typeof input === "number"
    ) {
      budget.remaining -= 8;
      return input;
    }
    if (typeof input === "string") {
      const output = truncateString(redactText(input), options.maxStringChars);
      budget.remaining -= output.length;
      return output;
    }
    if (typeof input === "bigint") {
      const output = input.toString();
      budget.remaining -= output.length;
      return output;
    }
    if (typeof input !== "object") {
      return String(input);
    }
    if (depth >= options.maxDepth) {
      return "[TRUNCATED: maximum depth reached]";
    }
    if (seen.has(input)) {
      return "[REDACTED: circular reference]";
    }
    seen.add(input);

    if (Array.isArray(input)) {
      const kept = input
        .slice(0, options.maxArrayItems)
        .map((item) => visit(item, depth + 1));
      if (input.length > options.maxArrayItems) {
        kept.push(`[TRUNCATED: ${input.length - options.maxArrayItems} items omitted]`);
      }
      return kept;
    }

    const output: Record<string, unknown> = {};
    const entries = Object.entries(input as Record<string, unknown>);
    for (const [key, child] of entries.slice(0, options.maxObjectKeys)) {
      budget.remaining -= key.length;
      output[key] = isSecretKey(key) ? "[REDACTED]" : visit(child, depth + 1);
      if (budget.remaining <= 0) {
        break;
      }
    }
    if (entries.length > options.maxObjectKeys) {
      output.__truncated_keys__ = entries.length - options.maxObjectKeys;
    }
    return output;
  };

  return visit(value, 0);
}

export function classifyEvent(method: string): EventCategory {
  const lower = method.toLowerCase();
  if (lower.includes("approval") || lower.includes("requestuserinput") || lower.includes("elicitation")) {
    return "approval";
  }
  if (lower.includes("command") || lower.includes("exec")) {
    return "command";
  }
  if (lower.includes("file") || lower.includes("patch") || lower.includes("diff")) {
    return "file";
  }
  if (lower.includes("agentmessage") || lower.includes("agent/message")) {
    return "agent";
  }
  if (lower.startsWith("turn/") || lower.startsWith("thread/") || lower === "error") {
    return "status";
  }
  return "event";
}

function idKey(id: RpcId): string {
  return `${typeof id}:${String(id)}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringField(record: Record<string, unknown> | null, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function extractThreadId(params: unknown): string | undefined {
  const record = asRecord(params);
  return (
    stringField(record, "threadId") ??
    stringField(record, "conversationId") ??
    stringField(asRecord(record?.thread), "id") ??
    stringField(asRecord(record?.turn), "threadId") ??
    stringField(asRecord(record?.item), "threadId")
  );
}

function extractTurnId(params: unknown): string | undefined {
  const record = asRecord(params);
  return (
    stringField(record, "turnId") ??
    stringField(asRecord(record?.turn), "id") ??
    stringField(asRecord(record?.item), "turnId")
  );
}

function extractAgentText(method: string, params: unknown): string | undefined {
  const record = asRecord(params);
  const item = asRecord(record?.item);
  if (method === "item/completed" && item?.type === "agentMessage" && typeof item.text === "string") {
    return item.text;
  }
  if (method === "item/agentMessage/delta" && typeof record?.delta === "string") {
    return record.delta;
  }
  return undefined;
}

function extractFinalFromTurn(params: unknown): { text: string; id: string | null } | undefined {
  const record = asRecord(params);
  const turn = asRecord(record?.turn);
  const items = turn?.items;
  if (!Array.isArray(items)) {
    return undefined;
  }
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = asRecord(items[index]);
    if (item?.type === "agentMessage" && typeof item.text === "string") {
      return { text: item.text, id: stringField(item, "id") ?? null };
    }
  }
  return undefined;
}

// Preserve the raw wait's pre-drainage wake timing. Raw pagination and replay
// must not inherit compact's new classification decisions.
function hasRawWake(observation: RuntimeObservation): boolean {
  return observation.events.some((event) => {
    const data = asRecord(event.data);
    if (!data) return true;
    const scopedStream = typeof data.threadId === "string" && typeof data.turnId === "string" && typeof data.itemId === "string";
    if (["item/agentMessage/delta", "item/plan/delta", "item/commandExecution/outputDelta", "item/fileChange/outputDelta"].includes(event.method)) {
      return !(scopedStream && typeof data.delta === "string");
    }
    if (event.method === "item/mcpToolCall/progress") return !(scopedStream && typeof data.message === "string");
    if (event.method === "thread/tokenUsage/updated") {
      const usage = asRecord(data.tokenUsage);
      const valid = (value: unknown): boolean => {
        const part = asRecord(value);
        return !!part && ["cachedInputTokens", "inputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens"].every((key) => Number.isInteger(part[key]));
      };
      return !(typeof data.threadId === "string" && typeof data.turnId === "string" && usage && valid(usage.last) && valid(usage.total));
    }
    if (event.method === "turn/diff/updated") return !(typeof data.threadId === "string" && typeof data.turnId === "string" && typeof data.diff === "string");
    if (event.method === "mcpServer/startupStatus/updated") return typeof data.name !== "string" ||
      !["starting", "ready", "failed", "cancelled"].includes(String(data.status)) ||
      data.status === "failed" || data.status === "cancelled" || typeof data.error === "string" ||
      data.failureReason === "reauthenticationRequired";
    if (event.method === "turn/started") return !(typeof data.threadId === "string" && typeof asRecord(data.turn)?.id === "string" && asRecord(data.turn)?.status === "inProgress");
    if (event.method === "thread/status/changed") {
      const status = asRecord(data.status);
      return !(typeof data.threadId === "string" && status?.type === "active" && Array.isArray(status.activeFlags) && status.activeFlags.length === 0);
    }
    if (event.method === "serverRequest/resolved") return !(typeof data.threadId === "string" && (typeof data.requestId === "string" || typeof data.requestId === "number"));
    if (event.method === "item/started" || event.method === "item/completed") {
      const item = asRecord(data.item);
      const complete = event.method === "item/completed";
      if (!item || typeof item.id !== "string" || typeof data.threadId !== "string" || typeof data.turnId !== "string" ||
          !Number.isInteger(data[complete ? "completedAtMs" : "startedAtMs"])) return true;
      if (item.type === "agentMessage") return typeof item.text !== "string" || complete;
      if (item.type === "reasoning") return false;
      if (item.type === "userMessage") return !Array.isArray(item.content);
      if (item.type === "commandExecution") {
        if (typeof item.command !== "string" || typeof item.cwd !== "string" || !Array.isArray(item.commandActions) ||
            !["inProgress", "completed", "failed", "declined"].includes(String(item.status)) ||
            (complete ? item.status === "inProgress" : item.status !== "inProgress")) return true;
        return complete && (item.status === "failed" || item.status === "declined" || (typeof item.exitCode === "number" && item.exitCode !== 0));
      }
      if (item.type === "fileChange" || item.type === "mcpToolCall" || item.type === "dynamicToolCall") {
        const shape = item.type === "fileChange" ? Array.isArray(item.changes) :
          item.type === "mcpToolCall" ? typeof item.server === "string" && typeof item.tool === "string" && "arguments" in item :
            typeof item.tool === "string" && "arguments" in item;
        const states = item.type === "fileChange" ? ["inProgress", "completed", "failed", "declined"] : ["inProgress", "completed", "failed"];
        if (!shape || !states.includes(String(item.status)) || (complete ? item.status === "inProgress" : item.status !== "inProgress")) return true;
        return complete && (item.status === "failed" || item.status === "declined" || item.success === false || item.error != null);
      }
      return true;
    }
    return true;
  });
}

export class RuntimeStore {
  #uxFailureReported = false;
  readonly #threads = new Map<string, ThreadRuntime>();
  readonly #pending = new Map<string, PendingServerRequest>();
  readonly #responding = new Map<string, PendingServerRequest>();
  readonly #turnToThread = new Map<string, string>();
  readonly #changeWaiters = new Map<string, Set<() => void>>();

  constructor(
    private readonly ringLimit = 256,
    private readonly uxProjection?: UxProjectionSink,
  ) {
    if (!Number.isInteger(ringLimit) || ringLimit < 2) {
      throw new Error("ringLimit must be an integer of at least 2");
    }
    this.#publishUx();
  }

  hasThread(threadId: string): boolean {
    return this.#threads.has(threadId);
  }

  currentCursor(threadId: string): number {
    return (this.#threads.get(threadId)?.nextCursor ?? 1) - 1;
  }

  ensureThread(threadId: string): void {
    if (!this.#threads.has(threadId)) {
      this.#threads.set(threadId, {
        threadId,
        activeTurnId: null,
        status: "idle",
        revision: 0,
        nextCursor: 1,
        events: [],
        lastDroppedStream: 0,
        lastDroppedFact: 0,
        terminal: null,
        agentText: "",
        agentTextMetadata: emptyAgentTextMetadata(),
        compactPlanSignature: null,
        compactSettingsSignature: null,
        compactBoundarySignature: null,
        agentMessageCursors: new Map(),
        finalMessageDelivery: null,
        finalMessageItemId: null,
        terminalCursor: null,
      });
    }
  }

  markTurnAccepted(threadId: string, turnId: string): void {
    this.ensureThread(threadId);
    const runtime = this.#threads.get(threadId)!;
    if (runtime.terminal?.turn_id === turnId) {
      return;
    }
    runtime.activeTurnId = turnId;
    runtime.status = "inProgress";
    runtime.terminal = null;
    runtime.agentText = "";
    runtime.agentTextMetadata = emptyAgentTextMetadata();
    runtime.compactPlanSignature = null;
    runtime.agentMessageCursors.clear();
    runtime.finalMessageDelivery = null;
    runtime.finalMessageItemId = null;
    runtime.terminalCursor = null;
    this.#turnToThread.set(turnId, threadId);
    this.#signalChange(runtime);
    this.#publishUx();
  }

  reconcileLateMutationSuccess(input: LateMutationSuccess): void {
    this.ensureThread(input.threadId);
    const runtime = this.#threads.get(input.threadId)!;

    if (!("turnId" in input)) {
      this.#appendEvent(
        runtime,
        "appServer/lateResponseReconciled",
        {
          request_method: input.method,
          action: "thread_observed",
          reason: "late_success",
          thread_id: input.threadId,
          timed_out_at: input.timedOutAt,
        },
        undefined,
      );
      return;
    }

    if (input.method !== "turn/start") {
      this.#appendEvent(
        runtime,
        "appServer/lateResponseReconciled",
        {
          request_method: input.method,
          action: "state_preserved",
          reason: "late_success_no_lifecycle_change",
          thread_id: input.threadId,
          turn_id: input.turnId,
          timed_out_at: input.timedOutAt,
        },
        input.turnId,
      );
      return;
    }

    let action = "state_preserved";
    let reason: string;
    if (runtime.terminal?.turn_id === input.turnId) {
      reason = "terminal_present";
    } else if (runtime.activeTurnId === input.turnId) {
      reason = "turn_already_active";
    } else if (runtime.activeTurnId !== null) {
      reason = "different_turn_active";
    } else if (runtime.terminal !== null) {
      const terminalAt = Date.parse(runtime.terminal.completed_at);
      const timedOutAt = Date.parse(input.timedOutAt);
      if (
        !Number.isFinite(terminalAt) ||
        !Number.isFinite(timedOutAt) ||
        terminalAt >= timedOutAt
      ) {
        reason = "newer_terminal_present";
      } else if (input.status !== undefined && input.status !== "inProgress") {
        reason = "non_active_result_status";
      } else {
        runtime.activeTurnId = input.turnId;
        runtime.status = "inProgress";
        runtime.terminal = null;
        runtime.agentText = "";
        runtime.agentTextMetadata = emptyAgentTextMetadata();
        this.#turnToThread.set(input.turnId, input.threadId);
        action = "turn_activated";
        reason = "runtime_idle";
      }
    } else if (input.status !== undefined && input.status !== "inProgress") {
      reason = "non_active_result_status";
    } else {
      runtime.activeTurnId = input.turnId;
      runtime.status = "inProgress";
      runtime.terminal = null;
      runtime.agentText = "";
      runtime.agentTextMetadata = emptyAgentTextMetadata();
      this.#turnToThread.set(input.turnId, input.threadId);
      action = "turn_activated";
      reason = "runtime_idle";
    }

    if (action === "turn_activated") {
      runtime.compactPlanSignature = null;
      runtime.agentMessageCursors.clear();
      runtime.finalMessageDelivery = null;
      runtime.finalMessageItemId = null;
      runtime.terminalCursor = null;
    }
    this.#appendEvent(
      runtime,
      "appServer/lateResponseReconciled",
      {
        request_method: input.method,
        action,
        reason,
        thread_id: input.threadId,
        turn_id: input.turnId,
        timed_out_at: input.timedOutAt,
      },
      input.turnId,
    );
    if (action === "turn_activated") {
      this.#publishUx();
    }
  }

  recordLateMutationError(input: LateMutationError): void {
    this.ensureThread(input.threadId);
    const runtime = this.#threads.get(input.threadId)!;
    this.#appendEvent(
      runtime,
      "appServer/lateResponseReconciled",
      {
        request_method: input.method,
        action: "state_preserved",
        reason: "late_error",
        thread_id: input.threadId,
        ...(input.turnId ? { turn_id: input.turnId } : {}),
        timed_out_at: input.timedOutAt,
        error: input.error,
      },
      input.turnId,
    );
  }

  recordNotification(method: string, params: unknown): void {
    const turnId = extractTurnId(params);
    const threadId = extractThreadId(params) ?? (turnId ? this.#turnToThread.get(turnId) : undefined);

    if (method === "serverRequest/resolved") {
      const requestId = asRecord(params)?.requestId;
      if (typeof requestId === "string" || typeof requestId === "number") {
        const key = idKey(requestId);
        const pending = this.#pending.get(key);
        this.#pending.delete(key);
        if (pending && this.#responding.get(key) === pending) {
          this.#responding.delete(key);
        }
        const runtime = pending ? this.#threads.get(pending.threadId) : undefined;
        if (runtime) {
          this.#signalChange(runtime);
        }
        this.#publishUx();
      }
    }
    if (!threadId) {
      // Connection-scoped notifications, including warnings and unknown
      // methods, have no native thread target. Let active supervisors see
      // them without inventing a native turn scope or a global event store.
      for (const active of this.#threads.values()) {
        if (active.activeTurnId !== null) {
          this.#appendEvent(active, method, params, undefined);
        }
      }
      return;
    }

    this.ensureThread(threadId);
    const runtime = this.#threads.get(threadId)!;
    if (method === "turn/started" && turnId) {
      runtime.activeTurnId = turnId;
      runtime.status = "inProgress";
      runtime.terminal = null;
      runtime.agentText = "";
      runtime.agentTextMetadata = emptyAgentTextMetadata();
      runtime.compactPlanSignature = null;
      runtime.agentMessageCursors.clear();
      runtime.finalMessageDelivery = null;
      runtime.finalMessageItemId = null;
      runtime.terminalCursor = null;
      this.#turnToThread.set(turnId, threadId);
    }

    const notification = asRecord(params);
    const agentItem = asRecord(notification?.item);
    const agentText = extractAgentText(method, params);
    const itemId = method === "item/agentMessage/delta"
      ? stringField(notification, "itemId") : stringField(agentItem, "id");
    // A start or empty delta carries no replacement text. Switch identity only
    // for actual text or an authoritative completion (which may be empty).
    if (agentText !== undefined && (method !== "item/agentMessage/delta" || agentText.length > 0)) {
      // Never join a completed commentary with a different message's partial final.
      if (itemId !== undefined && itemId !== runtime.agentTextMetadata.itemId) {
        runtime.agentText = "";
        runtime.agentTextMetadata = emptyAgentTextMetadata(itemId);
      }
      if (method === "item/agentMessage/delta") {
        const before = runtime.agentText.length;
        runtime.agentText = appendStreamedAgentTextTail(runtime.agentText, agentText);
        const meta = runtime.agentTextMetadata;
        meta.sourceComplete = false;
        meta.retained = "tail";
        meta.observedChars = Math.min(Number.MAX_SAFE_INTEGER, meta.observedChars + agentText.length);
        meta.truncated ||= before + agentText.length > runtime.agentText.length;
      } else {
        captureCompletedAgentText(runtime, agentText, itemId ?? null);
      }
    }

    if (method === "turn/completed") {
      const turn = asRecord(asRecord(params)?.turn);
      const terminalTurnId = stringField(turn, "id") ?? turnId ?? runtime.activeTurnId;
      if (terminalTurnId) {
        const status = stringField(turn, "status") ?? "unknown";
        const error = turn?.error ?? null;
        const final = extractFinalFromTurn(params);
        if (final) captureCompletedAgentText(runtime, final.text, final.id);
        runtime.status = status;
        runtime.activeTurnId = null;
        runtime.compactPlanSignature = null;
        runtime.terminal = {
          turn_id: terminalTurnId,
          status,
          completed_at: new Date().toISOString(),
          ...finalTextSnapshot(runtime),
          error: sanitizeForTransport(error),
          turn: sanitizeForTransport(turn),
        };
        this.#turnToThread.delete(terminalTurnId);
        this.clearPendingForThread(threadId, terminalTurnId);
        this.#publishUx({
          kind: "terminal",
          thread_id: threadId,
          turn_id: terminalTurnId,
          status,
        });
      }
    } else if (method === "thread/status/changed") {
      const status = asRecord(params)?.status;
      runtime.status =
        typeof status === "string"
          ? status
          : stringField(asRecord(status), "type") ?? runtime.status;
    }

    const appendedCursor = this.#appendEvent(runtime, method, params, turnId);
    if (method === "item/completed" && runtime.events.at(-1)?.compactRoute?.fact?.type === "message") {
      const completedItem = asRecord(asRecord(params)?.item);
      if (completedItem?.type === "agentMessage" && typeof completedItem.id === "string") {
        const fact = runtime.events.at(-1)!.compactRoute!.fact!;
        const text = redactText(completedItem.text as string);
        const delivery = { cursor: appendedCursor, digest: textDigest(text),
          complete: fact.text === text && !fact.text_truncation && !fact.projection_truncated };
        runtime.agentMessageCursors.set(completedItem.id, delivery);
        if (runtime.agentMessageCursors.size > this.ringLimit) {
          runtime.agentMessageCursors.delete(runtime.agentMessageCursors.keys().next().value!);
        }
        if (completedItem.phase === "final_answer") {
          runtime.finalMessageDelivery = delivery;
          runtime.finalMessageItemId = completedItem.id;
        }
      }
    }
    if (method === "turn/completed") {
      runtime.terminalCursor = appendedCursor;
      const id = runtime.agentTextMetadata.itemId;
      const delivery = id === null ? null : runtime.agentMessageCursors.get(id) ??
        (id === runtime.finalMessageItemId ? runtime.finalMessageDelivery : null);
      runtime.finalMessageDelivery = delivery ?? null;
      runtime.finalMessageItemId = id;
    }
  }

  recordServerRequest(
    id: RpcId,
    method: string,
    params: unknown,
  ): ServerRequestRecordResult {
    const key = idKey(id);
    if (this.#pending.has(key)) {
      return "duplicate";
    }
    const extractedTurnId = extractTurnId(params);
    const threadId = extractThreadId(params) ?? (extractedTurnId ? this.#turnToThread.get(extractedTurnId) : undefined);
    if (!threadId) {
      for (const active of this.#threads.values()) {
        if (active.activeTurnId !== null) {
          this.#appendEvent(active, "appServer/unscopedRequest", {
            request_id: id,
            native_method: method,
            params,
          }, undefined);
        }
      }
      return "threadless";
    }
    this.ensureThread(threadId);
    const turnId = extractedTurnId ?? this.#threads.get(threadId)?.activeTurnId ?? undefined;
    const request: PendingServerRequest = {
      rawId: id,
      method,
      threadId,
      params: sanitizeForTransport(params, EVENT_SANITIZE),
      receivedAt: new Date().toISOString(),
      ...(turnId ? { turnId } : {}),
    };
    this.#pending.set(key, request);
    this.#appendEvent(
      this.#threads.get(threadId)!,
      method,
      { request_id: id, params: request.params },
      turnId,
    );
    this.#publishUx({
      kind: method === "item/tool/requestUserInput" || method.toLowerCase().includes("elicitation")
        ? "waiting_user_input"
        : "waiting_approval",
      thread_id: threadId,
      turn_id: turnId ?? null,
      status: "waiting",
    });
    return "recorded";
  }

  claimPending(
    id: RpcId,
    expected: { threadId: string; method: string; turnId?: string },
  ): PendingServerRequest {
    const key = idKey(id);
    const request = this.#pending.get(key);
    if (!request) {
      throw new Error(`No pending app-server request with raw id ${JSON.stringify(id)}`);
    }
    if (request.threadId !== expected.threadId || request.method !== expected.method) {
      throw new Error("Pending request scope does not match thread_id and method");
    }
    if (expected.turnId !== undefined && request.turnId !== expected.turnId) {
      throw new Error("Pending request scope does not match turn_id");
    }
    if (this.#responding.has(key)) {
      throw new Error("Pending app-server request is already being answered");
    }
    this.#responding.set(key, request);
    return request;
  }

  completePending(request: PendingServerRequest): void {
    const key = idKey(request.rawId);
    if (
      this.#pending.get(key) !== request ||
      this.#responding.get(key) !== request
    ) {
      return;
    }
    this.#pending.delete(key);
    this.#responding.delete(key);
    const runtime = this.#threads.get(request.threadId);
    if (runtime) {
      this.#signalChange(runtime);
    }
    this.#publishUx();
  }

  releasePending(request: PendingServerRequest): void {
    const key = idKey(request.rawId);
    if (this.#responding.get(key) === request) {
      this.#responding.delete(key);
    }
  }

  markAppServerExited(message: string): void {
    const at = new Date().toISOString();
    for (const runtime of this.#threads.values()) {
      if (runtime.activeTurnId) {
        const turnId = runtime.activeTurnId;
        runtime.status = "appServerExited";
        runtime.activeTurnId = null;
        runtime.compactPlanSignature = null;
        runtime.terminal = {
          turn_id: turnId,
          status: "appServerExited",
          completed_at: at,
          ...finalTextSnapshot(runtime),
          error: { message: redactText(message) },
          turn: null,
        };
        runtime.terminalCursor = this.#appendEvent(runtime, "appServer/exited", { message }, turnId);
        this.#publishUx({
          kind: "terminal",
          thread_id: runtime.threadId,
          turn_id: turnId,
          status: "appServerExited",
        });
      }
    }
    const pendingThreadIds = new Set([...this.#pending.values()].map((request) => request.threadId));
    this.#pending.clear();
    this.#responding.clear();
    for (const threadId of pendingThreadIds) {
      const runtime = this.#threads.get(threadId);
      if (runtime) {
        this.#signalChange(runtime);
      }
    }
    this.#publishUx();
  }

  observe(
    threadId: string,
    cursor: number | undefined,
    limit: number,
  ): RuntimeObservation | null {
    const runtime = this.#threads.get(threadId);
    if (!runtime) {
      return null;
    }
    const current = runtime.nextCursor - 1;
    const firstAvailable = runtime.events[0]?.cursor ?? runtime.nextCursor;
    const requested = cursor ?? firstAvailable - 1;
    const streamLost = runtime.lastDroppedStream > requested;
    const factsLost = runtime.lastDroppedFact > requested;
    // Loss describes the entire unread (requested, current] interval, including
    // gaps after this page. Never skip retained records by replacing the cursor
    // with a loss watermark or the (potentially sparse) ring's floor.
    const available = runtime.events.filter((event) => event.cursor > requested);
    const events = available.slice(0, limit);
    const nextCursor = events.at(-1)?.cursor ?? Math.min(Math.max(requested, 0), current);
    return {
      runtime_available: true,
      runtime_status: runtime.status,
      active_turn_id: runtime.activeTurnId,
      events,
      next_cursor: nextCursor,
      current_cursor: current,
      cursor_floor: Math.max(0, firstAvailable - 1),
      cursor_lost: streamLost || factsLost,
      stream_lost: streamLost,
      facts_lost: factsLost,
      has_more: available.length > events.length,
      pending_requests: this.pendingForThread(threadId),
      terminal: runtime.terminal,
    };
  }

  async observeWithWait(
    threadId: string,
    cursor: number | undefined,
    limit: number,
    waitMs: number,
    signal?: AbortSignal,
  ): Promise<RuntimeObservation | RuntimeNoChangeObservation | null> {
    if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > MAX_OBSERVE_WAIT_MS) {
      throw new Error(`wait_ms must be an integer from 0 to ${MAX_OBSERVE_WAIT_MS}`);
    }
    const runtime = this.#threads.get(threadId);
    if (!runtime) {
      return null;
    }
    const startedRevision = runtime.revision;
    const deadline = performance.now() + waitMs;
    while (true) {
      const revision = runtime.revision;
      const snapshot = this.observe(threadId, cursor, limit);
      if (snapshot === null || waitMs === 0 || snapshot.pending_requests.length > 0 ||
          snapshot.terminal !== null || snapshot.cursor_lost || snapshot.active_turn_id === null ||
          snapshot.has_more || snapshot.events.length >= limit || hasRawWake(snapshot)) {
        return snapshot;
      }
      if (performance.now() >= deadline) {
        if (snapshot.events.length === 0 && runtime.revision === startedRevision) {
          return {
            runtime_available: true,
            runtime_status: snapshot.runtime_status,
            active_turn_id: snapshot.active_turn_id,
            next_cursor: snapshot.next_cursor,
            no_change: true,
          };
        }
        return snapshot;
      }
      await this.#waitForChange(runtime, revision, deadline, signal);
      if (signal?.aborted) return this.observe(threadId, cursor, limit);
      // A revision without native events can carry a status or pending-request
      // transition. Return it rather than presenting true silence.
      if (runtime.revision !== revision && runtime.nextCursor - 1 === (snapshot.current_cursor ?? 0)) {
        return this.observe(threadId, cursor, limit);
      }
    }
  }

  async observeCompactWithWait(
    threadId: string,
    cursor: number | undefined,
    factLimit: number,
    waitMs: number,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown> | RuntimeNoChangeObservation | null> {
    if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > MAX_OBSERVE_WAIT_MS) {
      throw new Error(`wait_ms must be an integer from 0 to ${MAX_OBSERVE_WAIT_MS}`);
    }
    const runtime = this.#threads.get(threadId);
    if (!runtime) return null;
    const startedRevision = runtime.revision;
    const deadline = performance.now() + waitMs;
    const initial = this.observe(threadId, cursor, COMPACT_DRAIN_CHUNK)!;
    let streamLost = initial.stream_lost;
    let factsLost = initial.facts_lost;
    let cursorFloor = initial.cursor_floor;
    const requested = cursor ?? initial.cursor_floor;
    const scan = new CompactAccumulator(requested, factLimit, {
      threadId, ...(runtime.activeTurnId ? { activeTurnId: runtime.activeTurnId } : {}),
    }, Math.min(requested, initial.current_cursor));
    const finalIdentity = () => {
      const delivery = runtime.finalMessageDelivery;
      return {
        itemCursor: delivery?.cursor ?? null,
        itemComplete: delivery?.complete === true && runtime.terminal?.final_result_meta?.complete === true &&
          delivery.digest === textDigest(runtime.terminal.final_result ?? ""),
        terminalCursor: runtime.terminalCursor,
        turnId: runtime.terminal?.turn_id ?? null,
        itemEvicted: delivery !== null && delivery.cursor <= runtime.lastDroppedFact,
      };
    };
    let last = initial;
    const result = (more = false): Record<string, unknown> =>
      scan.result(last, finalIdentity(), more, streamLost, factsLost, cursorFloor);

    while (true) {
      const revision = runtime.revision;
      const snapshot = this.observe(threadId, scan.nextCursor, Math.min(COMPACT_DRAIN_CHUNK, COMPACT_DRAIN_CEILING - scan.scanned))!;
      last = snapshot;
      if (snapshot.cursor_lost) {
        streamLost ||= snapshot.stream_lost;
        factsLost ||= snapshot.facts_lost;
        cursorFloor = Math.max(cursorFloor, snapshot.cursor_floor);
      }
      for (let index = 0; index < snapshot.events.length; index += 1) {
        if (!scan.consume(snapshot.events[index]!)) return result(true);
        if (scan.wake) return result(runtime.nextCursor - 1 > scan.nextCursor);
        if (scan.scanned >= COMPACT_DRAIN_CEILING) {
          if (snapshot.has_more || index + 1 < snapshot.events.length || waitMs > 0) {
            scan.continuation = "drainage_yield";
            return result(true);
          }
          return result(false);
        }
      }
      if (snapshot.has_more) {
        if (waitMs > 0 && performance.now() >= deadline) return result(true);
        continue;
      }
      if (snapshot.pending_requests.length > 0 || snapshot.terminal !== null || snapshot.active_turn_id === null || factsLost || waitMs === 0 || performance.now() >= deadline) {
        if (scan.scanned === 0 && runtime.revision === startedRevision && snapshot.pending_requests.length === 0 && snapshot.terminal === null &&
            snapshot.active_turn_id !== null && !streamLost && !factsLost && waitMs > 0 && performance.now() >= deadline) {
          return {
            runtime_available: true,
            runtime_status: snapshot.runtime_status,
            active_turn_id: snapshot.active_turn_id,
            next_cursor: scan.nextCursor,
            no_change: true,
          };
        }
        return result(false);
      }
      await this.#waitForChange(runtime, revision, deadline, signal);
      if (signal?.aborted) return result(runtime.nextCursor - 1 > scan.nextCursor);
      if (runtime.revision !== revision && runtime.nextCursor - 1 === snapshot.current_cursor) {
        last = this.observe(threadId, scan.nextCursor, Math.min(COMPACT_DRAIN_CHUNK, COMPACT_DRAIN_CEILING - scan.scanned))!;
        return result(false);
      }
    }
  }

  pendingForThread(threadId: string): unknown[] {
    return [...this.#pending.values()]
      .filter((request) => request.threadId === threadId)
      .sort((left, right) => left.receivedAt.localeCompare(right.receivedAt))
      .map((request) => ({
        request_id: request.rawId,
        method: request.method,
        thread_id: request.threadId,
        turn_id: request.turnId ?? null,
        received_at: request.receivedAt,
        params: request.params,
      }));
  }

  clearPendingForThread(threadId: string, turnId?: string): void {
    let changed = false;
    for (const [key, request] of this.#pending) {
      if (request.threadId === threadId && (turnId === undefined || request.turnId === turnId)) {
        this.#pending.delete(key);
        if (this.#responding.get(key) === request) {
          this.#responding.delete(key);
        }
        changed = true;
      }
    }
    if (changed) {
      const runtime = this.#threads.get(threadId);
      if (runtime) {
        this.#signalChange(runtime);
      }
      this.#publishUx();
    }
  }

  closeUxProjection(): void {
    try { this.uxProjection?.close(); } catch { this.#reportUxFailure(); }
  }

  #publishUx(signal?: UxSignalInput): void {
    if (!this.uxProjection) {
      return;
    }
    const counts: UxCounts = { active: 0, waiting: this.#pending.size, terminal: 0 };
    for (const runtime of this.#threads.values()) {
      if (runtime.activeTurnId) {
        counts.active += 1;
      }
      if (runtime.terminal) {
        counts.terminal += 1;
      }
    }
    // Projection is optional. A later natural publish retries the full snapshot.
    try { this.uxProjection.publish(counts, signal); } catch { this.#reportUxFailure(); }
  }

  #reportUxFailure(): void {
    if (this.#uxFailureReported) return;
    this.#uxFailureReported = true;
    // Static text avoids leaking an I/O path or error payload. Diagnostics too
    // are best-effort and cannot alter native acknowledgement or lifecycle.
    try { console.error("[local-codex-bridge] Optional UX projection I/O failed; later natural publishes will retry."); } catch { /* diagnostic sink unavailable */ }
  }

  #appendEvent(
    runtime: ThreadRuntime,
    method: string,
    data: unknown,
    turnId: string | undefined,
  ): number {
    const event: RuntimeEvent = {
      cursor: runtime.nextCursor,
      at: new Date().toISOString(),
      method,
      category: classifyEvent(method),
      data,
      ...(turnId ? { turn_id: turnId } : {}),
    };
    let streamDelta = false;
    const compactRoute = prepareCompactRoute(event, () => {
    // Reuse the compact membrane's original-shape validation, before transport
    // sanitization. A cap signal carries a fact despite sharing a delta method.
    streamDelta = STREAM_DELTA_METHODS.has(method) && asRecord(data)?.capReached !== true;
    if (method === "turn/plan/updated") {
      const plan = asRecord(data)?.plan;
      if (Array.isArray(plan) && plan.every((step) => typeof asRecord(step)?.step === "string" && typeof asRecord(step)?.status === "string")) {
        const signature = compactPlanSignatureFor(plan.map((step) => ({ step: asRecord(step)!.step as string, status: asRecord(step)!.status as string })));
        Object.defineProperty(event, "compactPlanChanged", { value: signature !== runtime.compactPlanSignature });
        runtime.compactPlanSignature = signature;
      }
    }
    if (method === "thread/settings/updated") {
      const settings = asRecord(asRecord(data)?.threadSettings);
      if (settings) {
        const signature = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
        const boundary = signature([settings.approvalPolicy, settings.sandboxPolicy, settings.cwd, settings.activePermissionProfile, settings.approvalsReviewer]);
        const collaboration = asRecord(settings.collaborationMode);
        const modeSettings = asRecord(collaboration?.settings);
        const selected = signature([boundary, settings.model, settings.modelProvider, settings.effort, collaboration?.mode, modeSettings?.model, modeSettings?.reasoning_effort]);
        Object.defineProperty(event, "compactSettingsChanged", { value: selected !== runtime.compactSettingsSignature });
        Object.defineProperty(event, "compactBoundaryChanged", { value: boundary !== runtime.compactBoundarySignature });
        runtime.compactSettingsSignature = selected;
        runtime.compactBoundarySignature = boundary;
      }
    }
    });
    Object.defineProperty(event, "compactRoute", { value: compactRoute });
    Object.defineProperty(event, "streamDelta", { value: streamDelta });
    event.data = sanitizeForTransport(data, EVENT_SANITIZE);
    runtime.nextCursor += 1;
    const factCount = runtime.events.reduce((count, retained) => count + (retained.streamDelta ? 0 : 1), 0);
    const evictFact = !streamDelta && factCount >= this.ringLimit - 1;
    if (evictFact || runtime.events.length === this.ringLimit) {
      // Both classes are FIFO. F reserves R-1 records; the remaining position
      // keeps the latest D, while D borrows any otherwise unused positions.
      const index = runtime.events.findIndex((retained) => evictFact ? !retained.streamDelta : retained.streamDelta);
      const [dropped] = runtime.events.splice(index, 1);
      if (dropped!.streamDelta) runtime.lastDroppedStream = dropped!.cursor;
      else runtime.lastDroppedFact = dropped!.cursor;
    }
    runtime.events.push(event);
    this.#signalChange(runtime);
    return event.cursor;
  }

  #signalChange(runtime: ThreadRuntime): void {
    runtime.revision += 1;
    const waiters = this.#changeWaiters.get(runtime.threadId);
    if (!waiters) {
      return;
    }
    this.#changeWaiters.delete(runtime.threadId);
    for (const finish of waiters) {
      finish();
    }
  }

  async #waitForChange(
    runtime: ThreadRuntime,
    afterRevision: number,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<void> {
    await new Promise<void>((resolve) => {
      let settled = false;
      let deadlineTimer: NodeJS.Timeout | undefined;
      const finish = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (deadlineTimer) clearTimeout(deadlineTimer);
        signal?.removeEventListener("abort", onAbort);
        const waiters = this.#changeWaiters.get(runtime.threadId);
        waiters?.delete(finish);
        if (waiters?.size === 0) {
          this.#changeWaiters.delete(runtime.threadId);
        }
        resolve();
      };
      const onAbort = (): void => finish();
      if (signal?.aborted || performance.now() >= deadline) {
        resolve();
        return;
      }
      const waiters = this.#changeWaiters.get(runtime.threadId) ?? new Set<() => void>();
      waiters.add(finish);
      this.#changeWaiters.set(runtime.threadId, waiters);
      signal?.addEventListener("abort", onAbort, { once: true });
      // Every revision waits only for the remaining time of this call.
      deadlineTimer = setTimeout(finish, Math.max(0, deadline - performance.now()));
      deadlineTimer.unref();
      if (runtime.revision !== afterRevision || signal?.aborted || performance.now() >= deadline) {
        finish();
      }
    });
  }
}
