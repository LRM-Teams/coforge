import {
  ProcessTreeOwner,
  type OwnedChildProcess,
  type OwnedProcessTree,
  type ProcessTreeSpawner,
} from "../platform/process-tree";
import { AgentProcessCleanupError } from "./contract";

type JsonRecord = Readonly<Record<string, unknown>>;

interface PendingRequest {
  resolve(value: JsonRecord): void;
  reject(error: Error): void;
}

type ProcessState =
  | Readonly<{ type: "open" }>
  | Readonly<{ type: "failed"; message: string }>
  | Readonly<{ type: "disposing" }>
  | Readonly<{ type: "closed"; failureMessage?: string }>;

export class JsonlProcess {
  readonly #child: OwnedChildProcess;
  readonly #tree: OwnedProcessTree;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #listeners = new Set<(record: JsonRecord) => void>();
  readonly #failureListeners = new Set<(error: Error) => void>();
  readonly #closeListeners = new Set<() => void>();
  #nextRequestId = 1;
  #state: ProcessState = { type: "open" };
  #cleanupPromise: Promise<void> | undefined;

  constructor(
    command: readonly string[],
    cwd: string,
    environment: Readonly<Record<string, string>>,
    processTreeOwner: ProcessTreeSpawner = new ProcessTreeOwner(),
  ) {
    this.#tree = processTreeOwner.spawn(command, cwd, environment);
    this.#child = this.#tree.child;
    void this.#readStdout();
    void this.#discardStderr();
    void this.#observeExit();
  }

  onRecord(listener: (record: JsonRecord) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  onFailure(listener: (error: Error) => void): () => void {
    if (
      this.#state.type === "failed" ||
      (this.#state.type === "closed" && this.#state.failureMessage)
    ) {
      const message =
        this.#state.type === "failed" ? this.#state.message : this.#state.failureMessage!;
      queueMicrotask(() => listener(new Error(message)));
      return () => undefined;
    }
    this.#failureListeners.add(listener);
    return () => this.#failureListeners.delete(listener);
  }

  onClose(listener: () => void): () => void {
    if (this.#state.type === "closed") {
      queueMicrotask(listener);
      return () => undefined;
    }
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  async send(message: JsonRecord): Promise<void> {
    this.#assertOpen();
    try {
      this.#child.stdin.write(`${JSON.stringify(message)}\n`);
      await this.#child.stdin.flush();
    } catch {
      const message = "code agent process rejected a message";
      this.#fail(message);
      throw new Error(message);
    }
  }

  interrupt(): void {
    this.#assertOpen();
    this.#child.kill("SIGINT");
  }

  async request(command: JsonRecord): Promise<JsonRecord> {
    this.#assertOpen();
    const id = `coforge-${this.#nextRequestId++}`;
    const response = new Promise<JsonRecord>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    try {
      await this.send({ ...command, id });
    } catch (error) {
      this.#pending.delete(id);
      void response.catch(() => undefined);
      throw error;
    }
    return response;
  }

  async dispose(): Promise<void> {
    if (this.#state.type === "closed") return;
    if (this.#state.type === "open") {
      this.#state = { type: "disposing" };
      this.#rejectPending("code agent process closed");
    }
    try {
      await this.#cleanup();
    } catch (error) {
      this.#recordFailure(error instanceof Error ? error.message : "code agent cleanup failed");
      throw error;
    }
    this.#state = { type: "closed" };
    this.#notifyClosed();
  }

  async #readStdout(): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of this.#child.stdout) {
        buffer += decoder.decode(chunk, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/, "");
          buffer = buffer.slice(newline + 1);
          if (line) this.#accept(parseRecord(line));
          newline = buffer.indexOf("\n");
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) throw new Error("truncated JSONL record");
    } catch {
      this.#fail("code agent process produced invalid output");
    }
  }

  #accept(record: JsonRecord): void {
    const id = typeof record.id === "string" ? record.id : undefined;
    const pending = id ? this.#pending.get(id) : undefined;
    if (id && pending) {
      this.#pending.delete(id);
      if (record.success === false || record.error !== undefined) {
        pending.reject(new Error("code agent request failed"));
      } else {
        pending.resolve(record);
      }
      return;
    }
    for (const listener of this.#listeners) listener(record);
  }

  async #discardStderr(): Promise<void> {
    try {
      for await (const _chunk of this.#child.stderr) {
        // Drain diagnostics so the child cannot block; provider output is not logged here.
      }
    } catch {
      // Process exit can close stderr while it is being drained.
    }
  }

  async #observeExit(): Promise<void> {
    await this.#child.exited;
    this.#fail("code agent process exited unexpectedly");
  }

  #assertOpen(): void {
    if (this.#state.type === "failed") throw new Error(this.#state.message);
    if (this.#state.type === "closed" && this.#state.failureMessage)
      throw new Error(this.#state.failureMessage);
    if (this.#state.type !== "open") throw new Error("code agent process is closed");
  }

  #fail(message: string): void {
    if (this.#state.type !== "open") return;
    this.#recordFailure(message);
    void this.#cleanup()
      .then(() => {
        const failureMessage = this.#state.type === "failed" ? this.#state.message : message;
        this.#state = { type: "closed", failureMessage };
        this.#notifyClosed();
      })
      .catch((error: unknown) => {
        this.#recordFailure(error instanceof Error ? error.message : "code agent cleanup failed");
      });
  }

  #recordFailure(message: string): void {
    if (this.#state.type === "closed") return;
    this.#state = { type: "failed", message };
    this.#rejectPending(message);
    for (const listener of this.#failureListeners) listener(new Error(message));
    this.#failureListeners.clear();
  }

  #cleanup(): Promise<void> {
    this.#cleanupPromise ??= this.#cleanupTree();
    return this.#cleanupPromise;
  }

  async #cleanupTree(): Promise<void> {
    try {
      await this.#tree.terminate(false);
    } catch {
      // A bounded tree check below determines whether cleanup was successful.
    }
    let treeExited: boolean;
    try {
      treeExited = await this.#tree.waitForExit(1_000);
    } catch {
      throw new AgentProcessCleanupError();
    }
    if (!treeExited) {
      try {
        await this.#tree.terminate(true);
      } catch {
        // A bounded tree check below determines whether cleanup was successful.
      }
      try {
        treeExited = await this.#tree.waitForExit(1_000);
      } catch {
        throw new AgentProcessCleanupError();
      }
    }
    if (!treeExited) throw new AgentProcessCleanupError();
    try {
      this.#child.stdin.end();
    } catch {
      // An exited child may have already closed stdin.
    }
    await this.#child.exited;
  }

  #notifyClosed(): void {
    for (const listener of this.#closeListeners) listener();
    this.#closeListeners.clear();
  }

  #rejectPending(message: string): void {
    for (const pending of this.#pending.values()) pending.reject(new Error(message));
    this.#pending.clear();
  }
}

function parseRecord(line: string): JsonRecord {
  const value: unknown = JSON.parse(line);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("JSONL value is not a record");
  }
  return value as JsonRecord;
}
