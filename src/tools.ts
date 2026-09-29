import { preflightEcho } from "./exact-json.js";
import { AppServerManager } from "./app-server.js";
import {
  CHECKPOINT_TEXT_LIMIT,
  CHECKPOINT_THREAD_ID_LIMIT,
  CheckpointStore,
} from "./checkpoint.js";
import {
  MAX_OBSERVE_WAIT_MS,
  sanitizeForTransport,
  type RpcId,
} from "./runtime.js";
import { platformPolicyFor, type PlatformPolicy } from "./platform.js";
import { exactHistoryResponse, validateHistoryPage } from "./history.js";
import { exactGoalResponse, MAX_GOAL_RESULT_BYTES, GOAL_STATUSES } from "./goal.js";
import { exactQueueResponse, MAX_QUEUE_RESULT_BYTES, QUEUE_ACTIONS, QUEUE_PAGE_LIMIT } from "./queue.js";
import { exactSearchResponse, SEARCH_PAGE_LIMIT } from "./search.js";

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: {
    title: string;
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
}

const approvalPolicySchema = {
  type: "string",
  enum: ["untrusted", "on-request", "never"],
  description: "Codex app-server approval policy override.",
};

const sandboxSchema = {
  type: "string",
  enum: ["read-only", "workspace-write", "danger-full-access"],
  description: "Codex app-server sandbox mode override.",
};

const NATIVE_SANDBOX_POLICY_TYPE_BY_MODE = {
  "read-only": "readOnly",
  "workspace-write": "workspaceWrite",
  "danger-full-access": "dangerFullAccess",
} as const;

type PublicSandboxMode = keyof typeof NATIVE_SANDBOX_POLICY_TYPE_BY_MODE;

const NATIVE_APPROVAL_POLICIES = new Set([
  "untrusted",
  "on-request",
  "never",
]);

type PublicApprovalPolicy = "untrusted" | "on-request" | "never";

const SUPPORTED_RESPOND_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "execCommandApproval",
  "applyPatchApproval",
  "item/tool/requestUserInput",
]);

const MODEL_LIST_PAGE_LIMIT = 100;
const MAX_MODEL_CATALOG_PAGES = 100;
const MAX_MODEL_CATALOG_ENTRIES = 10_000;
const HISTORY_TURN_LIMIT = 50;
const HISTORY_ITEM_LIMIT = 20;
const THREAD_SOURCE_KINDS = [
  "cli", "vscode", "exec", "appServer", "subAgent", "subAgentReview",
  "subAgentCompact", "subAgentThreadSpawn", "subAgentOther", "unknown",
] as const;
const THREAD_LIST_FIELDS = [
  "cwd", "search_term", "cursor", "limit", "parent_thread_id", "ancestor_thread_id", "source_kinds",
] as const;

interface ModelListPage {
  data: Record<string, unknown>[];
  nextCursor: string | null;
}

