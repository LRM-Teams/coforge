import type {
  AgentDriver,
  AgentRuntimeEvent,
  AgentSession,
  AgentSessionIdentity,
  AgentSessionOptions,
} from "@coforge/agent";
import { prepareAgentSessionDirectory, resolveAgentSessionFile } from "@coforge/agent";
import { RUNTIME_PROVIDER } from "@coforge/protocol";
import { join } from "node:path";
import { agentEnvironment } from "../../src/code-agent/environment";
import { JsonlProcess } from "../../src/code-agent/jsonl-process";
import { toolActivity } from "../../src/code-agent/tool-activity";

/** Test-only adapter for deterministic subprocess fixtures that speak Pi's legacy JSONL RPC. */
export class PiJsonlFixtureDriver implements AgentDriver {
  readonly provider = RUNTIME_PROVIDER.PI;

  constructor(private readonly command: readonly string[]) {}

  async createAgentSession(options: AgentSessionOptions): Promise<AgentSession> {
    const sessionDir = join(options.agentWorkspaceDirectory, ".pi-sessions");
    await prepareAgentSessionDirectory(options.agentWorkspaceDirectory, sessionDir);
    let sessionFile: string | undefined;
    let replacedSessionId: string | undefined;
    if (options.sessionId !== undefined && options.sessionMode !== "create") {
      try {
        sessionFile = await resolveAgentSessionFile(
          options.agentWorkspaceDirectory,
          sessionDir,
          options.sessionId,
        );
      } catch (error) {
        if (error instanceof Error && error.message === "Session not found in Agent workspace")
          replacedSessionId = options.sessionId;
        else throw error;
      }
    }
    const freshSessionId =
      options.sessionMode === "create"
        ? options.sessionId
        : replacedSessionId
          ? crypto.randomUUID()
          : undefined;
    const process = new JsonlProcess(
      [
        ...this.command,
        "--session-dir",
        sessionDir,
        ...(freshSessionId
          ? ["--session-id", freshSessionId]
          : sessionFile
            ? ["--session", sessionFile]
            : []),
        "--system-prompt",
        options.instructions,
      ],
      options.agentWorkspaceDirectory,
      agentEnvironment({
        ...options.environment,
        COFORGE_AGENT_INSTRUCTIONS: options.instructions,
      }),
    );
    const session = new PiJsonlFixtureSession(process);
    try {
      const state = await process.request({ type: "get_state" });
      await session.acceptState(state.data);
      await process.request({ type: "get_commands" });
      if (options.runtime?.model) {
        await process.request({
          type: "set_model",
          provider: options.runtime.modelProvider,
          modelId: options.runtime.model,
        });
      }
      if (options.runtime?.reasoning) {
        await process.request({
          type: "set_thinking_level",
          level: options.runtime.reasoning,
        });
      }
      const sessionId = asRecord(state.data)?.sessionId;
      if (typeof sessionId !== "string" || !sessionId)
        throw new Error("Pi JSONL fixture session identity is unavailable");
      await options.onSessionId?.(sessionId, replacedSessionId);
      return session;
    } catch (error) {
      await process.dispose();
      throw error;
    }
  }
}

class PiJsonlFixtureSession implements AgentSession {
  readonly #listeners = new Set<(event: AgentRuntimeEvent) => void>();
  #state: "idle" | "running" | "interrupting" | "disposed" = "idle";
  #identity: AgentSessionIdentity | undefined;

  constructor(private readonly process: JsonlProcess) {
    process.onRecord((record) => this.#accept(record));
  }

  async sendMessage(text: string) {
    if (this.#state !== "idle") throw new Error("code agent is already running");
    this.#state = "running";
    this.#setIdentity("unknown");
    try {
      await this.process.request({ type: "prompt", message: text });
    } catch (error) {
      if (!this.#isDisposed()) this.#state = "idle";
      throw error;
    }
  }

  async notify(notice: string) {
    if (this.#state === "disposed" || this.#state === "interrupting")
      throw new Error("code agent cannot accept a notification");
    const wasIdle = this.#state === "idle";
    this.#state = "running";
    try {
      await this.process.request({ type: "prompt", message: notice, streamingBehavior: "steer" });
    } catch (error) {
      if (wasIdle && !this.#isDisposed()) this.#state = "idle";
      throw error;
    }
  }

  subscribe(listener: (event: AgentRuntimeEvent) => void) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async acceptState(value: unknown) {
    const state = asRecord(value);
    if (typeof state?.sessionId !== "string" || !state.sessionId.trim()) return;
    const sessionFile = typeof state.sessionFile === "string" ? state.sessionFile : undefined;
    const persisted = sessionFile ? await Bun.file(sessionFile).exists() : false;
    this.#identity = {
      sessionId: state.sessionId,
      state: state.messageCount === 0 && !persisted ? "empty" : persisted ? "resumable" : "unknown",
    };
  }

  async readSessionIdentity() {
    if (this.#state !== "disposed") {
      const response = await this.process.request({ type: "get_state" });
      await this.acceptState(response.data);
    }
    return this.#identity;
  }

  async interrupt() {
    if (this.#state === "idle" || this.#state === "disposed" || this.#state === "interrupting")
      return;
    this.#state = "interrupting";
    await this.process.request({ type: "clear_queue" });
    await this.process.request({ type: "abort" });
  }

  onExit(listener: () => void) {
    return this.process.onClose(listener);
  }

  async dispose() {
    if (this.#state === "disposed") return;
    this.#state = "disposed";
    await this.process.dispose();
  }

  #accept(record: Record<string, unknown>) {
    if (record.type === "tool_execution_start") {
      if (typeof record.toolCallId === "string" && typeof record.toolName === "string") {
        this.#emit({ type: "tool-start", id: record.toolCallId, name: record.toolName });
        this.#emit({
          type: "activity",
          activity: toolActivity(record.toolName, asRecord(record.args)),
        });
      }
      return;
    }
    if (record.type === "agent_settled") {
      if (this.#state === "idle" || this.#state === "disposed") return;
      const status = this.#state === "interrupting" ? "interrupted" : "completed";
      this.#state = "idle";
      this.#emit({ type: "completed", status });
    }
  }

  #emit(event: AgentRuntimeEvent) {
    for (const listener of this.#listeners) listener(event);
  }

  #setIdentity(state: AgentSessionIdentity["state"]) {
    if (!this.#identity || this.#identity.state === state) return;
    this.#identity = { sessionId: this.#identity.sessionId, state };
    this.#emit({ type: "session", identity: this.#identity });
  }

  #isDisposed() {
    return this.#state === "disposed";
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
