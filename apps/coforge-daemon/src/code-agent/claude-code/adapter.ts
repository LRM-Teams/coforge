import type {
  CodeAgentAdapter,
  CodeAgentEvent,
  CodeAgentSession,
  CodeAgentStartOptions,
} from "../contract";
import { agentEnvironment } from "../environment";
import { JsonlProcess } from "../jsonl-process";

export class ClaudeCodeAgentAdapter implements CodeAgentAdapter {
  readonly provider = "claude-code" as const;
  readonly #command: readonly string[];

  constructor(options: { command?: readonly string[] } = {}) {
    this.#command = options.command ?? [
      "claude",
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--permission-mode",
      "dontAsk",
      "--no-session-persistence",
    ];
  }

  async start(options: CodeAgentStartOptions): Promise<CodeAgentSession> {
    const process = new JsonlProcess(
      this.#command,
      options.agentWorkspaceDirectory,
      agentEnvironment(options.environment),
    );
    const session = new ClaudeCodeAgentSession(process);
    try {
      await session.ready();
      return session;
    } catch (error) {
      await process.dispose();
      throw error;
    }
  }
}

class ClaudeCodeAgentSession implements CodeAgentSession {
  readonly #process: JsonlProcess;
  readonly #listeners = new Set<(event: CodeAgentEvent) => void>();
  #state: "idle" | "running" | "interrupting" | "disposed" = "idle";
  #pendingInterrupt:
    | { id: string; promise: Promise<void>; resolve(): void; reject(error: Error): void }
    | undefined;

  constructor(process: JsonlProcess) {
    this.#process = process;
    process.onRecord((record) => this.#accept(record));
  }

  async ready(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const id = crypto.randomUUID();
      let unsubscribeRecord: () => void = () => undefined;
      let unsubscribeFailure: () => void = () => undefined;
      const cleanup = () => {
        unsubscribeRecord();
        unsubscribeFailure();
      };
      unsubscribeRecord = this.#process.onRecord((record) => {
        if (record.type !== "control_response") return;
        const response = asRecord(record.response);
        if (response?.request_id !== id) return;
        cleanup();
        const initialization = asRecord(response.response);
        if (response.subtype !== "success" || !Array.isArray(initialization?.commands)) {
          reject(new Error("Claude Code failed to load workspace skills"));
          return;
        }
        resolve();
      });
      unsubscribeFailure = this.#process.onFailure((error) => {
        cleanup();
        reject(error);
      });
      void this.#process
        .send({
          type: "control_request",
          request_id: id,
          request: { subtype: "initialize", hooks: null },
        })
        .catch((error: unknown) => {
          cleanup();
          reject(error);
        });
    });
  }

  async prompt(text: string): Promise<void> {
    if (this.#state !== "idle") throw new Error("code agent is already running");
    this.#state = "running";
    try {
      await this.#process.send({
        type: "user",
        message: { role: "user", content: text },
        parent_tool_use_id: null,
        session_id: "default",
      });
    } catch (error) {
      if (!this.#isDisposed()) this.#state = "idle";
      throw error;
    }
  }

  subscribe(listener: (event: CodeAgentEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async interrupt(): Promise<void> {
    if (this.#state === "idle" || this.#state === "disposed") return;
    if (this.#pendingInterrupt) return this.#pendingInterrupt.promise;
    const id = crypto.randomUUID();
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    this.#pendingInterrupt = { id, promise, resolve, reject };
    this.#state = "interrupting";
    try {
      await this.#process.send({
        type: "control_request",
        request_id: id,
        request: { subtype: "interrupt" },
      });
    } catch (error) {
      this.#pendingInterrupt = undefined;
      if (!this.#isDisposed()) this.#state = "running";
      reject(error instanceof Error ? error : new Error(String(error)));
    }
    return promise;
  }

  async dispose(): Promise<void> {
    if (this.#state === "disposed") return;
    this.#state = "disposed";
    this.#pendingInterrupt?.reject(new Error("code agent process closed"));
    this.#pendingInterrupt = undefined;
    await this.#process.dispose();
  }

  #accept(record: Readonly<Record<string, unknown>>): void {
    if (record.type === "stream_event") {
      const event = asRecord(record.event);
      const delta = asRecord(event?.delta);
      if (
        event?.type === "content_block_delta" &&
        delta?.type === "text_delta" &&
        typeof delta.text === "string"
      ) {
        this.#emit({ type: "text-delta", text: delta.text });
      }
      return;
    }
    if (record.type === "assistant") {
      for (const block of messageContent(record)) {
        if (
          block?.type === "tool_use" &&
          typeof block.id === "string" &&
          typeof block.name === "string"
        ) {
          this.#emit({ type: "tool-start", id: block.id, name: block.name });
        }
      }
      return;
    }
    if (record.type === "user") {
      for (const block of messageContent(record)) {
        if (block?.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
        const text = textContent(block.content);
        if (text) this.#emit({ type: "tool-output", id: block.tool_use_id, text });
        this.#emit({ type: "tool-end", id: block.tool_use_id, isError: block.is_error === true });
      }
      return;
    }
    if (record.type === "control_response") {
      const response = asRecord(record.response);
      const pending = this.#pendingInterrupt;
      if (!response || !pending || response.request_id !== pending.id) return;
      this.#pendingInterrupt = undefined;
      if (response.subtype === "success") pending.resolve();
      else pending.reject(new Error("Claude Code interrupt failed"));
      return;
    }
    if (record.type === "result") {
      if (this.#state !== "running" && this.#state !== "interrupting") return;
      const interrupted = this.#state === "interrupting";
      this.#state = "idle";
      this.#emit({
        type: "completed",
        status: interrupted ? "interrupted" : record.subtype === "success" ? "completed" : "failed",
      });
    }
  }

  #emit(event: CodeAgentEvent): void {
    for (const listener of this.#listeners) listener(event);
  }

  #isDisposed(): boolean {
    return this.#state === "disposed";
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function messageContent(
  record: Readonly<Record<string, unknown>>,
): Array<Record<string, unknown> | undefined> {
  const content = asRecord(record.message)?.content;
  return Array.isArray(content) ? content.map(asRecord) : [];
}

function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map(asRecord)
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block!.text as string)
    .join("");
}
