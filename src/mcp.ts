import { sanitizeForTransport, type RpcId } from "./runtime.js";
import { ControlSurface, TOOL_DEFINITIONS, TOOL_NAMES } from "./tools.js";
import { historyMcpBytes, MAX_HISTORY_MCP_BYTES, structuredToolResult } from "./history.js";
import { VERSION } from "./version.js";

const JSONRPC_VERSION = "2.0";
const LATEST_PROTOCOL_VERSION = "2025-11-25";
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
  "2024-10-07",
]);
const MAX_LINE_BYTES = 10 * 1024 * 1024;

interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function validId(value: unknown): value is RpcId {
  return typeof value === "string" || (typeof value === "number" && Number.isInteger(value));
}

function idKey(value: RpcId): string {
  return `${typeof value}:${String(value)}`;
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const sanitized = sanitizeForTransport(message, {
    maxStringChars: 4_000,
    totalCharBudget: 4_000,
  });
  return typeof sanitized === "string" ? sanitized : "Tool call failed";
}

function initializeProtocolVersion(params: unknown): string | null {
  const record = asRecord(params);
  if (typeof record?.protocolVersion !== "string") {
    return null;
  }
  return record.protocolVersion;
}

function initializeMetadataError(params: unknown): string | null {
  const record = asRecord(params);
  const capabilities = asRecord(record?.capabilities);
  if (!capabilities) return "initialize requires capabilities object";
  // ClientCapabilities 2025-11-25 has an open set of capabilities, but these
  // known fields (including intermediate containers) must be JSON objects.
  const objectPaths = [
    ["roots"], ["experimental"],
    ["sampling", "context"], ["sampling", "tools"],
    ["elicitation", "form"], ["elicitation", "url"],
    ["tasks", "list"], ["tasks", "cancel"],
    ["tasks", "requests", "sampling", "createMessage"],
    ["tasks", "requests", "elicitation", "create"],
  ];
  for (const path of objectPaths) {
    let container = capabilities;
    const traversed: string[] = [];
    for (const name of path) {
      if (!Object.hasOwn(container, name)) break;
      traversed.push(name);
      const nested = asRecord(container[name]);
      if (!nested) return `initialize capabilities.${traversed.join(".")} must be an object`;
      container = nested;
    }
  }
  const experimental = asRecord(capabilities.experimental);
  if (experimental && Object.values(experimental).some(value => !asRecord(value))) {
    return "initialize capabilities.experimental values must be objects";
  }
  const roots = asRecord(capabilities.roots);
  if (roots && Object.hasOwn(roots, "listChanged") && typeof roots.listChanged !== "boolean") {
    return "initialize capabilities.roots.listChanged must be a boolean";
  }
  const clientInfo = asRecord(record?.clientInfo);
  if (!clientInfo || typeof clientInfo.name !== "string" || typeof clientInfo.version !== "string") {
    return "initialize requires clientInfo with string name and version";
  }
  return null;
}

export interface McpStdioServerOptions {
  onClose: () => void | Promise<void>;
}

export class McpStdioServer {
  readonly #cancelled = new Set<string>();
  readonly #activeRequests = new Set<string>();
  readonly #requestControllers = new Map<string, AbortController>();
  readonly #control: ControlSurface;
  readonly #onClose: () => void | Promise<void>;

  #buffer = Buffer.alloc(0);
  #initialized = false;
  #closing = false;
  #writeChain: Promise<void> = Promise.resolve();

  constructor(control: ControlSurface, options: McpStdioServerOptions) {
    this.#control = control;
    this.#onClose = options.onClose;
  }

  start(): void {
    process.stdin.on("data", this.#onData);
    process.stdin.once("end", this.#onInputClose);
    process.stdin.once("close", this.#onInputClose);
    process.stdin.once("error", this.#onInputError);
    process.stdin.resume();
  }

  async close(): Promise<void> {
    if (this.#closing) {
      return;
    }
    this.#closing = true;
    this.#abortActiveRequests();
    process.stdin.off("data", this.#onData);
    process.stdin.off("end", this.#onInputClose);
    process.stdin.off("close", this.#onInputClose);
    process.stdin.off("error", this.#onInputError);
    process.stdin.pause();
    await this.#writeChain.catch(() => undefined);
  }

  readonly #onData = (chunk: Buffer): void => {
    if (this.#closing) {
      return;
    }
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    while (true) {
      const newline = this.#buffer.indexOf(0x0a);
      if (newline < 0) {
        if (this.#buffer.length > MAX_LINE_BYTES) {
          this.#buffer = Buffer.alloc(0);
          void this.#sendError(undefined, {
            code: -32700,
            message: "MCP stdio JSON line exceeds 10 MiB",
          });
        }
        return;
      }
      if (newline > MAX_LINE_BYTES) {
        this.#buffer = this.#buffer.subarray(newline + 1);
        void this.#sendError(undefined, {
          code: -32700,
          message: "MCP stdio JSON line exceeds 10 MiB",
        });
        continue;
      }
      let line = this.#buffer.subarray(0, newline);
      this.#buffer = this.#buffer.subarray(newline + 1);
      if (line.at(-1) === 0x0d) {
        line = line.subarray(0, -1);
      }
      if (line.length === 0) {
        continue;
      }
      this.#acceptLine(line);
    }
  };

  readonly #onInputClose = (): void => {
    if (!this.#closing) {
      this.#abortActiveRequests();
      void this.#onClose();
    }
  };

  readonly #onInputError = (error: Error): void => {
    if (!this.#closing) {
      this.#abortActiveRequests();
      void this.#sendError(undefined, {
        code: -32603,
        message: `MCP stdin failed: ${safeErrorMessage(error)}`,
      }).finally(() => this.#onClose());
    }
  };