export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: "codex_threads",
    title: "Codex Threads",
    description:
      "List or search persistent native threads, or read one thread's metadata without loading turns. include_turns:true returns a migration error; use codex_history for persistent history. Native canAcceptDirectInput (boolean or null) and lineage fields remain native facts, not Bridge write authorization; an absent field stays absent. List filters can select direct children or spawned descendants; source_kinds must explicitly include subagents when needed because native defaults to interactive sources. No metadata read reconstructs live Bridge events.",
    inputSchema: {
      type: "object",
      properties: {
        thread_id: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description: "When supplied, read this exact Codex thread instead of listing threads.",
        },
        include_turns: {
          type: "boolean",
          description: "Legacy parameter: false reads metadata; true returns a migration error directing callers to codex_history.",
        },
        cwd: {
          type: "string",
          maxLength: 1000,
          description: "Optional exact absolute native cwd filter for thread/list.",
        },
        parent_thread_id: {
          type: ["string", "null"],
          minLength: 1,
          maxLength: 200,
          pattern: "\\S",
          description: "List direct spawned children of this native parent. Mutually exclusive with a non-null ancestor_thread_id. Does not select forks or implicitly include subagent sources.",
        },
        ancestor_thread_id: {
          type: ["string", "null"],
          minLength: 1,
          maxLength: 200,
          pattern: "\\S",
          description: "List spawned descendants at any depth, excluding the ancestor itself. Mutually exclusive with a non-null parent_thread_id. Native filtering only; no Bridge tree walk.",
        },
        source_kinds: {
          type: ["array", "null"],
          items: { type: "string", enum: THREAD_SOURCE_KINDS },
          maxItems: 100,
          description: "Native source filter. Omitted, null, or [] retains native interactive-source defaults; use subAgentThreadSpawn explicitly for spawned threads. Order and duplicates are forwarded. At most 100 entries is a transport bound.",
        },
        search_term: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description: "Optional Codex title substring filter for thread/list.",
        },
        cursor: {
          type: "string",
          minLength: 1,
          maxLength: 10000,
          description: "Opaque cursor returned by a prior thread/list call.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          default: 20,
          description: "Maximum threads in the returned page.",
        },
      },
      oneOf: [
        { not: { anyOf: [{ required: ["thread_id"] }, { required: ["include_turns"] }] } },
        { required: ["thread_id"], not: { anyOf: THREAD_LIST_FIELDS.map((key) => ({ required: [key] })) } },
      ],
      not: {
        required: ["parent_thread_id", "ancestor_thread_id"],
        properties: { parent_thread_id: { type: "string" }, ancestor_thread_id: { type: "string" } },
      },
      additionalProperties: false,
    },
    annotations: {
      title: "Codex Threads",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "codex_history",
    title: "Codex History",
    description:
      "Read one lossless native persisted history page, without attaching a writer or rebuilding Bridge live state. Paginated threads provide a turn index (turns) or items within a required turn_id (items). Legacy threads provide one full turn per page (turns, limit 1); item paging is unsupported. Keep opaque string cursors with the same thread, history mode, kind, turn scope, and sort direction; reverse cursors use the opposite direction. Only nextCursor:null means end. Size, content_policy or defensive structure failures reject the whole page without partial data; a single legacy turn may be undeliverable. No cache, full-thread fallback, or chunk cursor.",
    inputSchema: {
      type: "object",
      properties: {
        thread_id: { type: "string", minLength: 1, maxLength: 200, pattern: "\\S" },
        kind: { type: "string", enum: ["turns", "items"] },
        content_policy: { type: "string", enum: ["protected", "exact"], default: "protected", description: "protected rejects secret-shaped content. exact returns native text unchanged for this call and may expose sensitive content to the MCP caller. This is an explicit content choice, not an access-control or safety level; no automatic fallback." },
        turn_id: { type: "string", minLength: 1, maxLength: 200, pattern: "\\S" },
        cursor: { type: "string", minLength: 1, maxLength: 10_000, pattern: "\\S", description: "Native history cursor; separate from thread/list and numeric live observe cursors." },
        limit: { type: "integer", minimum: 1, maximum: HISTORY_TURN_LIMIT, description: "Paginated turns: default 20, max 50. Paginated items: default 10, max 20. Legacy turns: default and max 1, checked after metadata read." },
        sort_direction: { type: "string", enum: ["asc", "desc"], description: "Defaults to desc for turns and asc for items." },
      },
      required: ["thread_id", "kind"],
      oneOf: [
        { properties: { kind: { const: "turns" } }, not: { required: ["turn_id"] } },
        { properties: { kind: { const: "items" }, limit: { maximum: HISTORY_ITEM_LIMIT } }, required: ["turn_id"] },
      ],
      additionalProperties: false,
    },
    annotations: {
      title: "Codex History",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "codex_search",
    title: "Search Native Codex History",
    description:
      "Read one native search page without resuming threads, loading full histories or rebuilding Bridge live state. kind=threads maps thread/search for native substring/full-text thread discovery with snippets, distinct from the codex_threads title filter. Native search has no cwd/parent/ancestor filter: it searches native-visible threads selected only by source_kinds and archived, never an implied workspace or ACL. kind=occurrences maps thread/searchOccurrences within one required paginated thread: case-insensitive literal substring matches in visible user and final assistant messages, in chronological message order, not every tool/reasoning item. Native owns indexing, matching and ordering; Bridge has no index, relevance scoring, traversal or fallback. Preserve the exact query and filters on continuation; only nextCursor:null means end, not an empty page. Thread-search backwardsCursor is used with the opposite sort_direction; occurrence turnCursor is an inclusive native history anchor for codex_history(kind=turns, same thread), not a search continuation. snippetMatchRange uses UTF-16 code units, end exclusive. Eligible pages and future fields are unchanged; content_policy, defensive structure, invalid fields or the 256 KiB result-body bound produce search_result_not_deliverable with no partial data/cursor. Native errors, including unsupported history modes, propagate without retry. Search results are locators, not a complete history audit or a snapshot guarantee.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["threads", "occurrences"] },
        content_policy: { type: "string", enum: ["protected", "exact"], default: "protected", description: "protected rejects secret-shaped content. exact returns native text unchanged for this call and may expose sensitive content to the MCP caller. This is an explicit content choice, not an access-control or safety level; no automatic fallback." },
        search_term: { type: "string", minLength: 1, maxLength: 500, pattern: "\\S", description: "Native query, forwarded unchanged. Length bound is for transport; Bridge does not tokenize, trim or interpret it." },
        thread_id: { type: "string", minLength: 1, maxLength: 200, pattern: "\\S", description: "Required only for occurrences. Exact native paginated thread." },
        cursor: { type: "string", minLength: 1, maxLength: 10_000, pattern: "\\S", description: "Opaque search continuation for the same kind, query, scope and filters. Never substitute an occurrence's turnCursor here." },
        limit: { type: "integer", minimum: 1, maximum: SEARCH_PAGE_LIMIT, default: 20 },
        sort_key: { type: ["string", "null"], enum: ["created_at", "updated_at", "recency_at", null], description: "Threads only. Omission/null retains native created_at default." },
        sort_direction: { type: ["string", "null"], enum: ["asc", "desc", null], description: "Threads only. Omission/null retains native descending default. Occurrences have native chronological order." },
        source_kinds: { type: ["array", "null"], items: { type: "string", enum: THREAD_SOURCE_KINDS }, maxItems: 100, description: "Threads only. Omitted/null/[] keeps native interactive-source defaults; select subagents explicitly. No deduplication or expansion." },
        archived: { type: ["boolean", "null"], description: "Threads only. true searches archived threads; false/null/omission searches non-archived threads." },
      },
      required: ["kind", "search_term"],
      oneOf: [
        { properties: { kind: { const: "threads" } }, not: { required: ["thread_id"] } },
        { properties: { kind: { const: "occurrences" } }, required: ["thread_id"], not: { anyOf: ["sort_key", "sort_direction", "source_kinds", "archived"].map(key => ({ required: [key] })) } },
      ],
      additionalProperties: false,
    },
    annotations: { title: "Search Native Codex History", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "codex_models",
    title: "Codex Models",
    description:
      "Read one current model/list page directly from Codex app-server. Results are bounded and sanitized, cursors are opaque, hidden models are omitted unless include_hidden is true, and the Bridge keeps no model catalog cache or current-model registry.",
    inputSchema: {
      type: "object",
      properties: {
        cursor: {
          type: "string",
          minLength: 1,
          maxLength: 10000,
          description: "Opaque cursor returned by a prior model/list call.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: MODEL_LIST_PAGE_LIMIT,
          default: 20,
          description: "Maximum models in the returned page.",
        },
        include_hidden: {
          type: "boolean",
          default: false,
          description: "Request hidden models through native model/list includeHidden.",
        },
      },
      additionalProperties: false,
    },
    annotations: {
      title: "Codex Models",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "codex_goal",
    title: "Manage Native Codex Goal",
    description:
      "Get, set, or clear the native persisted goal of an exact thread. Each call maps one thread/goal method without implicit resume, turn/start, retries, a goal cache, or checkpoint writes. Active goals may cause native execution; clear is not turn interrupt. Set requires explicit budget_mode with no default: preserve omits native tokenBudget, unlimited sends null, fixed sends the required positive safe-integer token_budget. A budget is an optional native Goal resource ceiling: ordinarily choose unlimited for a long-running goal, fixed only when a hard cap is intended, and preserve when editing an existing goal without changing its budget. The budget gate does not apply to ordinary turns, Queue or Steer. Native Codex validates objectives and owns status transitions and usage accounting. Success returns native content unchanged without secret-shape filtering; known oversized echoed input is rejected before mutation. goal_result_not_deliverable means native returned success but its result could not be delivered losslessly, including an acknowledged mutation for set/clear. An already-sent mutating acknowledgement timeout instead means UNKNOWN / possibly accepted. Read native goal state before deciding on another mutation; do not directly retry.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["get", "set", "clear"] },
        thread_id: { type: "string", minLength: 1, maxLength: 200, pattern: "\\S" },
        objective: {
          type: ["string", "null"],
          description: "Set only. Native Codex enforces its non-empty, 4,000-character objective contract; Bridge forwards the string unchanged and does not count or truncate it. Omission/null preserves the existing objective.",
        },
        status: { type: ["string", "null"], enum: [...GOAL_STATUSES, null], description: "Set only. Native status; omission/null preserves the existing status." },
        budget_mode: { type: "string", enum: ["preserve", "unlimited", "fixed"], description: "Required for set, with no default. preserve omits native tokenBudget; unlimited sends null; fixed requires token_budget. Only fixed accepts an amount." },
        token_budget: {
          type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER,
          description: "Required only for budget_mode=fixed. A positive native Goal resource ceiling. The maximum is a JavaScript lossless transport bound, not a goal business rule. No default budget; do not send this field for preserve/unlimited.",
        },
      },
      required: ["action", "thread_id"],
      oneOf: [
        { properties: { action: { const: "set" } }, required: ["budget_mode"], oneOf: [
          { properties: { budget_mode: { const: "fixed" } }, required: ["token_budget"] },
          { properties: { budget_mode: { enum: ["preserve", "unlimited"] } }, not: { required: ["token_budget"] } },
        ] },
        { properties: { action: { enum: ["get", "clear"] } }, not: { anyOf: ["objective", "status", "budget_mode", "token_budget"].map(key => ({ required: [key] })) } },
      ],
      additionalProperties: false,
    },
    annotations: {
      title: "Manage Native Codex Goal",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "codex_queue",
    title: "Codex Native Queue",
    description:
      "List, add, update, delete or reorder native queued follow-up text for an existing active workflow. Native Codex owns ordering and automatic execution after the current turn; an enqueue acknowledgement is not execution or completion. This differs from codex_steer, which redirects the current turn. Each call forwards one native queue operation, with no implicit resume, turn-start, queue-start, traversal, retry, scheduler or Bridge queue store. Use caller-supplied client_user_message_id for add and native queuedSubmission.id for update/delete/reorder; do not assume an idempotency guarantee. An already-sent mutation timeout is UNKNOWN; read queue and execution state before deciding on another write. queue_result_not_deliverable means native returned success but its result could not be delivered losslessly; for mutations the acknowledgement is retained. No retry or compensation is performed. Queue entries may be consumed while inspecting or editing them. Successful reads and responses preserve native content without secret-shape filtering. This surface supports text only; update replaces the entire native input array with one text item.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: QUEUE_ACTIONS },
        thread_id: { type: "string", minLength: 1, maxLength: 200, pattern: "\\S" },
        text: { type: "string", minLength: 1, maxLength: 200_000, pattern: "\\S", description: "Follow-up text for add or full input replacement for update. Input transport bound; a serialized UTF-8 preflight also reserves response overhead before writing. Unpredictable native fields can still make an acknowledged result undeliverable." },
        client_user_message_id: { type: "string", minLength: 1, maxLength: 200, pattern: "\\S", description: "Required caller-provided native clientUserMessageId for add; Bridge never generates or retries it." },
        queued_submission_id: { type: "string", minLength: 1, maxLength: 200, pattern: "\\S", description: "Exact native queuedSubmission.id for update/delete; not a turn id or client message id." },
        queued_submission_ids: { type: "array", maxItems: QUEUE_PAGE_LIMIT, items: { type: "string", minLength: 1, maxLength: 200, pattern: "\\S" }, description: "Native pending submission IDs in the requested order. Pass the full intended ordering; native validates membership/permutation. No read/merge/deduplication or retry. The array bound is not native queue capacity." },
        cursor: { type: "string", minLength: 1, maxLength: 10_000, pattern: "\\S", description: "Opaque native queue-list cursor; not a history or observe cursor." },
        limit: { type: "integer", minimum: 1, maximum: QUEUE_PAGE_LIMIT, default: 20, description: "Maximum entries requested in this single native queue page." },
      },
      required: ["action", "thread_id"],
      oneOf: [
        { properties: { action: { const: "list" } }, not: { anyOf: ["text", "client_user_message_id", "queued_submission_id", "queued_submission_ids"].map(key => ({ required: [key] })) } },
        { properties: { action: { const: "add" } }, required: ["text", "client_user_message_id"], not: { anyOf: ["queued_submission_id", "queued_submission_ids", "cursor", "limit"].map(key => ({ required: [key] })) } },
        { properties: { action: { const: "update" } }, required: ["text", "queued_submission_id"], not: { anyOf: ["client_user_message_id", "queued_submission_ids", "cursor", "limit"].map(key => ({ required: [key] })) } },
        { properties: { action: { const: "delete" } }, required: ["queued_submission_id"], not: { anyOf: ["text", "client_user_message_id", "queued_submission_ids", "cursor", "limit"].map(key => ({ required: [key] })) } },
        { properties: { action: { const: "reorder" } }, required: ["queued_submission_ids"], not: { anyOf: ["text", "client_user_message_id", "queued_submission_id", "cursor", "limit"].map(key => ({ required: [key] })) } },
      ],
      additionalProperties: false,
    },
    annotations: {
      title: "Codex Native Queue", readOnlyHint: false, destructiveHint: true,
      idempotentHint: false, openWorldHint: true,
    },
  },
  {
    name: "codex_turn",
    title: "Start or Continue Codex Turn",
    description:
      "Start a persistent Codex thread and turn, or resume an existing thread and start a turn. Prefer continuing the same native thread when its context remains useful, but a fresh thread is allowed; thread_id is not a permanent task identity. Explicit model or effort overrides are validated against a fresh model/list catalog without caching. Effort alone is checked only against efforts advertised somewhere in that catalog; the Bridge does not infer the current thread model, so app-server remains authoritative for current-model compatibility. Returns as soon as turn/start is accepted; observe separately for events and completion. If an already-sent mutating acknowledgement times out, the outcome is UNKNOWN and the request was possibly accepted; observe/read before any retry, and never directly retry it.",
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          minLength: 1,
          maxLength: 200000,
          description: "User text passed directly to Codex as one text input item.",
        },
        thread_id: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description: "Existing persistent Codex thread to resume. Omit to create a new thread.",
        },
        cwd: {
          type: "string",
          maxLength: 1000,
          description: "Absolute native cwd. Required for a new thread; optional override for resume.",
        },
        model: {
          type: "string",
          minLength: 1,
          maxLength: 100,
          description: "Optional model/list id or model identifier, validated on demand and passed through unchanged.",
        },
        effort: {
          type: "string",
          minLength: 1,
          maxLength: 32,
          description: "Optional reasoning effort. With no model, only catalog-wide token existence is checked; current-model compatibility remains native-authoritative.",
        },
        sandbox: sandboxSchema,
        approval_policy: approvalPolicySchema,
      },
      required: ["text"],
      anyOf: [{ required: ["thread_id"] }, { required: ["cwd"] }],
      additionalProperties: false,
    },
    annotations: {
      title: "Start or Continue Codex Turn",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "codex_observe",
    title: "Observe Codex Turn",
    description:
      "Read bounded incremental sanitized Bridge runtime events, pending requests, and terminal output for a thread. Default compact view projects supervision facts and counts only scanned retained activity. Raw returns individual retained sanitized events with original runtime cursors, without aggregation; internal cursor gaps are possible, so it is not a complete native stream. stream_lost reports evicted allowlisted, valid streaming deltas; facts_lost reports eviction of other events; cursor_lost summarizes either. Loss covers the unscanned cursor-to-head range checked during the read, not only the returned page. cursor_floor locates the oldest retained event boundary, not a continuous suffix or an instruction to skip records. Always reuse next_cursor to consume remaining retained events. Compact drains silent retained events across chunks and wakes on supervision facts or facts_lost; stream_lost alone is diagnostic metadata, does not wake compact early, and does not require raw replay. Optional wait_ms performs one bounded event-driven wait with a fixed per-call deadline (maximum 120 seconds); 0 returns immediately. A true-silence deadline returns only runtime_available, runtime_status, active_turn_id, next_cursor, and no_change: true; activity or loss is not silence. Use view=raw with a chosen runtime cursor and wait_ms=0 for retained-event replay. Pending requests and latest terminal output remain separately available even after their ring events are evicted. If compact cannot deliver a final completely, follow next_cursor through terminal completion for the bounded final_result. final_result_meta.complete is false for truncated or partial source text; raw also has a 48k live text cap. Use narrow codex_history for this thread/terminal turn or native inspection when more content is needed. When runtime_available is true, pending_requests is the complete current pending set, not an incremental patch. Compact omits it when empty; an absent field means no pending requests, so clear any previously observed list. When runtime_available is false, pending state is unknown, even if the field is absent or an empty array. After Bridge process loss, metadata-only thread/read cannot reconstruct live events, pending requests, cursor, active turn, or terminal; page persistent history through codex_history if needed. A long interval with no new command or output can still mean Codex is actively reasoning; absence of new command activity alone is not evidence of a stall. When actively supervising an in-progress turn, use repeated bounded-wait observe calls until terminal unless the user explicitly pauses or stops; do not end supervision merely because one snapshot is inProgress. After every wake or deadline return, inspect the newly available events/state and decide whether steer, respond, or interruption is needed before starting the next bounded wait.",
    inputSchema: {
      type: "object",
      properties: {
        thread_id: { type: "string", minLength: 1, maxLength: 200, description: "Codex thread to observe." },
        cursor: {
          type: "integer",
          minimum: 0,
          description: "Continue from next_cursor; deliberate older values replay retained events. Original per-event runtime cursors may have internal gaps. Never replace next_cursor with cursor_floor after loss.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          default: 50,
          description: "Maximum compact facts or retained raw events to return; compact may scan more silent retained events internally. Loss metadata can cover events beyond this page.",
        },
        wait_ms: {
          type: "integer",
          minimum: 0,
          maximum: MAX_OBSERVE_WAIT_MS,
          default: 0,
          description:
            "Optional fixed per-call wait for a supervision wake, facts loss, or deadline in compact view; stream loss alone does not wake compact early. Raw waits for retained events/state. 0 reads currently available events immediately. This is not stall detection.",
        },
        view: {
          type: "string",
          enum: ["compact", "raw"],
          default: "compact",
          description: "Compact facts by default; raw returns retained individual sanitized event envelopes with original runtime cursors and possible internal gaps. Neither view restores evicted events; use next_cursor for pagination.",
        },
      },
      required: ["thread_id"],
      additionalProperties: false,
    },
    annotations: {
      title: "Observe Codex Turn",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "codex_steer",
    title: "Steer Active Codex Turn",
    description:
      "Append text to the same active Codex turn using turn/steer with an expected turn-id precondition. This does not create a new turn. Do not steer merely because reasoning is taking a long time or no new command has appeared; steer only for a semantic redirect or correction based on new evidence or changed user intent. If an already-sent mutating acknowledgement times out, the outcome is UNKNOWN and the request was possibly accepted; observe/read before any retry, and never directly retry it.",
    inputSchema: {
      type: "object",
      properties: {
        thread_id: { type: "string", minLength: 1, maxLength: 200, description: "Active Codex thread." },
        expected_turn_id: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description: "Exact active turn id required by app-server.",
        },
        text: { type: "string", minLength: 1, maxLength: 200000, description: "Additional user text." },
      },
      required: ["thread_id", "expected_turn_id", "text"],
      additionalProperties: false,
    },
    annotations: {
      title: "Steer Active Codex Turn",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "codex_respond",
    title: "Respond to Codex Request",
    description:
      "Answer one currently pending app-server server request by its original raw JSON-RPC id and exact thread/method scope. Supports stable item/commandExecution/requestApproval, item/fileChange/requestApproval, item/permissions/requestApproval, and item/tool/requestUserInput contracts, plus existing legacy execCommandApproval/applyPatchApproval compatibility. Unsupported or unknown methods fail locally and remain pending; do not guess a future response contract.",
    inputSchema: {
      type: "object",
      properties: {
        request_id: {
          oneOf: [{ type: "string", minLength: 1 }, { type: "integer" }],
          description: "Original app-server JSON-RPC request id, preserving string or integer type.",
        },
        thread_id: { type: "string", minLength: 1, maxLength: 200, description: "Exact pending-request thread scope." },
        turn_id: { type: "string", minLength: 1, maxLength: 200, description: "Exact turn scope when the pending request has one." },
        method: { type: "string", minLength: 1, maxLength: 300, description: "Exact app-server request method." },
        decision: {
          type: "string",
          enum: ["accept", "acceptForSession", "decline", "cancel"],
          description: "Command or file approval decision. decline rejects the action and continues the current turn; cancel rejects the action and immediately interrupts the current turn.",
        },
        execpolicy_amendment: {
          type: "array",
          minItems: 1,
          items: { type: "string" },
          description: "Command approval exec-policy amendment; encoded in app-server's native decision shape.",
        },
        network_policy_amendment: {
          type: "object",
          properties: {
            host: { type: "string", minLength: 1 },
            action: { type: "string", enum: ["allow", "deny"] },
          },
          required: ["host", "action"],
          additionalProperties: false,
          description: "Native network policy amendment for future requests; valid only for item/commandExecution/requestApproval. Provide exactly one of decision, execpolicy_amendment, network_policy_amendment, answers, permissions, or response.",
        },
        answers: {
          type: "object",
          additionalProperties: {
            type: "object",
            properties: {
              answers: { type: "array", items: { type: "string" } },
            },
            required: ["answers"],
            additionalProperties: false,
          },
          description: "request_user_input question-id to answer-array mapping.",
        },
        permissions: {
          type: "object",
          additionalProperties: true,
          description: "Granted subset for item/permissions/requestApproval. An empty object grants none of the requested permissions.",
        },
        scope: {
          type: "string",
          enum: ["turn", "session"],
          description: "Optional permission grant scope; omit or use turn for the current turn, or session for the session.",
        },
        response: {
          type: "object",
          additionalProperties: true,
          description: "Exact generic result object for item/tool/requestUserInput; unsupported or future methods remain pending and are rejected locally.",
        },
      },
      required: ["request_id", "thread_id", "method"],
      anyOf: [
        { required: ["decision"] },
        { required: ["execpolicy_amendment"] },
        { required: ["network_policy_amendment"] },
        { required: ["answers"] },
        { required: ["permissions"] },
        { required: ["response"] },
      ],
      additionalProperties: false,
    },
    annotations: {
      title: "Respond to Codex Request",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "codex_interrupt",
    title: "Interrupt Codex Turn",
    description:
      "Directly request turn/interrupt for the specified active Codex thread and turn. It does not stop or restart the Bridge or Codex app-server processes. If an already-sent mutating acknowledgement times out, the outcome is UNKNOWN and the request was possibly accepted; observe/read before any retry, and never directly retry it.",
    inputSchema: {
      type: "object",
      properties: {
        thread_id: { type: "string", minLength: 1, maxLength: 200, description: "Active Codex thread." },
        turn_id: { type: "string", minLength: 1, maxLength: 200, description: "Active Codex turn to interrupt." },
      },
      required: ["thread_id", "turn_id"],
      additionalProperties: false,
    },
    annotations: {
      title: "Interrupt Codex Turn",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "codex_checkpoint",
    title: "Checkpoint Codex Supervision",
    description:
      "Optional, bounded supervisor cognition memory keyed to one native Codex thread_id; the key is not a permanent task identity and does not require future work to remain on that thread. Use it to protect the original goal, constraints, and acceptance plus concise supervisor state during long or complex supervision when context dilution or goal drift makes an external anchor worthwhile. Initialization is not tied to crossing a ChatGPT window or round, starting another Codex turn, or switching native threads; initialize early when a task is already expected to be sufficiently long or complex for that protection. Do not use for one-shot work, and do not turn duration into a hard threshold: elapsed time, observe/poll count, token count, or mere silence are not automatic triggers. Later updates remain semantic-event driven and require a material change in understanding or root cause, constraint or scope interpretation, steering decision, user-authorized amendment or effective goal, or acceptance judgment or an explicit decision not to accept yet. Before final acceptance of a checkpointed task, read it once to re-anchor the original goal, constraints, acceptance, and current supervisor frame. This tool is optional and uncoupled from all other tools. Store concise supervisor summaries only; never prompts, transcripts, raw events, command output, final answers, or raw event streams. Updates preserve only immutable original plus bounded previous/current supervisor state.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["read", "update"],
          description:
            "Read the checkpoint, or initialize/update it at a material supervisor decision point.",
        },
        thread_id: {
          type: "string",
          minLength: 1,
          maxLength: CHECKPOINT_THREAD_ID_LIMIT,
          description: "Native Codex thread id; no second task identifier is created.",
        },
        original_goal: {
          type: "string",
          minLength: 1,
          maxLength: CHECKPOINT_TEXT_LIMIT,
          description:
            "Concise original user goal. Required only on initialization and immutable thereafter.",
        },
        original_constraints: {
          type: "string",
          minLength: 1,
          maxLength: CHECKPOINT_TEXT_LIMIT,
          description:
            "Concise original constraints. Required only on initialization and immutable thereafter.",
        },
        original_acceptance: {
          type: "string",
          minLength: 1,
          maxLength: CHECKPOINT_TEXT_LIMIT,
          description:
            "Concise original acceptance criteria. Required only on initialization and immutable thereafter.",
        },
        effective_goal: {
          type: "string",
          minLength: 1,
          maxLength: CHECKPOINT_TEXT_LIMIT,
          description:
            "Current effective goal after legitimate user amendments; defaults to original_goal on initialization.",
        },
        current_amendment: {
          oneOf: [
            { type: "string", minLength: 1, maxLength: CHECKPOINT_TEXT_LIMIT },
            { type: "null" },
          ],
          description:
            "Latest concise user-authorized requirement amendment, or null to clear it, without changing the immutable original.",
        },
        current_understanding: {
          type: "string",
          minLength: 1,
          maxLength: CHECKPOINT_TEXT_LIMIT,
          description: "Current concise root-cause or task understanding.",
        },
        current_decision: {
          type: "string",
          minLength: 1,
          maxLength: CHECKPOINT_TEXT_LIMIT,
          description: "Current supervisor decision and why it matters.",
        },
        acceptance_status: {
          type: "string",
          minLength: 1,
          maxLength: CHECKPOINT_TEXT_LIMIT,
          description:
            "Concise acceptance assessment, not a task lifecycle or job status.",
        },
        next_step: {
          type: "string",
          minLength: 1,
          maxLength: CHECKPOINT_TEXT_LIMIT,
          description: "Single next supervision step.",
        },
      },
      required: ["action", "thread_id"],
      additionalProperties: false,
    },
    annotations: {
      title: "Checkpoint Codex Supervision",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
] as const;

export const TOOL_NAMES = TOOL_DEFINITIONS.map((tool) => tool.name);

function asObject(value: unknown, label = "arguments"): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function onlyKeys(args: Record<string, unknown>, allowed: readonly string[]): void {
  const extras = Object.keys(args).filter((key) => !allowed.includes(key));
  if (extras.length > 0) {
    throw new Error(`Unknown argument field: ${extras[0]}`);
  }
}

function requiredString(args: Record<string, unknown>, key: string, max = 200_000): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${key} must be a non-empty string`);
  }
  if (value.length > max) {
    throw new Error(`${key} exceeds ${max} characters`);
  }
  return value;
}

function optionalString(
  args: Record<string, unknown>,
  key: string,
  max = 200_000,
): string | undefined {
  if (args[key] === undefined) {
    return undefined;
  }
  return requiredString(args, key, max);
}

function optionalInteger(
  args: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
): number | undefined {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${key} must be an integer from ${minimum} to ${maximum}`);
  }
  return value as number;
}

