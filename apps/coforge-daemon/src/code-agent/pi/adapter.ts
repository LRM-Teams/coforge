import type {
  CodeAgentAdapter,
  AgentRuntimeEvent,
  CodeAgentSession,
  CodeAgentStartOptions,
} from "../contract";
import { agentEnvironment } from "../environment";
import { JsonlProcess } from "../jsonl-process";
import { createAgentActivity } from "../../agent-runtime/agent-activity";

export class PiAgentAdapter implements CodeAgentAdapter {
  readonly provider = "pi" as const;
  readonly #command: readonly string[];

  constructor(options: { command?: readonly string[] } = {}) {
    this.#command = options.command ?? [
      process.execPath,
      new URL("../../../node_modules/.bin/coforge-agent", import.meta.url).pathname,
    ];
  }

  async start(options: CodeAgentStartOptions): Promise<CodeAgentSession> {
    const process = new JsonlProcess(
      this.#command,
      options.agentWorkspaceDirectory,
      agentEnvironment(options.environment),
    );
    const session = new PiAgentSession(process);
    try {
      await process.request({ type: "get_state" });
      await process.request({ type: "get_commands" });
      return session;
    } catch (error) {
      await process.dispose();
      throw error;
    }
  }
}

class PiAgentSession implements CodeAgentSession {
  readonly #process: JsonlProcess;
  readonly #listeners = new Set<(event: AgentRuntimeEvent) => void>();
  #state: "idle" | "running" | "interrupting" | "disposed" = "idle";

  constructor(process: JsonlProcess) {
    this.#process = process;
    process.onRecord((record) => this.#accept(record));
  }

  async prompt(text: string): Promise<void> {
    if (this.#state !== "idle") throw new Error("code agent is already running");
    this.#state = "running";
    try {
      await this.#process.request({ type: "prompt", message: text });
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
    if (this.#state === "interrupting") return;
    this.#state = "interrupting";
    try {
      await this.#process.request({ type: "clear_queue" });
      await this.#process.request({ type: "abort" });
    } catch (error) {
      if (!this.#isDisposed()) this.#state = "running";
      throw error;
    }
  }

  onExit(listener: () => void): () => void {
    return this.#process.onClose(listener);
  }

  async dispose(): Promise<void> {
    if (this.#state === "disposed") return;
    this.#state = "disposed";
    await this.#process.dispose();
  }

  #accept(record: Record<string, unknown>): void {
    if (record.type === "message_update") {
      const update = asRecord(record.assistantMessageEvent);
      if (update?.type === "text_delta" && typeof update.delta === "string") {
        this.#emit({ type: "text-delta", text: update.delta });
      }
      return;
    }
    if (record.type === "tool_execution_start") {
      if (typeof record.toolCallId === "string" && typeof record.toolName === "string") {
        this.#emit({ type: "tool-start", id: record.toolCallId, name: record.toolName });
        const input = asRecord(record.args) ?? asRecord(record.input) ?? asRecord(record.arguments);
        const details =
          typeof input?.command === "string"
            ? input.command
            : typeof input?.path === "string"
              ? input.path
              : record.toolName;
        const activity =
          record.toolName === "bash"
            ? "running_command"
            : record.toolName === "read"
              ? "reading_file"
              : record.toolName === "write"
                ? "writing_file"
                : record.toolName === "edit"
                  ? "editing_file"
                  : "using_tool";
        this.#emit({
          type: "activity",
          activity: createAgentActivity(activity, "info", details, eventTime(record)),
        });
      }
      return;
    }
    if (record.type === "tool_execution_update") {
      const result = asRecord(record.partialResult);
      const text = textContent(result?.content);
      if (typeof record.toolCallId === "string" && text) {
        this.#emit({ type: "tool-output", id: record.toolCallId, text });
      }
      return;
    }
    if (record.type === "tool_execution_end" && typeof record.toolCallId === "string") {
      this.#emit({
        type: "tool-end",
        id: record.toolCallId,
        isError: record.isError === true,
      });
      return;
    }
    if (record.type === "agent_settled") {
      if (this.#state === "idle" || this.#state === "disposed") return;
      const status = this.#state === "interrupting" ? "interrupted" : "completed";
      this.#state = "idle";
      this.#emit({
        type: "completed",
        status,
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

function textContent(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((item) => asRecord(item))
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item!.text as string)
    .join("");
}

function eventTime(record: Readonly<Record<string, unknown>>): string {
  return typeof record.timestamp === "string" && !Number.isNaN(Date.parse(record.timestamp))
    ? record.timestamp
    : new Date().toISOString();
}
