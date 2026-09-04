import type {
  AgentDriver,
  AgentRuntimeEvent,
  AgentSession,
  AgentSessionOptions,
} from "@coforge/agent";
import type { CodeAgentProvider } from "../contract";
import { agentEnvironment } from "../environment";
import { JsonlProcess } from "../jsonl-process";
import { createAgentActivity, type AgentActivityType } from "../../agent-runtime/agent-activity";
import { RUNTIME_PROVIDER } from "@coforge/protocol";
import { createSession, getCoforgeAgentDir, getCoforgeSessionDir } from "@coforge/agent";
import { join } from "node:path";
import {
  COFORGE_AGENT_INSTRUCTIONS,
  COFORGE_AGENT_INSTRUCTIONS_ENV,
} from "../communication-instructions";

export function externalPiCommand(sessionDir?: string): readonly string[] {
  return ["pi", "--mode", "rpc", ...(sessionDir ? ["--session-dir", sessionDir] : [])];
}

export class PiDriver implements AgentDriver {
  readonly provider: CodeAgentProvider = RUNTIME_PROVIDER.PI;
  readonly #command: readonly string[];

  constructor(options: { command?: readonly string[] } = {}) {
    this.#command = options.command ?? [];
  }

  async createAgentSession(options: AgentSessionOptions): Promise<AgentSession> {
    const runtime = options.runtime;
    if (runtime?.providerConfig?.kind === "coforge")
      throw new Error("CoForge provider config requires the coforge runtime");
    const process = new JsonlProcess(
      this.#command.length > 0
        ? this.#command
        : externalPiCommand(join(options.agentWorkspaceDirectory, ".pi-sessions")),
      options.agentWorkspaceDirectory,
      agentEnvironment({
        ...options.environment,
        [COFORGE_AGENT_INSTRUCTIONS_ENV]: COFORGE_AGENT_INSTRUCTIONS,
      }),
    );
    const session = new PiAgentSession(process);
    try {
      await process.request({ type: "get_state" });
      await process.request({ type: "get_commands" });
      if (runtime?.model) {
        if (!runtime.modelProvider)
          throw new Error("Pi model provider is required when a model is selected");
        await process.request({
          type: "set_model",
          provider: runtime.modelProvider,
          modelId: runtime.model,
        });
      }
      if (runtime?.reasoning) {
        await process.request({ type: "set_thinking_level", level: runtime.reasoning });
      }
      return session;
    } catch (error) {
      await process.dispose();
      throw error;
    }
  }
}

/** CoForge Agent uses the same Pi SDK implementation without a child process. */
export class CoforgeDriver extends PiDriver {
  override readonly provider: CodeAgentProvider = RUNTIME_PROVIDER.COFORGE;

  override async createAgentSession(options: AgentSessionOptions): Promise<AgentSession> {
    const runtime = options.runtime;
    if (runtime?.providerConfig?.kind !== "coforge")
      throw new Error("CoForge runtime provider config is required");
    if (!runtime.providerConfig.apiKey)
      throw new Error("CoForge runtime provider API key is required");
    if (runtime.providerConfig.providerId !== runtime.modelProvider)
      throw new Error("Pi runtime provider does not match the selected model");

    const session = await createSession({
      cwd: options.agentWorkspaceDirectory,
      agentId: options.agentId,
      agentDir: getCoforgeAgentDir(options.agentWorkspaceDirectory),
      sessionDir: getCoforgeSessionDir(options.agentWorkspaceDirectory),
      sessionId: options.sessionId,
      modelProvider: runtime.modelProvider,
      model: runtime.model,
      reasoning: runtime.reasoning,
      apiKey: runtime.providerConfig.apiKey,
      instructions: COFORGE_AGENT_INSTRUCTIONS,
    });
    return new AgentSessionImpl(session);
  }
}

class AgentSessionImpl implements AgentSession {
  readonly #runtime: Awaited<ReturnType<typeof createSession>>;
  readonly #listeners = new Set<(event: AgentRuntimeEvent) => void>();
  readonly #exitListeners = new Set<() => void>();
  #running = false;
  #interrupting = false;
  #failed = false;
  #disposed = false;

