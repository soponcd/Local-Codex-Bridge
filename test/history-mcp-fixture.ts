import { McpStdioServer } from "../src/mcp.js";
import { RuntimeStore } from "../src/runtime.js";
import { ControlSurface } from "../src/tools.js";
import { historyMcpBytes, HISTORY_MCP_WRAPPER_ALLOWANCE_BYTES, MAX_HISTORY_MCP_BYTES } from "../src/history.js";
import type { AppServerManager } from "../src/app-server.js";

function nearBoundaryPage() {
  const page = (count: number) => ({
    data: Array.from({ length: 10 }, (_, index) => ({ id: `turn-${index}`, text: "\u0001".repeat(count) })),
    nextCursor: null,
    backwardsCursor: null,
  });
  let low = 0;
  let high = 12_000;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = {
      source: "codex_app_server", mode: "history", coverage: "native_persisted_history",
      history_mode: "paginated", kind: "turns", page_granularity: "turn", items_view: "notLoaded", thread_id: "thread-1", ...page(middle),
    };
    if (historyMcpBytes(candidate, "") + HISTORY_MCP_WRAPPER_ALLOWANCE_BYTES <= MAX_HISTORY_MCP_BYTES) low = middle;
    else high = middle - 1;
  }
  return page(low);
}

const runtime = new RuntimeStore();
const appServer = {
  runtime,
  async request(method: string, params: { threadId: string; turnId?: string; cursor?: string }): Promise<unknown> {
    if (method === "thread/read") return { thread: { id: params.threadId, historyMode: params.threadId === "legacy-thread" ? "legacy" : "paginated", turns: [] } };
    if (method !== "thread/turns/list" && method !== "thread/items/list") throw new Error("unexpected native call");
    if (params.threadId === "legacy-thread") return { data: [{ id: "legacy-turn", itemsView: "full", items: [{ id: "legacy-item", type: "agentMessage", text: "legacy full" }] }], nextCursor: null, backwardsCursor: "legacy-reverse" };
    if (params.cursor === "stale") throw new Error("native invalid cursor");
    if (params.cursor === "malformed") return { data: [], nextCursor: 3, backwardsCursor: null };
    if (params.cursor === "redacted") return { data: [{ id: "turn-1", api_key: "secret" }], nextCursor: null, backwardsCursor: null };
    if (params.cursor === "oversized") return { data: [{ id: "turn-1", text: "中\n\"\\".repeat(60_000) }], nextCursor: null, backwardsCursor: null };
    if (params.cursor === "near-boundary") return nearBoundaryPage();
    if (params.cursor === "long-command" || params.cursor === "late-secret") return {
      data: [{ turnId: params.turnId, item: {
        id: "command-1", type: "commandExecution", status: "completed",
        command: "echo audit", cwd: "D:\\work",
        commandActions: [{ type: "unknown", command: "echo audit" }],
        aggregatedOutput: params.cursor === "late-secret"
          ? ("x".repeat(12_001) + "\nAPI_KEY=fixture-only-value\n").padEnd(16_007, "x")
          : "x".repeat(16_007),
        exitCode: 0, durationMs: 123,
      } }],
      nextCursor: "command-next", backwardsCursor: "command-back",
    };
    if (method === "thread/turns/list") return { data: [{ id: "turn-1", status: "completed", items: [] }], nextCursor: "next-turn", backwardsCursor: "reverse-turn" };
    return { data: [{ turnId: params.turnId, startedAtMs: 123, completedAtMs: null, futureField: { preserved: true }, item: { id: "item-1", type: "agentMessage", text: "🌱 exact" } }], nextCursor: null, backwardsCursor: "reverse-item" };
  },
} as unknown as AppServerManager;
let server: McpStdioServer;
server = new McpStdioServer(new ControlSurface(appServer), { onClose: () => server.close() });
server.start();
