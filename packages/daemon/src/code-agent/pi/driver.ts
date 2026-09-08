import type {
  AgentDriver,
  AgentRuntimeEvent,
  AgentSession,
  AgentSessionIdentity,
  AgentSessionOptions,
} from "@coforge/agent";
import { AgentSessionRecoveryError, type CodeAgentProvider } from "../contract";
import { agentEnvironment } from "../environment";
import { JsonlProcess, JsonlRequestError } from "../jsonl-process";
import { createAgentActivity } from "../../agent-runtime/agent-activity";
import { toolActivity } from "../tool-activity";
import { RUNTIME_PROVIDER } from "@coforge/protocol";
import {
  createSession,
  getCoforgeAgentDir,
  getCoforgeSessionDir,
  prepareAgentSessionDirectory,
  resolveAgentSessionFile,
} from "@coforge/agent";
import { join } from "node:path";

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
    const command =
      this.#command.length > 0
        ? [...this.#command, "--session-dir", sessionDir]
        : externalPiCommand(sessionDir);
    const process = new JsonlProcess(
      [
        ...command,
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
    const session = new PiAgentSession(process);
    try {
      const state = await process.request({ type: "get_state" });
      await session.acceptState(state.data);
      if (sessionFile) {
        const data = state.data;
        if (
          typeof data !== "object" ||
          data === null ||
          !("sessionId" in data) ||
          data.sessionId !== options.sessionId ||
          !("sessionFile" in data) ||
          data.sessionFile !== sessionFile
        )
          throw new Error("Pi did not resume the requested workspace session");
      }
      if (freshSessionId && asRecord(state.data)?.sessionId !== freshSessionId)
        throw new Error("Pi did not create the requested replacement session");
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
        await process.request({
          type: "set_thinking_level",
          level: runtime.reasoning,
        });
      }
      if (options.onSessionId) {
        const sessionId = asRecord(state.data)?.sessionId;
        if (typeof sessionId !== "string" || !sessionId)
          throw new Error("Pi session identity is unavailable");
        await options.onSessionId(sessionId, replacedSessionId);
      }
      return session;
    } catch (error) {
      await process.dispose();
      if (
        options.sessionId !== undefined &&
        error instanceof JsonlRequestError &&
        /Cannot continue from message role:\s*assistant/i.test(requestErrorMessage(error))
      )
        throw new AgentSessionRecoveryError("provider_replay_rejected");
      throw error;
    }
  }
}

function requestErrorMessage(error: JsonlRequestError): string {
  if (typeof error.responseError === "string") return error.responseError;
  if (typeof error.responseError !== "object" || error.responseError === null) return "";
  const message = Reflect.get(error.responseError, "message");
  return typeof message === "string" ? message : "";
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
      sessionMode: options.sessionMode,
      modelProvider: runtime.modelProvider,
      model: runtime.model,
      reasoning: runtime.reasoning,
      apiKey: runtime.providerConfig.apiKey,
      instructions: options.instructions,
      environment: agentEnvironment(options.environment),
    });
    try {
      await options.onSessionId?.(session.sessionId, session.replacedSessionId);
    } catch (error) {
      await session.dispose();
      throw error;
    }
    return new AgentSessionImpl(
      session,
      options.sessionId !== undefined && !session.replacedSessionId,
    );
  }
}

class AgentSessionImpl implements AgentSession {
  readonly #runtime: Awaited<ReturnType<typeof createSession>>;
  readonly #listeners = new Set<(event: AgentRuntimeEvent) => void>();
  readonly #exitListeners = new Set<() => void>();
  #interrupting = false;
  #failed = false;
  #disposed = false;
  #identity: AgentSessionIdentity;