function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${key} must be a boolean`);
  }
  return value;
}

function enumValue<T extends string>(
  args: Record<string, unknown>,
  key: string,
  values: readonly T[],
): T | undefined {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new Error(`${key} must be one of: ${values.join(", ")}`);
  }
  return value as T;
}

function responseRecord(value: unknown, method: string): Record<string, unknown> {
  const record = asObject(value, `${method} response`);
  return record;
}

function modelListPage(value: unknown, maximumEntries: number): ModelListPage {
  const page = responseRecord(value, "model/list");
  if (!Array.isArray(page.data)) {
    throw new Error("model/list returned no data array");
  }
  if (page.data.length > maximumEntries) {
    throw new Error(`model/list returned more than the requested ${maximumEntries} entries`);
  }
  const data = page.data.map((entry, index) => asObject(entry, `model/list data[${index}]`));
  const rawNextCursor = page.nextCursor;
  if (rawNextCursor === undefined || rawNextCursor === null) {
    return { data, nextCursor: null };
  }
  if (
    typeof rawNextCursor !== "string" ||
    rawNextCursor.length === 0 ||
    rawNextCursor.length > 10_000
  ) {
    throw new Error("model/list returned an invalid nextCursor");
  }
  return { data, nextCursor: rawNextCursor };
}

function sanitizedModelEntry(entry: Record<string, unknown>): Record<string, unknown> {
  return asObject(
    sanitizeForTransport(entry, {
      maxStringChars: 4_000,
      maxDepth: 8,
      maxArrayItems: 40,
      maxObjectKeys: 80,
      totalCharBudget: 24_000,
    }),
    "sanitized model/list entry",
  );
}

function modelIdentifiers(entry: Record<string, unknown>): string[] {
  return [entry.id, entry.model].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
}

function advertisedReasoningEfforts(
  entry: Record<string, unknown>,
): Set<string> | undefined {
  const advertised = entry.supportedReasoningEfforts;
  if (!Array.isArray(advertised)) {
    return undefined;
  }
  const efforts = new Set<string>();
  for (const option of advertised) {
    if (typeof option === "string" && option.length > 0) {
      efforts.add(option);
      continue;
    }
    if (option !== null && typeof option === "object" && !Array.isArray(option)) {
      const reasoningEffort = (option as Record<string, unknown>).reasoningEffort;
      if (typeof reasoningEffort === "string" && reasoningEffort.length > 0) {
        efforts.add(reasoningEffort);
        continue;
      }
    }
    return undefined;
  }
  return efforts;
}

function formattedEfforts(efforts: ReadonlySet<string>): string {
  const sorted = [...efforts].sort();
  return sorted.length > 0 ? sorted.join(", ") : "(none advertised)";
}

function extractThreadId(result: unknown, method: string): string {
  const thread = asObject(asObject(result, `${method} result`).thread, `${method} result.thread`);
  if (typeof thread.id !== "string" || thread.id.length === 0) {
    throw new Error(`${method} returned no thread id`);
  }
  return thread.id;
}

function extractTurnId(result: unknown, method: string): string {
  const turn = asObject(asObject(result, `${method} result`).turn, `${method} result.turn`);
  if (typeof turn.id !== "string" || turn.id.length === 0) {
    throw new Error(`${method} returned no turn id`);
  }
  return turn.id;
}

function extractSandboxPolicy(
  result: unknown,
  method: string,
  requestedSandbox: PublicSandboxMode,
): Record<string, unknown> {
  const policy = asObject(
    asObject(result, `${method} result`).sandbox,
    `${method} result.sandbox`,
  );
  const expectedType = NATIVE_SANDBOX_POLICY_TYPE_BY_MODE[requestedSandbox];
  if (policy.type !== expectedType) {
    throw new Error(
      `${method} returned sandbox policy type ${String(policy.type)} for requested ${requestedSandbox}`,
    );
  }
  return policy;
}

function extractApprovalPolicy(
  result: unknown,
  method: string,
  requestedApprovalPolicy: PublicApprovalPolicy,
): PublicApprovalPolicy {
  const effectiveApprovalPolicy = asObject(result, `${method} result`).approvalPolicy;
  if (typeof effectiveApprovalPolicy !== "string") {
    throw new Error(
      `${method} returned no usable effective approvalPolicy for requested ${requestedApprovalPolicy}`,
    );
  }
  if (!NATIVE_APPROVAL_POLICIES.has(effectiveApprovalPolicy)) {
    throw new Error(
      `${method} returned unrecognized effective approvalPolicy ${JSON.stringify(effectiveApprovalPolicy)}`,
    );
  }
  if (effectiveApprovalPolicy !== requestedApprovalPolicy) {
    throw new Error(
      `${method} returned effective approvalPolicy ${JSON.stringify(effectiveApprovalPolicy)} for requested ${JSON.stringify(requestedApprovalPolicy)}`,
    );
  }
  return effectiveApprovalPolicy;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error("MCP request cancelled");
  }
}

export class ControlSurface {
  private checkpoints: CheckpointStore | undefined;

  constructor(
    private readonly appServer: AppServerManager,
    checkpoints?: CheckpointStore,
    private readonly platformPolicy: PlatformPolicy = platformPolicyFor(),
  ) {
    this.checkpoints = checkpoints;
  }

  #cwd(args: Record<string, unknown>): string | undefined {
    const input = optionalString(args, "cwd", 1_000);
    return input ? this.platformPolicy.validateCwd(input) : undefined;
  }

  async call(name: string, rawArguments: unknown, signal?: AbortSignal): Promise<unknown> {
    const args = asObject(rawArguments ?? {});
    switch (name) {
      case "codex_history":
        return this.#history(args);
      case "codex_threads":
        return await this.#threads(args);
      case "codex_models":
        return await this.#models(args);
      case "codex_goal":
        return await this.#goal(args);
      case "codex_queue":
        return this.#queue(args);
      case "codex_search":
        return this.#search(args);
      case "codex_turn":
        return await this.#turn(args);
      case "codex_observe":
        return await this.#observe(args, signal);
      case "codex_steer":
        return await this.#steer(args);
      case "codex_respond":
        return await this.#respond(args);
      case "codex_interrupt":
        return await this.#interrupt(args);
      case "codex_checkpoint":
        return this.#checkpoint(args);
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  #checkpoint(args: Record<string, unknown>): unknown {
    const fields = [
      "action",
      "thread_id",
      "original_goal",
      "original_constraints",
      "original_acceptance",
      "effective_goal",
      "current_amendment",
      "current_understanding",
      "current_decision",
      "acceptance_status",
      "next_step",
    ] as const;
    onlyKeys(args, fields);
    const action = enumValue(args, "action", ["read", "update"] as const);
    if (!action) {
      throw new Error("action is required");
    }
    const threadId = requiredString(args, "thread_id", CHECKPOINT_THREAD_ID_LIMIT).trim();
    if (action === "read") {
      onlyKeys(args, ["action", "thread_id"]);
      const checkpoint = this.#checkpointStore().read(threadId);
      return checkpoint === null
        ? {
            source: "local_codex_bridge_checkpoint",
            found: false,
            thread_id: threadId,
            checkpoint: null,
          }
        : {
            source: "local_codex_bridge_checkpoint",
            found: true,
            operation: "read",
            checkpoint,
          };
    }

    let currentAmendment: string | null | undefined;
    if (args.current_amendment === null) {
      currentAmendment = null;
    } else {
      currentAmendment = optionalString(
        args,
        "current_amendment",
        CHECKPOINT_TEXT_LIMIT,
      );
    }
    const result = this.#checkpointStore().update(threadId, {
      original_goal: optionalString(args, "original_goal", CHECKPOINT_TEXT_LIMIT),
      original_constraints: optionalString(
        args,
        "original_constraints",
        CHECKPOINT_TEXT_LIMIT,
      ),
      original_acceptance: optionalString(
        args,
        "original_acceptance",
        CHECKPOINT_TEXT_LIMIT,
      ),
      effective_goal: optionalString(args, "effective_goal", CHECKPOINT_TEXT_LIMIT),
      current_amendment: currentAmendment,
      current_understanding: optionalString(
        args,
        "current_understanding",
        CHECKPOINT_TEXT_LIMIT,
      ),
      current_decision: optionalString(args, "current_decision", CHECKPOINT_TEXT_LIMIT),
      acceptance_status: optionalString(
        args,
        "acceptance_status",
        CHECKPOINT_TEXT_LIMIT,
      ),
      next_step: optionalString(args, "next_step", CHECKPOINT_TEXT_LIMIT),
    });
    return {
      source: "local_codex_bridge_checkpoint",
      found: true,
      operation: result.operation,
      checkpoint: result.checkpoint,
    };
  }

  #checkpointStore(): CheckpointStore {
    this.checkpoints ??= new CheckpointStore();
    return this.checkpoints;
  }

  async #history(args: Record<string, unknown>): Promise<unknown> {
    onlyKeys(args, ["thread_id", "kind", "turn_id", "cursor", "limit", "sort_direction", "content_policy"]);
    const policy = enumValue(args, "content_policy", ["protected", "exact"] as const) ?? "protected";
    const threadId = requiredString(args, "thread_id", 200);
    const kind = enumValue(args, "kind", ["turns", "items"]);
    if (kind === undefined) throw new Error("kind is required");
    if (kind === "turns" && Object.hasOwn(args, "turn_id")) {
      throw new Error("turn_id is valid only for items");
    }
    const turnId = kind === "items" ? requiredString(args, "turn_id", 200) : undefined;
    const cursor = optionalString(args, "cursor", 10_000);
    const requestedLimit = optionalInteger(args, "limit", 1, kind === "turns" ? HISTORY_TURN_LIMIT : HISTORY_ITEM_LIMIT);
    const sortDirection = enumValue(args, "sort_direction", ["asc", "desc"])
      ?? (kind === "turns" ? "desc" : "asc");

    // Native mode is read on demand, never cached in Bridge live state.
    const metadata = await this.appServer.request("thread/read", { threadId, includeTurns: false });
    const thread = asObject(responseRecord(metadata, "thread/read").thread, "thread/read result.thread");
    const historyMode = thread.historyMode;
    if (thread.id !== threadId || (historyMode !== "paginated" && historyMode !== "legacy")) {
      throw new Error("history_upstream_invalid: metadata must identify the requested thread and a supported historyMode");
    }
    if (historyMode === "legacy") {
      if (kind === "items") {
        throw new Error("history_legacy_item_paging_unsupported: use codex_history with kind:'turns' for native one-full-turn pages; legacy has no item cursor");
      }
      if (requestedLimit !== undefined && requestedLimit !== 1) {
        throw new Error("legacy history turn pages require limit:1");
      }
    }
    const limit = requestedLimit ?? (historyMode === "legacy" ? 1 : kind === "turns" ? 20 : 10);
    const itemsView = historyMode === "legacy" ? "full" : "notLoaded";
    const page = validateHistoryPage(await this.appServer.request(
      kind === "turns" ? "thread/turns/list" : "thread/items/list",
      {
        threadId,
        ...(turnId ? { turnId } : {}),
        ...(cursor ? { cursor } : {}),
        limit,
        sortDirection,
        ...(kind === "turns" ? { itemsView } : {}),
      },
    ), limit, kind);
    return exactHistoryResponse({
      source: "codex_app_server",
      mode: "history",
      coverage: "native_persisted_history",
      history_mode: historyMode,
      kind,
      page_granularity: kind === "turns" ? "turn" : "item",
      ...(kind === "turns" ? { items_view: itemsView } : {}),
      thread_id: threadId,
      ...(turnId ? { turn_id: turnId } : {}),
      data: page.data,
      nextCursor: page.nextCursor,
      backwardsCursor: page.backwardsCursor,
    }, policy);
  }

  async #search(args: Record<string, unknown>): Promise<unknown> {
    const kind = enumValue(args, "kind", ["threads", "occurrences"] as const);
    if (!kind) throw new Error("kind is required");
    const policy = enumValue(args, "content_policy", ["protected", "exact"] as const) ?? "protected";
    onlyKeys(args, ["kind", "search_term", "cursor", "limit", "content_policy", ...(kind === "threads"
      ? ["sort_key", "sort_direction", "source_kinds", "archived"] : ["thread_id"])]);
    const limit = optionalInteger(args, "limit", 1, SEARCH_PAGE_LIMIT) ?? 20;
    const params: Record<string, unknown> = { searchTerm: requiredString(args, "search_term", 500), limit };
    const cursor = optionalString(args, "cursor", 10_000);
    if (cursor !== undefined) params.cursor = cursor;
    if (kind === "occurrences") {
      params.threadId = requiredString(args, "thread_id", 200);
    } else {
      const sortKey = args.sort_key === null ? null : enumValue(args, "sort_key", ["created_at", "updated_at", "recency_at"] as const);
      const sortDirection = args.sort_direction === null ? null : enumValue(args, "sort_direction", ["asc", "desc"] as const);
      const archived = args.archived === null ? null : optionalBoolean(args, "archived");
      const sourceKinds = args.source_kinds;
      if (sourceKinds !== undefined && sourceKinds !== null && (
        !Array.isArray(sourceKinds) || sourceKinds.length > 100 ||
        sourceKinds.some(value => typeof value !== "string" || !(THREAD_SOURCE_KINDS as readonly string[]).includes(value))
      )) throw new Error("source_kinds must be null or an array of at most 100 native source kinds");
      if (sortKey !== undefined) params.sortKey = sortKey;
      if (sortDirection !== undefined) params.sortDirection = sortDirection;
      if (archived !== undefined) params.archived = archived;
      if (sourceKinds !== undefined) params.sourceKinds = sourceKinds;
    }
    const method = kind === "threads" ? "thread/search" : "thread/searchOccurrences";
    return exactSearchResponse(await this.appServer.request(method, params), kind, limit, policy);
  }

  async #threads(args: Record<string, unknown>): Promise<unknown> {
    onlyKeys(args, ["thread_id", "include_turns", ...THREAD_LIST_FIELDS]);
    const threadId = optionalString(args, "thread_id", 200);
    if (threadId) {
      if (THREAD_LIST_FIELDS.some((key) => Object.hasOwn(args, key))) {
        throw new Error("thread_id cannot be combined with list/search fields");
      }
      const includeTurns = optionalBoolean(args, "include_turns") ?? false;
      if (includeTurns) {
        throw new Error("include_turns:true is no longer supported; use codex_history(thread_id, kind:'turns') and native history mode guidance");
      }
      const result = await this.appServer.request("thread/read", {
        threadId,
        includeTurns: false,
      });
      return sanitizeForTransport({ source: "codex_app_server", mode: "read", ...responseRecord(result, "thread/read") });
    }
    if (Object.hasOwn(args, "include_turns")) {
      throw new Error("include_turns is valid only with thread_id");
    }
    const cwd = this.#cwd(args);
    const searchTerm = optionalString(args, "search_term", 500);
    const cursor = optionalString(args, "cursor", 10_000);
    const limit = optionalInteger(args, "limit", 1, 100) ?? 20;
    const parentThreadId = args.parent_thread_id === null ? null : optionalString(args, "parent_thread_id", 200);
    const ancestorThreadId = args.ancestor_thread_id === null ? null : optionalString(args, "ancestor_thread_id", 200);
    if (parentThreadId != null && ancestorThreadId != null) {
      throw new Error("parent_thread_id and ancestor_thread_id are mutually exclusive");
    }
    const sourceKinds = args.source_kinds;
    if (sourceKinds !== undefined && sourceKinds !== null && (
      !Array.isArray(sourceKinds) || sourceKinds.length > 100 ||
      sourceKinds.some((kind) => typeof kind !== "string" || !(THREAD_SOURCE_KINDS as readonly string[]).includes(kind))
    )) {
      throw new Error("source_kinds must be null or an array of at most 100 native source kinds");
    }
    const result = await this.appServer.request("thread/list", {
      limit,
      sortKey: "updated_at",
      sortDirection: "desc",
      ...(cwd ? { cwd } : {}),
      ...(searchTerm ? { searchTerm } : {}),
      ...(cursor ? { cursor } : {}),
      ...(parentThreadId !== undefined ? { parentThreadId } : {}),
      ...(ancestorThreadId !== undefined ? { ancestorThreadId } : {}),
      ...(sourceKinds !== undefined ? { sourceKinds } : {}),
    });
    const page = responseRecord(result, "thread/list");
    if (!Array.isArray(page.data)) {
      throw new Error("thread/list returned no data array");
    }
    return {
      source: "codex_app_server",
      mode: "list",
      nextCursor: typeof page.nextCursor === "string" ? page.nextCursor : null,
      backwardsCursor: typeof page.backwardsCursor === "string" ? page.backwardsCursor : null,
      data: page.data.map((thread) => sanitizeForTransport(thread, {
        maxStringChars: 4_000,
        maxDepth: 6,
        maxArrayItems: 20,
        maxObjectKeys: 60,
        totalCharBudget: 12_000,
      })),
    };
  }

  async #models(args: Record<string, unknown>): Promise<unknown> {
    onlyKeys(args, ["cursor", "limit", "include_hidden"]);
    const cursor = optionalString(args, "cursor", 10_000);
    const limit = optionalInteger(args, "limit", 1, MODEL_LIST_PAGE_LIMIT) ?? 20;
    const includeHidden = optionalBoolean(args, "include_hidden") ?? false;
    const page = modelListPage(
      await this.appServer.request("model/list", {
        limit,
        includeHidden,
        ...(cursor ? { cursor } : {}),
      }),
      limit,
    );
    return {
      source: "codex_app_server_model_list",
      data: page.data.map(sanitizedModelEntry),
      nextCursor: page.nextCursor,
    };
  }

  async #fullModelCatalog(): Promise<Record<string, unknown>[]> {
    const catalog: Record<string, unknown>[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (let pageNumber = 0; pageNumber < MAX_MODEL_CATALOG_PAGES; pageNumber += 1) {
      const page = modelListPage(
        await this.appServer.request("model/list", {
          limit: MODEL_LIST_PAGE_LIMIT,
          includeHidden: true,
          ...(cursor ? { cursor } : {}),
        }),
        MODEL_LIST_PAGE_LIMIT,
      );
      catalog.push(...page.data);
      if (catalog.length > MAX_MODEL_CATALOG_ENTRIES) {
        throw new Error(`model/list catalog exceeded ${MAX_MODEL_CATALOG_ENTRIES} entries`);
      }
      if (page.nextCursor === null) {
        return catalog;
      }
      if (seenCursors.has(page.nextCursor)) {
        throw new Error("model/list pagination cursor cycle detected");
      }
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    throw new Error(`model/list catalog exceeded ${MAX_MODEL_CATALOG_PAGES} pages`);
  }

  async #validateExecutionOverrides(
    model: string | undefined,
    effort: string | undefined,
  ): Promise<void> {
    if (!model && !effort) {
      return;
    }
    const catalog = await this.#fullModelCatalog();
    if (model) {
      const matches = catalog.filter((entry) => modelIdentifiers(entry).includes(model));
      if (matches.length === 0) {
        throw new Error(
          `Unknown model override ${JSON.stringify(model)}; current model/list catalog contains no matching id or model`,
        );
      }
      if (!effort) {
        return;
      }
      const advertised = matches.map(advertisedReasoningEfforts);
      if (advertised.some((efforts) => efforts === undefined)) {
        return;
      }
      const supported = new Set(advertised.flatMap((efforts) => [...efforts!]));
      if (!supported.has(effort)) {
        throw new Error(
          `Unsupported effort ${JSON.stringify(effort)} for model ${JSON.stringify(model)}; advertised supportedReasoningEfforts: ${formattedEfforts(supported)}`,
        );
      }
      return;
    }

    const advertised = new Set<string>();
    for (const entry of catalog) {
      const efforts = advertisedReasoningEfforts(entry);
      if (efforts) {
        for (const candidate of efforts) {
          advertised.add(candidate);
        }
      }
    }
    if (!advertised.has(effort!)) {
      throw new Error(
        `Unknown effort override ${JSON.stringify(effort)}; it is absent from all advertised supportedReasoningEfforts in the current model/list catalog. The Bridge does not infer the current thread model. Advertised efforts: ${formattedEfforts(advertised)}`,
      );
    }
  }

  async #goal(args: Record<string, unknown>): Promise<unknown> {
    const action = enumValue(args, "action", ["get", "set", "clear"] as const);
    if (!action) throw new Error("action is required");
    onlyKeys(args, action === "set"
      ? ["action", "thread_id", "objective", "status", "budget_mode", "token_budget"]
      : ["action", "thread_id"]);
    const threadId = requiredString(args, "thread_id", 200);
    const params: Record<string, unknown> = { threadId };
    if (action === "set") {
      const mode = enumValue(args, "budget_mode", ["preserve", "unlimited", "fixed"] as const);
      if (!mode) throw new Error("budget_mode is required for set: choose preserve, unlimited, or fixed explicitly");
      if (mode === "fixed") {
        if (!Number.isSafeInteger(args.token_budget) || (args.token_budget as number) < 1) {
          throw new Error("fixed budget_mode requires a positive safe-integer token_budget; the maximum is a lossless transport bound");
        }
        params.tokenBudget = args.token_budget;
      } else {
        if (Object.hasOwn(args, "token_budget")) throw new Error("token_budget is accepted only with budget_mode=fixed");
        if (mode === "unlimited") params.tokenBudget = null;
      }
      if (args.objective !== undefined) {
        if (args.objective !== null && typeof args.objective !== "string") {
          throw new Error("objective must be a string or null");
        }
        // Native validates objective length/emptiness; do not introduce a
        // competing JavaScript character count, trim, or truncation rule.
        params.objective = args.objective;
      }
      if (args.status !== undefined) {
        params.status = args.status === null ? null : enumValue(args, "status", GOAL_STATUSES);
      }
    }
    if (action === "set" && typeof params.objective === "string") {
      preflightEcho({ goal: { threadId, objective: params.objective } }, MAX_GOAL_RESULT_BYTES, "goal");
    }
    const response = await this.appServer.request(`thread/goal/${action}`, params);
    return exactGoalResponse(response, action, threadId);
  }

  async #queue(args: Record<string, unknown>): Promise<unknown> {
    const action = enumValue(args, "action", QUEUE_ACTIONS);
    if (!action) throw new Error("action is required");
    const fields = {
      list: ["cursor", "limit"], add: ["text", "client_user_message_id"],
      update: ["text", "queued_submission_id"], delete: ["queued_submission_id"],
      reorder: ["queued_submission_ids"],
    };
    onlyKeys(args, ["action", "thread_id", ...fields[action]]);
    const params: Record<string, unknown> = { threadId: requiredString(args, "thread_id", 200) };
    const expected: { submissionId?: string; clientUserMessageId?: string } = {};
    if (action === "list") {
      params.limit = optionalInteger(args, "limit", 1, QUEUE_PAGE_LIMIT) ?? 20;
      const cursor = optionalString(args, "cursor", 10_000);
      if (cursor !== undefined) params.cursor = cursor;
    }
    if (action === "add" || action === "update") {
      params.input = [{ type: "text", text: requiredString(args, "text"), text_elements: [] }];
    }
    if (action === "add") {
      expected.clientUserMessageId = requiredString(args, "client_user_message_id", 200);
      params.clientUserMessageId = expected.clientUserMessageId;
    }
    if (action === "update" || action === "delete") {
      expected.submissionId = requiredString(args, "queued_submission_id", 200);
      params.queuedSubmissionId = expected.submissionId;
    }
    if (action === "reorder") {
      const ids = args.queued_submission_ids;
      if (!Array.isArray(ids) || ids.length > QUEUE_PAGE_LIMIT || ids.some(id =>
        typeof id !== "string" || id.trim().length === 0 || id.length > 200)) {
        throw new Error("queued_submission_ids must be an array of at most 100 non-empty native IDs, each at most 200 characters");
      }
      params.queuedSubmissionIds = ids;
    }
    if (action === "add" || action === "update") {
      const item = { id: expected.submissionId ?? "", input: params.input, clientUserMessageId: expected.clientUserMessageId ?? "" };
      // A one-item list must fit too; reserve covers currently unknown fields.
      preflightEcho({ data: [item], nextCursor: null }, MAX_QUEUE_RESULT_BYTES, "queue");
    }
    const response = await this.appServer.request("thread/queue/" + action, params);
    return exactQueueResponse(response, action, expected);
  }

  async #turn(args: Record<string, unknown>): Promise<unknown> {
    onlyKeys(args, ["text", "thread_id", "cwd", "model", "effort", "sandbox", "approval_policy"]);
    const text = requiredString(args, "text");
    const requestedThreadId = optionalString(args, "thread_id", 200);
    const cwd = this.#cwd(args);
    if (!requestedThreadId && !cwd) {
      throw new Error(
        `cwd is required when thread_id is omitted and must be an ${this.platformPolicy.nativeCwdDescription}`,
      );
    }
    const model = optionalString(args, "model", 100);
    const effort = optionalString(args, "effort", 32);
    const sandbox = enumValue(args, "sandbox", ["read-only", "workspace-write", "danger-full-access"] as const);
    const approvalPolicy = enumValue(args, "approval_policy", ["untrusted", "on-request", "never"] as const);
    await this.#validateExecutionOverrides(model, effort);
    const overrides = {
      ...(cwd ? { cwd } : {}),
      ...(model ? { model } : {}),
      ...(sandbox ? { sandbox } : {}),
      ...(approvalPolicy ? { approvalPolicy } : {}),
    };

    const threadResult = requestedThreadId
      ? await this.appServer.request("thread/resume", {
          threadId: requestedThreadId,
          excludeTurns: true,
          ...overrides,
        })
      : await this.appServer.request("thread/start", {
          ...overrides,
          serviceName: "local-codex-bridge",
        });
    const threadMethod = requestedThreadId ? "thread/resume" : "thread/start";
    const threadId = extractThreadId(threadResult, threadMethod);
    if (requestedThreadId && threadId !== requestedThreadId) {
      throw new Error("thread/resume returned a different thread id");
    }
    const sandboxPolicy = sandbox
      ? extractSandboxPolicy(threadResult, threadMethod, sandbox)
      : undefined;
    const effectiveApprovalPolicy = approvalPolicy
      ? extractApprovalPolicy(threadResult, threadMethod, approvalPolicy)
      : undefined;
    this.appServer.runtime.ensureThread(threadId);
    const turnResult = await this.appServer.request("turn/start", {
      threadId,
      input: [{ type: "text", text, text_elements: [] }],
      ...(cwd ? { cwd } : {}),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(sandboxPolicy ? { sandboxPolicy } : {}),
      ...(effectiveApprovalPolicy ? { approvalPolicy: effectiveApprovalPolicy } : {}),
    });
    const turnId = extractTurnId(turnResult, "turn/start");
    this.appServer.runtime.markTurnAccepted(threadId, turnId);
    const turn = asObject(turnResult, "turn/start result").turn as Record<string, unknown>;
    return {
      accepted: true,
      thread_id: threadId,
      turn_id: turnId,
      event_cursor: this.appServer.runtime.currentCursor(threadId),
      status: typeof turn.status === "string" ? turn.status : "inProgress",
    };
  }

  async #observe(args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    throwIfAborted(signal);
    onlyKeys(args, ["thread_id", "cursor", "limit", "wait_ms", "view"]);
    const threadId = requiredString(args, "thread_id", 200);
    const cursor = optionalInteger(args, "cursor", 0, Number.MAX_SAFE_INTEGER);
    const limit = optionalInteger(args, "limit", 1, 100) ?? 50;
    const waitMs = optionalInteger(args, "wait_ms", 0, MAX_OBSERVE_WAIT_MS) ?? 0;
    const view = args.view ?? "compact";
    if (view !== "compact" && view !== "raw") throw new Error("view must be compact or raw");
    const runtime = view === "compact"
      ? await this.appServer.runtime.observeCompactWithWait(threadId, cursor, limit, waitMs, signal)
      : waitMs === 0
        ? this.appServer.runtime.observe(threadId, cursor, limit)
        : await this.appServer.runtime.observeWithWait(threadId, cursor, limit, waitMs, signal);
    throwIfAborted(signal);
    if (runtime) {
      return runtime;
    }
    throwIfAborted(signal);
    const result = await this.appServer.request("thread/read", {
      threadId,
      includeTurns: false,
    });
    throwIfAborted(signal);
    const storedThread = asObject(responseRecord(result, "thread/read").thread, "thread/read result.thread");
    return sanitizeForTransport({
      runtime_available: false,
      live_state_reconstructable: false,
      note: "This Bridge process has no live runtime for the thread. Live events, pending requests, live cursor, active turn, and terminal are unknown. Page persisted history with codex_history.",
      runtime_status: "not_reconstructable",
      active_turn_id: null,
      events: [],
      next_cursor: 0,
      current_cursor: 0,
      cursor_floor: 0,
      cursor_lost: false,
      stream_lost: false,
      facts_lost: false,
      has_more: false,
      pending_requests: [],
      terminal: null,
      unavailable_live_fields: ["active_turn_id", "terminal", "events", "next_cursor", "current_cursor", "cursor_floor", "cursor_lost", "stream_lost", "facts_lost", "has_more", "pending_requests"],
      stored_thread: { ...storedThread, turns: [] },
      source: "codex_app_server_thread_read_metadata",
    });
  }

  async #steer(args: Record<string, unknown>): Promise<unknown> {
    onlyKeys(args, ["thread_id", "expected_turn_id", "text"]);
    const threadId = requiredString(args, "thread_id", 200);
    const expectedTurnId = requiredString(args, "expected_turn_id", 200);
    const text = requiredString(args, "text");
    const result = responseRecord(
      await this.appServer.request("turn/steer", {
        threadId,
        expectedTurnId,
        input: [{ type: "text", text, text_elements: [] }],
      }),
      "turn/steer",
    );
    if (typeof result.turnId !== "string" || result.turnId.length === 0) {
      throw new Error("turn/steer returned no turn id");
    }
    if (result.turnId !== expectedTurnId) {
      throw new Error("turn/steer returned a different turn id");
    }
    return { accepted: true, thread_id: threadId, turn_id: result.turnId };
  }

  async #respond(args: Record<string, unknown>): Promise<unknown> {
    onlyKeys(args, [
      "request_id",
      "thread_id",
      "turn_id",
      "method",
      "decision",
      "execpolicy_amendment",
      "network_policy_amendment",
      "answers",
      "permissions",
      "scope",
      "response",
    ]);
    const requestIdValue = args.request_id;
    if (
      !(
        (typeof requestIdValue === "string" && requestIdValue.length > 0) ||
        (typeof requestIdValue === "number" && Number.isInteger(requestIdValue))
      )
    ) {
      throw new Error("request_id must preserve the original non-empty string or integer id");
    }
    const requestId = requestIdValue as RpcId;
    const threadId = requiredString(args, "thread_id", 200);
    const turnId = optionalString(args, "turn_id", 200);
    const method = requiredString(args, "method", 300);
    if (!SUPPORTED_RESPOND_METHODS.has(method)) {
      throw new Error(`Unsupported app-server request method: ${method}; pending request remains observable`);
    }
    const decision = enumValue(args, "decision", ["accept", "acceptForSession", "decline", "cancel"] as const);
    const amendment = args.execpolicy_amendment;
    const networkAmendment = args.network_policy_amendment;
    const answers = args.answers;
    const permissions = args.permissions;
    const scope = enumValue(args, "scope", ["turn", "session"] as const);
    const generic = args.response;
    if (networkAmendment !== undefined && method !== "item/commandExecution/requestApproval") {
      throw new Error("network_policy_amendment is valid only for item/commandExecution/requestApproval");
    }

    let response: Record<string, unknown> | undefined;
    if (method === "item/permissions/requestApproval") {
      if (permissions === undefined) {
        throw new Error("item/permissions/requestApproval requires permissions");
      }
      if (
        decision !== undefined ||
        amendment !== undefined ||
        answers !== undefined ||
        generic !== undefined
      ) {
        throw new Error("item/permissions/requestApproval accepts only permissions and optional scope");
      }
      response = {
        permissions: asObject(permissions, "permissions"),
        ...(scope ? { scope } : {}),
      };
    } else {
      if (permissions !== undefined || scope !== undefined) {
        throw new Error("permissions and scope are valid only for item/permissions/requestApproval");
      }
      const supplied = [
        decision !== undefined,
        amendment !== undefined,
        networkAmendment !== undefined,
        answers !== undefined,
        generic !== undefined,
      ].filter(Boolean).length;
      if (supplied !== 1) {
        throw new Error("Provide exactly one of decision, execpolicy_amendment, network_policy_amendment, answers, or response");
      }
    }

    if (method === "item/permissions/requestApproval") {
      // The exact stable response object was constructed above.
    } else if (
      method === "item/commandExecution/requestApproval" ||
      method === "item/fileChange/requestApproval" ||
      method === "execCommandApproval" ||
      method === "applyPatchApproval"
    ) {
      if (networkAmendment !== undefined) {
        const value = asObject(networkAmendment, "network_policy_amendment");
        onlyKeys(value, ["host", "action"]);
        const host = requiredString(value, "host");
        const action = enumValue(value, "action", ["allow", "deny"] as const);
        if (action === undefined) {
          throw new Error("network_policy_amendment requires action");
        }
        response = { decision: { applyNetworkPolicyAmendment: { network_policy_amendment: { host, action } } } };
      } else if (amendment !== undefined) {
        if (method !== "item/commandExecution/requestApproval" && method !== "execCommandApproval") {
          throw new Error("execpolicy_amendment is valid only for command approval");
        }
        if (!Array.isArray(amendment) || amendment.length === 0 || amendment.some((item) => typeof item !== "string")) {
          throw new Error("execpolicy_amendment must be a non-empty string array");
        }
        response = method === "execCommandApproval"
          ? {
              decision: {
                approved_execpolicy_amendment: {
                  proposed_execpolicy_amendment: amendment,
                },
              },
            }
          : {
              decision: {
                acceptWithExecpolicyAmendment: {
                  execpolicy_amendment: amendment,
                },
              },
            };
      } else if (decision) {
        if (method === "execCommandApproval" || method === "applyPatchApproval") {
          const legacyDecision = decision === "accept"
            ? "approved"
            : decision === "acceptForSession"
              ? "approved_for_session"
              : decision === "cancel"
                ? "abort"
                : { denied: { rejection: "declined by MCP client" } };
          response = { decision: legacyDecision };
        } else {
          response = { decision };
        }
      } else {
        throw new Error("Approval requests require decision, execpolicy_amendment, or network_policy_amendment");
      }
    } else if (method === "item/tool/requestUserInput") {
      response = answers !== undefined ? { answers: asObject(answers, "answers") } : asObject(generic, "response");
    } else {
      if (generic === undefined) {
        throw new Error("This request method requires a generic response object");
      }
      response = asObject(generic, "response");
    }
    if (!response) {
      throw new Error(`No response contract was constructed for ${method}`);
    }

    const pending = this.appServer.runtime.claimPending(requestId, {
      threadId,
      method,
      ...(turnId ? { turnId } : {}),
    });
    if (pending.turnId && !turnId) {
      this.appServer.runtime.releasePending(pending);
      throw new Error("turn_id is required for this pending request");
    }
    try {
      await this.appServer.respond(requestId, response);
    } catch (error) {
      this.appServer.runtime.releasePending(pending);
      throw error;
    }
    this.appServer.runtime.completePending(pending);
    return {
      responded: true,
      request_id: requestId,
      thread_id: threadId,
      turn_id: pending.turnId ?? null,
      method,
    };
  }

  async #interrupt(args: Record<string, unknown>): Promise<unknown> {
    onlyKeys(args, ["thread_id", "turn_id"]);
    const threadId = requiredString(args, "thread_id", 200);
    const turnId = requiredString(args, "turn_id", 200);
    await this.appServer.request("turn/interrupt", { threadId, turnId });
    return { interrupted: true, thread_id: threadId, turn_id: turnId };
  }
}
