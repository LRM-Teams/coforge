type JsonRecord = Readonly<Record<string, unknown>>;

interface PendingRequest {
  resolve(value: JsonRecord): void;
  reject(error: Error): void;
}

type ProcessState =
  | Readonly<{ type: "open" }>
  | Readonly<{ type: "failed"; message: string }>
  | Readonly<{ type: "disposed" }>;

export class JsonlProcess {
  readonly #child: Bun.Subprocess<"pipe", "pipe", "pipe">;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #listeners = new Set<(record: JsonRecord) => void>();
  #nextRequestId = 1;
  #state: ProcessState = { type: "open" };

  constructor(
    command: readonly string[],
    cwd: string,
    environment: Readonly<Record<string, string>>,
  ) {
    this.#child = Bun.spawn({
      cmd: [...command],
      cwd,
      env: { ...environment },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    void this.#readStdout();
    void this.#discardStderr();
    void this.#observeExit();
  }

  onRecord(listener: (record: JsonRecord) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async send(message: JsonRecord): Promise<void> {
    this.#assertOpen();
    try {
      this.#child.stdin.write(`${JSON.stringify(message)}\n`);
      await this.#child.stdin.flush();
    } catch {
      const message = "code agent process rejected a message";
      this.#fail(message, true);
      throw new Error(message);
    }
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
    if (this.#state.type === "disposed") return;
    this.#state = { type: "disposed" };
    this.#rejectPending("code agent process closed");
    try {
      this.#child.stdin.end();
    } catch {
      // A failed or exited child may have already closed stdin.
    }
    const exited = await Promise.race([
      this.#child.exited.then(() => true),
      Bun.sleep(1_000).then(() => false),
    ]);
    if (!exited) {
      this.#child.kill("SIGTERM");
      await this.#child.exited;
    }
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
      this.#fail("code agent process produced invalid output", true);
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
    if (this.#state.type === "disposed") throw new Error("code agent process is closed");
  }

  #fail(message: string, terminate = false): void {
    if (this.#state.type !== "open") return;
    this.#state = { type: "failed", message };
    this.#rejectPending(message);
    if (terminate) this.#child.kill("SIGTERM");
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