  constructor(runtime: Awaited<ReturnType<typeof createSession>>) {
    this.#runtime = runtime;
    runtime.session.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta")
        this.#emit({ type: "text-delta", text: event.assistantMessageEvent.delta });
      if (event.type === "tool_execution_start") {
        this.#emit({ type: "tool-start", id: event.toolCallId, name: event.toolName });
        this.#emit({
          type: "activity",
          activity: createAgentActivity(
            toolActivity(event.toolName),
            "info",
            toolDetails(event.args, event.toolName),
          ),
        });
      }
      if (event.type === "tool_execution_update") {
        const text = textContent(event.partialResult.content);
        if (text) this.#emit({ type: "tool-output", id: event.toolCallId, text });
      }
      if (event.type === "tool_execution_end")
        this.#emit({ type: "tool-end", id: event.toolCallId, isError: event.isError });
      if (
        event.type === "message_end" &&
        event.message.role === "assistant" &&
        event.message.stopReason === "error"
      ) {
        this.#failed = true;
        this.#emit({
          type: "activity",
          activity: createAgentActivity(
            "error",
            "error",
            event.message.errorMessage ?? "Agent failed",
          ),
        });
      }
      if (event.type === "agent_settled") {
        this.#running = false;
        this.#emit({
          type: "completed",
          status: this.#failed ? "failed" : this.#interrupting ? "interrupted" : "completed",
        });
        this.#failed = false;
        this.#interrupting = false;
      }
    });
  }
  async sendMessage(message: string) {
    this.#running = true;
    try {
      await this.#runtime.session.prompt(message);
    } catch (error) {
      this.#running = false;
      this.#emit({
        type: "activity",
        activity: createAgentActivity(
          "error",
          "error",
          error instanceof Error ? error.message : "Agent failed",
        ),
      });
      this.#emit({ type: "completed", status: "failed" });
      throw error;
    }
  }
  async notify(notice: string) {
    await this.sendMessage(notice);
  }
  subscribe(listener: (event: AgentRuntimeEvent) => void) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  async interrupt() {
    if (this.#running) {
      this.#interrupting = true;
      await this.#runtime.session.abort();
    }
  }
  onExit(_listener: () => void) {
    this.#exitListeners.add(_listener);
    return () => this.#exitListeners.delete(_listener);
  }
  async dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    await this.#runtime.dispose();
    for (const listener of this.#exitListeners) listener();
    this.#exitListeners.clear();
  }
  #emit(event: AgentRuntimeEvent) {
    for (const listener of this.#listeners) listener(event);
  }
}

function toolActivity(toolName: string): AgentActivityType {
  return toolName === "bash"
    ? "running_command"
    : toolName === "read"
      ? "reading_file"
      : toolName === "write"
        ? "writing_file"
        : toolName === "edit"
          ? "editing_file"
          : "using_tool";
}

function toolDetails(args: unknown, toolName: string): string {
  const input = asRecord(args);
  return typeof input?.command === "string"
    ? input.command
    : typeof input?.path === "string"
      ? input.path
      : toolName;
}

class PiAgentSession implements AgentSession {
  readonly #process: JsonlProcess;
  readonly #listeners = new Set<(event: AgentRuntimeEvent) => void>();
  #state: "idle" | "running" | "interrupting" | "disposed" = "idle";

  constructor(process: JsonlProcess) {
    this.#process = process;
    process.onRecord((record) => this.#accept(record));
    process.onFailure((error) =>
      this.#emit({
        type: "activity",
        activity: createAgentActivity("error", "error", error.message),
      }),
    );
  }

  async sendMessage(text: string): Promise<void> {
    if (this.#state !== "idle") throw new Error("code agent is already running");
    this.#state = "running";
    try {
      await this.#process.request({ type: "prompt", message: text });
    } catch (error) {
      if (!this.#isDisposed()) this.#state = "idle";
      throw error;
    }
  }

  async notify(notice: string): Promise<void> {
    await this.sendMessage(notice);
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
  if (typeof record.timestamp === "number" && Number.isFinite(record.timestamp)) {
    return new Date(record.timestamp).toISOString();
  }
  return typeof record.timestamp === "string" && !Number.isNaN(Date.parse(record.timestamp))
    ? record.timestamp
    : new Date().toISOString();
}
