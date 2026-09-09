import type {
  AgentDriver,
  AgentRuntimeEvent,
  AgentSession,
  AgentSessionIdentity,
  AgentSessionOptions,
} from "@coforge/agent";
import { AgentSessionRecoveryError, type CodeAgentProvider } from "../contract";
import { agentEnvironment } from "../environment";
import { createAgentActivity } from "../../agent-runtime/agent-activity";
import { toolActivity } from "../tool-activity";
import { RUNTIME_PROVIDER } from "@coforge/protocol";
import {
  createSession,
  getAgentDir,
  getCoforgeAgentDir,
  getCoforgeSessionDir,
} from "@coforge/agent";
import { join } from "node:path";

export class PiDriver implements AgentDriver {
  readonly provider: CodeAgentProvider = RUNTIME_PROVIDER.PI;

  async createAgentSession(options: AgentSessionOptions): Promise<AgentSession> {
    const runtime = options.runtime;
    const credential =
      runtime?.providerConfig?.kind === "coforge" ? runtime.providerConfig : undefined;
    if (credential && credential.providerId !== runtime?.modelProvider)
      throw new Error("Pi runtime provider does not match the selected model");
    if (credential?.apiKey && !runtime?.modelProvider)
      throw new Error("Pi model provider is required for an Agent API key");
    const environment = agentEnvironment(options.environment);
    const hostAgentDir = options.environment?.PI_CODING_AGENT_DIR ?? getAgentDir();
    const created = await createSession({
      cwd: options.agentWorkspaceDirectory,
      agentDir: hostAgentDir,
      sessionDir: join(options.agentWorkspaceDirectory, ".pi-sessions"),
      sessionId: options.sessionId,
      sessionMode: options.sessionMode,
      modelProvider: runtime?.modelProvider,
      model: runtime?.model,
      reasoning: runtime?.reasoning,
      apiKey: credential?.apiKey,
      instructions: options.instructions,
      environment,
      sessionKind: "pi",
    });
    try {
      await options.onSessionId?.(created.sessionId, created.replacedSessionId);
    } catch (error) {
      await created.dispose();
      throw error;
    }
    return new AgentSessionImpl(
      created,
      options.sessionId !== undefined && !created.replacedSessionId,
    );
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
  readonly #pendingPrompts = new Set<Promise<void>>();
  #interrupting = false;
  #failed = false;
  #disposed = false;
  #disposal: Promise<void> | undefined;
  #identity: AgentSessionIdentity;

  constructor(runtime: Awaited<ReturnType<typeof createSession>>, resumed: boolean) {
    this.#runtime = runtime;
    this.#identity = {
      sessionId: runtime.sessionId,
      state: resumed ? "resumable" : "empty",
    };
    runtime.session.subscribe((event) => {
      if (event.type === "agent_start" && (this.#disposed || this.#interrupting)) {
        // A host preflight hook may finish after cancellation began. The SDK
        // only makes that prompt abortable once its run starts.
        void this.#trackPrompt(runtime.session.abort());
      }
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
      }
    });
  }
  async sendMessage(message: string) {
    if (this.#disposed || this.#interrupting || this.#runtime.session.isStreaming) {
      throw new Error("code agent cannot accept a new message");
    }
    this.#setIdentity("unknown");
    try {
      await this.#trackPrompt(this.#runtime.session.prompt(message));
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
      if (/Cannot continue from message role:\s*assistant/i.test(errorMessage(error)))
        throw new AgentSessionRecoveryError("provider_replay_rejected");
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
      void this.#trackPrompt(
        this.#runtime.session.prompt(notice, {
          streamingBehavior: "steer",
          preflightResult: (accepted) => {
            if (accepted) resolve();
          },
        }),
      ).catch(reject);
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
    this.#interrupting = true;
    this.#runtime.session.clearQueue();
    try {
      await this.#runtime.session.abort();
      await Promise.allSettled(this.#pendingPrompts);
    } finally {
      this.#interrupting = false;
    }
  }
  onExit(_listener: () => void) {
    this.#exitListeners.add(_listener);
    return () => this.#exitListeners.delete(_listener);
  }
  dispose() {
    if (this.#disposal) return this.#disposal;
    this.#disposed = true;
    this.#runtime.session.clearQueue();
    this.#disposal = (async () => {
      await this.#runtime.session.abort();
      await Promise.allSettled(this.#pendingPrompts);
      await this.#runtime.dispose();
      for (const listener of this.#exitListeners) listener();
      this.#exitListeners.clear();
    })();
    return this.#disposal;
  }
  #trackPrompt(promise: Promise<void>) {
    this.#pendingPrompts.add(promise);
    void promise.then(
      () => this.#pendingPrompts.delete(promise),
      () => this.#pendingPrompts.delete(promise),
    );
    return promise;
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "";
}
