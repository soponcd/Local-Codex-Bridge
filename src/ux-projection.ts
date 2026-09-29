import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

export const UX_PROJECTION_ENV = "LOCAL_CODEX_BRIDGE_UX_PROJECTION";
export const LEGACY_UX_PROJECTION_ENV = "LUMEN_CODEX_V2_UX_PROJECTION";

export interface UxCounts {
  active: number;
  waiting: number;
  terminal: number;
}

export type UxSignalKind = "waiting_approval" | "waiting_user_input" | "terminal";

export interface UxSignalInput {
  kind: UxSignalKind;
  thread_id: string;
  turn_id: string | null;
  status: string;
}

export interface UxSignal extends UxSignalInput {
  sequence: number;
  at: string;
}

export interface UxProjectionDocument {
  schema_version: 1;
  generation: {
    id: string;
    pid: number;
    started_at: string;
  };
  sequence: number;
  counts: UxCounts;
  signals: UxSignal[];
}

export interface UxProjectionSink {
  publish(counts: UxCounts, signal?: UxSignalInput): void;
  close(): void;
}

export interface UxProjectionIO {
  mkdirSync: typeof mkdirSync;
  writeFileSync: typeof writeFileSync;
  renameSync: typeof renameSync;
  rmSync: typeof rmSync;
}
const DEFAULT_IO: UxProjectionIO = { mkdirSync, writeFileSync, renameSync, rmSync };

export class AtomicUxProjection implements UxProjectionSink {
  readonly #generation = {
    id: randomUUID(),
    pid: process.pid,
    started_at: new Date().toISOString(),
  };
  readonly #signals: UxSignal[] = [];
  #sequence = 0;

  constructor(
    readonly filePath: string,
    private readonly signalLimit = 32,
    private readonly io: UxProjectionIO = DEFAULT_IO,
  ) {
    if (!isAbsolute(filePath)) {
      throw new Error(`${UX_PROJECTION_ENV} must be an absolute path`);
    }
    if (!Number.isInteger(signalLimit) || signalLimit < 1 || signalLimit > 256) {
      throw new Error("signalLimit must be an integer from 1 through 256");
    }
  }

  publish(counts: UxCounts, signal?: UxSignalInput): void {
    if (signal) {
      this.#sequence += 1;
      this.#signals.push({
        ...signal,
        sequence: this.#sequence,
        at: new Date().toISOString(),
      });
      if (this.#signals.length > this.signalLimit) {
        this.#signals.splice(0, this.#signals.length - this.signalLimit);
      }
    }
    const document: UxProjectionDocument = {
      schema_version: 1,
      generation: this.#generation,
      sequence: this.#sequence,
      counts: { ...counts },
      signals: [...this.#signals],
    };
    this.#writeAtomic(`${JSON.stringify(document)}\n`);
  }

  close(): void {
    this.io.rmSync(this.filePath, { force: true });
  }

  #writeAtomic(content: string): void {
    const directory = dirname(this.filePath);
    this.io.mkdirSync(directory, { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      this.io.writeFileSync(temporary, content, { encoding: "utf8", flag: "wx" });
      this.io.renameSync(temporary, this.filePath);
    } finally {
      // Cleanup is best-effort and must not replace a write/rename failure.
      try { this.io.rmSync(temporary, { force: true }); } catch { /* optional temporary file */ }
    }
  }
}

export function createUxProjectionFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): UxProjectionSink | undefined {
  const configured =
    environment[UX_PROJECTION_ENV]?.trim() ||
    environment[LEGACY_UX_PROJECTION_ENV]?.trim();
  return configured ? new AtomicUxProjection(resolve(configured)) : undefined;
}