  #acceptLine(line: Buffer): void {
    let message: unknown;
    try {
      message = JSON.parse(line.toString("utf8")) as unknown;
    } catch {
      void this.#sendError(undefined, { code: -32700, message: "Parse error" });
      return;
    }
    const record = asRecord(message);
    if (!record || record.jsonrpc !== JSONRPC_VERSION || typeof record.method !== "string") {
      const id = record && validId(record.id) ? record.id : undefined;
      void this.#sendError(id, { code: -32600, message: "Invalid Request" });
      return;
    }
    if (record.id !== undefined && !validId(record.id)) {
      void this.#sendError(undefined, { code: -32600, message: "Invalid Request" });
      return;
    }
    if (record.id === undefined) {
      this.#handleNotification(record.method, record.params);
      return;
    }
    const key = idKey(record.id);
    if (this.#activeRequests.has(key)) {
      void this.#sendProtocolError(record.id, {
        code: -32600,
        message: "Duplicate request id is already active",
      });
      return;
    }
    const controller = new AbortController();
    this.#activeRequests.add(key);
    this.#requestControllers.set(key, controller);
    void this.#handleRequest(record.id, record.method, record.params, controller.signal).finally(() => {
      this.#activeRequests.delete(key);
      this.#requestControllers.delete(key);
      this.#cancelled.delete(key);
    });
  }

  #handleNotification(method: string, params: unknown): void {
    if (method === "notifications/cancelled") {
      const requestId = asRecord(params)?.requestId;
      if (validId(requestId) && this.#activeRequests.has(idKey(requestId))) {
        const key = idKey(requestId);
        this.#cancelled.add(key);
        this.#requestControllers.get(key)?.abort();
      }
    }
    // notifications/initialized and unknown notifications intentionally have no response.
  }

  async #handleRequest(
    id: RpcId,
    method: string,
    params: unknown,
    signal: AbortSignal,
  ): Promise<void> {
    if (method === "initialize") {
      const protocolVersion = initializeProtocolVersion(params);
      if (protocolVersion === null) {
        await this.#sendError(id, { code: -32602, message: "initialize requires protocolVersion" });
        return;
      }
      const metadataError = initializeMetadataError(params);
      if (metadataError) {
        await this.#sendError(id, { code: -32602, message: metadataError });
        return;
      }
      const initializeResult = {
        protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.has(protocolVersion)
          ? protocolVersion
          : LATEST_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: {
          name: "local-codex-bridge",
          title: "Local Codex Bridge",
          version: VERSION,
        },
      };
      // Tunnel discovery and calls can forward independent initialize handshakes
      // through one long-lived stdio child with no downstream session identity.
      // Validate and negotiate each handshake independently: never cache a
      // client's capabilities/identity or reset native supervision state here.
      this.#initialized = true;
      await this.#sendResult(id, initializeResult);
      return;
    }
    if (!this.#initialized) {
      await this.#sendError(id, { code: -32002, message: "Server not initialized" });
      return;
    }
    if (method === "ping") {
      await this.#sendResult(id, {});
      return;
    }
    if (method === "tools/list") {
      await this.#sendResult(id, { tools: TOOL_DEFINITIONS });
      return;
    }
    if (method !== "tools/call") {
      await this.#sendError(id, { code: -32601, message: `Method not found: ${method}` });
      return;
    }

    const call = asRecord(params);
    const name = call?.name;
    const toolArguments = call?.arguments ?? {};
    if (typeof name !== "string" || !TOOL_NAMES.includes(name)) {
      await this.#sendError(id, { code: -32602, message: "Unknown tool" });
      return;
    }
    if (!asRecord(toolArguments)) {
      await this.#sendError(id, { code: -32602, message: "Tool arguments must be an object" });
      return;
    }

    try {
      const result = await this.#control.call(
        name,
        toolArguments,
        name === "codex_observe" ? signal : undefined,
      );
      if (name === "codex_history" &&
          historyMcpBytes(result, id) > MAX_HISTORY_MCP_BYTES) {
        throw new Error("history_page_too_large: final MCP frame exceeds the lossless byte budget");
      }
      await this.#sendResult(id, structuredToolResult(result));
    } catch (error) {
      await this.#sendResult(id, {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: safeErrorMessage(error) }),
          },
        ],
        isError: true,
      });
    }
  }

  async #sendResult(id: RpcId, result: unknown): Promise<void> {
    if (this.#cancelled.delete(idKey(id))) {
      return;
    }
    await this.#write({ jsonrpc: JSONRPC_VERSION, id, result });
  }

  async #sendError(id: RpcId | undefined, error: RpcError): Promise<void> {
    if (id !== undefined && this.#cancelled.delete(idKey(id))) {
      return;
    }
    await this.#write({
      jsonrpc: JSONRPC_VERSION,
      ...(id !== undefined ? { id } : {}),
      error,
    });
  }

  async #sendProtocolError(id: RpcId, error: RpcError): Promise<void> {
    await this.#write({ jsonrpc: JSONRPC_VERSION, id, error });
  }

  #abortActiveRequests(): void {
    for (const [key, controller] of this.#requestControllers) {
      this.#cancelled.add(key);
      controller.abort();
    }
  }

  async #write(message: unknown): Promise<void> {
    const payload = `${JSON.stringify(message)}\n`;
    const write = async (): Promise<void> => {
      if (!process.stdout.writable) {
        throw new Error("MCP stdout is not writable");
      }
      await new Promise<void>((resolve, reject) => {
        process.stdout.write(payload, "utf8", (error?: Error | null) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    };
    this.#writeChain = this.#writeChain.then(write, write);
    await this.#writeChain;
  }
}