  constructor(runtime: Awaited<ReturnType<typeof createSession>>, resumed: boolean) {
    this.#runtime = runtime;
    this.#identity = {
      sessionId: runtime.sessionId,
      state: resumed ? "resumable" : "empty",
    };
    runtime.session.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta")
        this.#emit({
          type: "text-delta",
          text: event.assistantMessageEvent.delta,
        });
      if (event.type === "message_update" && event.assistantMessageEvent.type === "thinking_delta")
        this.#emit({
          type: "thinking-delta",
          text: event.assistantMessageEvent.delta,
        });
      if (event.type === "tool_execution_start") {
        this.#emit({
          type: "tool-start",
          id: event.toolCallId,
          name: event.toolName,
        });
        this.#emit({
          type: "activity",
          activity: toolActivity(event.toolName, event.args),
        });
      }
      if (event.type === "tool_execution_update") {
        const text = textContent(event.partialResult.content);
        if (text) this.#emit({ type: "tool-output", id: event.toolCallId, text });
      }
      if (event.type === "tool_execution_end")
        this.#emit({
          type: "tool-end",
          id: event.toolCallId,
          isError: event.isError,
        });
      if (
        event.type === "message_end" &&
        event.message.role === "assistant" &&
        event.message.stopReason === "error"
      ) {
        this.#failed = true;
        this.#emit({
          type: "activity",
          activity: createAgentActivity(
            "runtime_error",
            "error",
            event.message.errorMessage ?? "Agent failed",
          ),
        });
      }
      if (event.type === "agent_settled") {
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
    if (this.#disposed || this.#interrupting || this.#runtime.session.isStreaming) {
      throw new Error("code agent cannot accept a new message");
    }
    this.#setIdentity("unknown");
    try {
      await this.#runtime.session.prompt(message);
    } catch (error) {
      this.#emit({
        type: "activity",
        activity: createAgentActivity(
          "runtime_error",
          "error",
          error instanceof Error ? error.message : "Agent failed",
        ),
      });
      this.#emit({ type: "completed", status: "failed" });
      throw error;
    }
  }
  async notify(notice: string) {
    if (this.#disposed || this.#interrupting) {
      throw new Error("code agent cannot accept a notification");
    }
    // SDK prompt completion waits for the whole run; preflight is the public
    // acceptance boundary used by Pi's RPC implementation as well.
    await new Promise<void>((resolve, reject) => {
      void this.#runtime.session
        .prompt(notice, {
          streamingBehavior: "steer",
          preflightResult: (accepted) => {
            if (accepted) resolve();
          },
        })
        .catch(reject);
    });
  }
  subscribe(listener: (event: AgentRuntimeEvent) => void) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  async readSessionIdentity(): Promise<AgentSessionIdentity> {
    if (
      !this.#disposed &&
      this.#runtime.session.sessionFile &&
      (await Bun.file(this.#runtime.session.sessionFile).exists())
    )
      this.#setIdentity("resumable");
    return this.#identity;
  }
  async interrupt() {
    if (this.#runtime.session.isStreaming) {
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
  #setIdentity(state: AgentSessionIdentity["state"]) {
    if (this.#identity.state === state) return;
    this.#identity = { sessionId: this.#identity.sessionId, state };
    this.#emit({ type: "session", identity: this.#identity });
  }
}

class PiAgentSession implements AgentSession {
  readonly #process: JsonlProcess;
  readonly #listeners = new Set<(event: AgentRuntimeEvent) => void>();
  #state: "idle" | "running" | "interrupting" | "disposed" = "idle";
  #identity: AgentSessionIdentity | undefined;

  constructor(process: JsonlProcess) {
    this.#process = process;
    process.onRecord((record) => this.#accept(record));
    process.onFailure((error) =>
      this.#emit({
        type: "activity",
        activity: createAgentActivity("runtime_error", "error", error.message),
      }),
    );
  }

  async sendMessage(text: string): Promise<void> {
    if (this.#state !== "idle") throw new Error("code agent is already running");
    this.#state = "running";
    this.#setIdentity("unknown");
    try {
      await this.#process.request({ type: "prompt", message: text });
    } catch (error) {
      if (!this.#isDisposed()) this.#state = "idle";
      throw error;
    }
  }

  async notify(notice: string): Promise<void> {
    if (this.#state === "disposed" || this.#state === "interrupting") {
      throw new Error("code agent cannot accept a notification");
    }
    const wasIdle = this.#state === "idle";
    this.#state = "running";
    try {
      await this.#process.request({
        type: "prompt",
        message: notice,
        streamingBehavior: "steer",
      });
    } catch (error) {
      if (wasIdle && !this.#isDisposed()) this.#state = "idle";
      throw error;
    }
  }

  subscribe(listener: (event: AgentRuntimeEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async acceptState(value: unknown): Promise<void> {
    const state = asRecord(value);
    if (typeof state?.sessionId !== "string" || !state.sessionId.trim()) return;
    const sessionFile = typeof state.sessionFile === "string" ? state.sessionFile : undefined;
    const persisted = sessionFile ? await Bun.file(sessionFile).exists() : false;
    const identityState =
      state.messageCount === 0 && !persisted ? "empty" : persisted ? "resumable" : "unknown";
    const identity = {
      sessionId: state.sessionId,
      state: identityState,
    } as const;
    if (
      this.#identity &&
      (this.#identity.sessionId !== identity.sessionId || this.#identity.state !== identity.state)
    )
      this.#emit({ type: "session", identity });
    this.#identity = identity;
  }

  async readSessionIdentity(): Promise<AgentSessionIdentity | undefined> {
    if (this.#state !== "disposed") {
      const response = await this.#process.request({ type: "get_state" });
      await this.acceptState(response.data);
    }
    return this.#identity;
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
      if (update?.type === "thinking_delta" && typeof update.delta === "string") {
        this.#emit({ type: "thinking-delta", text: update.delta });
      }
      return;
    }
    if (record.type === "tool_execution_start") {
      if (typeof record.toolCallId === "string" && typeof record.toolName === "string") {
        this.#emit({
          type: "tool-start",
          id: record.toolCallId,
          name: record.toolName,
        });
        const input = asRecord(record.args) ?? asRecord(record.input) ?? asRecord(record.arguments);
        this.#emit({
          type: "activity",
          activity: toolActivity(record.toolName, input, eventTime(record)),
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

  #setIdentity(state: AgentSessionIdentity["state"]): void {
    if (!this.#identity || this.#identity.state === state) return;
    this.#identity = { sessionId: this.#identity.sessionId, state };
    this.#emit({ type: "session", identity: this.#identity });
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
