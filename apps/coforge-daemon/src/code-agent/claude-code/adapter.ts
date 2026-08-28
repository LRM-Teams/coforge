import type {
  CodeAgentAdapter,
  AgentRuntimeEvent,
  CodeAgentSession,
  CodeAgentStartOptions,
} from "../contract";
import { agentEnvironment } from "../environment";
import { JsonlProcess } from "../jsonl-process";
import { createAgentActivity } from "../../agent-runtime/agent-activity";

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
  readonly #listeners = new Set<(event: AgentRuntimeEvent) => void>();
  #state: "idle" | "running" | "interrupting" | "disposed" = "idle";
  #initialized = false;
  #pendingInterrupt:
    | { promise: Promise<void>; resolve(): void; reject(error: Error): void }
    | undefined;

  constructor(process: JsonlProcess) {
    this.#process = process;
    process.onRecord((record) => this.#accept(record));
  }

  async ready(): Promise<void> {
    if (this.#initialized) return;
    await new Promise<void>((resolve, reject) => {
      let unsubscribeRecord: () => void = () => undefined;
      let unsubscribeFailure: () => void = () => undefined;
      const cleanup = () => {
        unsubscribeRecord();
        unsubscribeFailure();
      };
      unsubscribeRecord = this.#process.onRecord((record) => {
        if (record.type === "system" && record.subtype === "init") {
          cleanup();
          resolve();
        }
      });
      unsubscribeFailure = this.#process.onFailure((error) => {
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

  subscribe(listener: (event: AgentRuntimeEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async interrupt(): Promise<void> {
    if (this.#state === "idle" || this.#state === "disposed") return;
    if (this.#pendingInterrupt) return this.#pendingInterrupt.promise;
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    this.#pendingInterrupt = { promise, resolve, reject };
    this.#state = "interrupting";
    try {
      this.#process.interrupt();
    } catch (error) {
      this.#pendingInterrupt = undefined;
      if (!this.#isDisposed()) this.#state = "running";
      reject(error instanceof Error ? error : new Error(String(error)));
    }
    return promise;
  }

  onExit(listener: () => void): () => void {
    return this.#process.onClose(listener);
  }

  async dispose(): Promise<void> {
    if (this.#state === "disposed") return;
    this.#state = "disposed";
    this.#pendingInterrupt?.reject(new Error("code agent process closed"));
    this.#pendingInterrupt = undefined;
    await this.#process.dispose();
  }

  #accept(record: Readonly<Record<string, unknown>>): void {
    if (record.type === "system" && record.subtype === "init") {
      this.#initialized = true;
      return;
    }
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
          const input = asRecord(block.input);
          const details =
            block.name === "Bash" && typeof input?.command === "string"
              ? input.command
              : typeof input?.file_path === "string"
                ? input.file_path
                : block.name;
          const activity =
            block.name === "Bash"
              ? "running_command"
              : block.name === "Read"
                ? "reading_file"
                : block.name === "Write"
                  ? "writing_file"
                  : block.name === "Edit"
                    ? "editing_file"
                    : "using_tool";
          this.#emit({
            type: "activity",
            activity: createAgentActivity(activity, "info", details, eventTime(record)),
          });
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
    if (record.type === "result") {
      const pending = this.#pendingInterrupt;
      if (pending) {
        this.#pendingInterrupt = undefined;
        pending.resolve();
      }
      if (this.#state !== "running" && this.#state !== "interrupting") return;
      const interrupted = this.#state === "interrupting";
      this.#state = "idle";
      this.#emit({
        type: "completed",
        status: interrupted ? "interrupted" : record.subtype === "success" ? "completed" : "failed",
      });
    }
  }

  #emit(event: AgentRuntimeEvent): void {
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

function eventTime(record: Readonly<Record<string, unknown>>): string {
  return typeof record.timestamp === "string" && !Number.isNaN(Date.parse(record.timestamp))
    ? record.timestamp
    : new Date().toISOString();
}
