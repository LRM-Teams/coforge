import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import type { AgentSession, AgentSessionIdentity, AgentSessionOptions } from "@coforge/agent";
import {
  type AgentRuntimeEvent,
  type CodeAgentProvider,
  type ProviderDiscoveryOptions,
} from "#src/code-agent/contract";
import { agentEnvironment } from "#src/code-agent/environment";
import { exitFailureMessage } from "#src/code-agent/exit-failure-message";
import { InterruptTracker } from "#src/code-agent/interrupt-tracker";
import { asRecord, errorMessage } from "#src/code-agent/json-record";
import { discoverExternalCodeAgents } from "#src/code-agent/runtime-inventory";
import { discoverAntigravityCatalog } from "./catalog";
import { antigravitySubagentInput, antigravityToolCall } from "./tool-call";
import { readAntigravityUsage } from "./usage";
import { withoutSshSessionVariables } from "./ssh-environment";
import { AntigravityTurnProcess, type AntigravityTurnResult } from "./turn-process";
import { assertAntigravityVersionSupported } from "./version";

/** How long one headless turn may run. agy's own default is unlimited, and it keeps a turn open
 * for the agent's background tasks until this deadline (capped at 30 minutes by agy itself). */
const PRINT_TIMEOUT = "30m";

/**
 * Google's Antigravity CLI (`agy`) is a per-turn provider: every turn is one headless
 * `agy --input-format stream-json --output-format stream-json` process that reads the prompt from
 * stdin and exits when the turn ends. A conversation continues with `--conversation <id>`, the id
 * each turn's `init` frame reports. agy has no system-prompt flag, so the standing Agent
 * instructions are the whole prompt of a fresh conversation's first turn; a resumed conversation
 * never resends them.
 */
export class AntigravityProvider implements CodeAgentProvider {
  readonly provider = RUNTIME_PROVIDER.ANTIGRAVITY;
  readonly #command: readonly string[];

  constructor(options: { command?: readonly string[] } = {}) {
    this.#command = options.command ?? ["agy"];
  }

  async discoverRuntime(options: ProviderDiscoveryOptions = {}) {
    return (
      await discoverExternalCodeAgents(
        options.probe,
        options.environment,
        options.platform,
        RUNTIME_PROVIDER.ANTIGRAVITY,
      )
    )[0];
  }

  async discoverModelCatalog(options: ProviderDiscoveryOptions = {}) {
    return discoverAntigravityCatalog(
      options.command ?? [...this.#command, "models"],
      options.cwd ?? process.cwd(),
      options.environment ?? Bun.env,
    );
  }

  async readUsage(options: { workingDirectory: string; timeoutMs?: number }) {
    return readAntigravityUsage(options.workingDirectory, {
      command: this.#command,
      timeoutMs: options.timeoutMs,
    });
  }

  async createAgentSession(options: AgentSessionOptions): Promise<AgentSession> {
    if (options.sessionId !== undefined && !options.sessionId.trim())
      throw new Error("Invalid session ID");
    await assertAntigravityVersionSupported(this.#command);
    const session = new AntigravityAgentSession(options, this.#command);
    if (!options.sessionId) {
      // A fresh conversation is established at once with a turn whose only content is the
      // standing instructions; a resumed one spawns nothing until real input arrives.
      try {
        await session.bootstrap();
      } catch (error) {
        await session.dispose().catch(() => undefined);
        throw error;
      }
    }
    return session;
  }
}

type SessionState = "idle" | "running" | "interrupting" | "disposed";
const INTERRUPTED_STATUSES: ReadonlySet<unknown> = new Set(["INTERRUPTED", "CANCELED"]);
type QueuedInput = { text: string; resolve(): void; reject(error: Error): void };

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

class AntigravityAgentSession implements AgentSession {
  readonly #options: AgentSessionOptions;
  readonly #command: readonly string[];
  readonly #listeners = new Set<(event: AgentRuntimeEvent) => void>();
  readonly #exitListeners = new Set<() => void>();
  readonly #queue: QueuedInput[] = [];
  #state: SessionState = "idle";
  #closed = false;
  #currentTurn: AntigravityTurnProcess | undefined;
  /** Set from a resumed turn's `init` frame when agy could not resume the conversation, until
   * that discarded turn has exited. */
  #conversationLost = false;
  /** The conversation a lost resume replaced, reported once with the replacement's id. */
  #replacedSessionId: string | undefined;
  #sessionId: string | undefined;
  #identity: AgentSessionIdentity | undefined;
  #everCompletedTurn: boolean;
  #resultFailed = false;
  #startedTools = new Set<number>();
  #endedTools = new Set<number>();
  #sessionReports: Promise<void> = Promise.resolve();
  #bootstrap: { resolve(): void; reject(error: Error): void } | undefined;
  #interrupt = new InterruptTracker();

  constructor(options: AgentSessionOptions, command: readonly string[]) {
    this.#options = options;
    this.#command = command;
    this.#sessionId = options.sessionId;
    this.#everCompletedTurn = Boolean(options.sessionId);
    this.#identity = options.sessionId
      ? { sessionId: options.sessionId, state: "resumable" }
      : undefined;
  }

  /** Spawns a fresh conversation's instructions-only turn and resolves once its `init` frame names
   * the conversation, or rejects if that turn ends (or fails to spawn) before one does. */
  async bootstrap(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.#bootstrap = { resolve, reject };
      try {
        this.#spawnTurn(this.#options.instructions);
      } catch (error) {
        this.#settleBootstrap(toError(error));
      }
    });
  }

  async sendMessage(text: string): Promise<void> {
    return this.#deliver(text);
  }

  async notify(text: string): Promise<void> {
    return this.#deliver(text);
  }

  /** Idle delivers immediately as a new turn. Input that arrives while a turn runs is queued and
   * delivered, joined, as the next turn once the running process exits; its promise resolves when
   * that turn has been spawned, not when it finishes. */
  async #deliver(text: string): Promise<void> {
    if (this.#state === "disposed") throw new Error("code agent session is disposed");
    if (this.#state === "idle") {
      this.#spawnTurn(text);
      return;
    }
    return new Promise<void>((resolve, reject) => {
      this.#queue.push({ text, resolve, reject });
    });
  }

  subscribe(listener: (event: AgentRuntimeEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async readSessionIdentity(): Promise<AgentSessionIdentity | undefined> {
    return this.#identity;
  }

  async interrupt(): Promise<void> {
    if (this.#state === "idle" || this.#state === "disposed") return;
    if (this.#interrupt.isPending) return this.#interrupt.begin();
    const interrupted = this.#interrupt.begin();
    this.#state = "interrupting";
    try {
      this.#currentTurn?.interrupt();
    } catch (error) {
      if (!this.#isDisposed()) this.#state = "running";
      this.#interrupt.fail(toError(error));
    }
    return interrupted;
  }

  #isDisposed(): boolean {
    return this.#state === "disposed";
  }

  onExit(listener: () => void): () => void {
    if (this.#closed) {
      queueMicrotask(listener);
      return () => undefined;
    }
    this.#exitListeners.add(listener);
    return () => this.#exitListeners.delete(listener);
  }

  /** A finished turn is not a session exit; `onExit` fires only when the session is torn down. */
  async dispose(): Promise<void> {
    if (this.#state === "disposed") return;
    this.#state = "disposed";
    const disposeError = new Error("code agent session was disposed");
    this.#rejectQueue(disposeError);
    this.#settleBootstrap(disposeError);
    this.#interrupt.fail(disposeError);
    const turn = this.#currentTurn;
    this.#currentTurn = undefined;
    if (turn) await turn.dispose();
    this.#closed = true;
    for (const listener of this.#exitListeners) listener();
    this.#exitListeners.clear();
  }

  #spawnTurn(prompt: string): void {
    this.#state = "running";
    this.#resultFailed = false;
    this.#startedTools = new Set();
    this.#endedTools = new Set();
    if (this.#sessionId) this.#setIdentity("unknown");
    const environment = {
      ...agentEnvironment(
        this.#options.environment && withoutSshSessionVariables(this.#options.environment),
        withoutSshSessionVariables(Bun.env),
        undefined,
        { envVars: this.#options.runtime?.envVars, gitHooks: this.#options.gitHooks },
      ),
      NO_COLOR: "1",
    };
    const turn = new AntigravityTurnProcess(
      this.#buildArgv(),
      prompt,
      this.#options.agentWorkspaceDirectory,
      environment,
    );
    this.#currentTurn = turn;
    turn.onRecord((record) => this.#handleRecord(record));
    void turn.exited.then((result) => this.#onTurnExit(turn, result));
  }

  #buildArgv(): string[] {
    const argv = [
      ...this.#command,
      "--print=",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--dangerously-skip-permissions",
      "--print-timeout",
      PRINT_TIMEOUT,
    ];
    const model = this.#options.runtime?.model;
    if (model && model !== "default") argv.push("--model", model);
    if (this.#sessionId) argv.push("--conversation", this.#sessionId);
    return argv;
  }

  #handleRecord(record: Readonly<Record<string, unknown>>): void {
    if (this.#state === "disposed" || this.#conversationLost) return;
    if (record.event === "init") this.#handleInit(record.conversation_id);
    else if (record.event === "step_update") this.#handleStep(asRecord(record.step_update));
    else if (record.event === "result") this.#handleResult(asRecord(record.result));
  }

  #handleInit(conversationId: unknown): void {
    if (typeof conversationId !== "string" || !conversationId.trim()) return;
    if (this.#sessionId && conversationId !== this.#sessionId) {
      // agy answers a `--conversation` it cannot find with a stderr warning and a brand-new
      // conversation that never saw the standing instructions (observed on 1.2.12/1.2.13; the
      // headless docs do not say). Discard that turn; once it has exited, a fresh conversation
      // is bootstrapped and the same input is sent into it.
      this.#conversationLost = true;
      void this.#currentTurn?.dispose();
      return;
    }
    const reported = conversationId === this.#sessionId;
    this.#sessionId = conversationId;
    this.#setIdentity(this.#everCompletedTurn ? "unknown" : "empty");
    // A resumed turn names the conversation already reported; the turn's completion reports it.
    if (!reported) this.#reportIdentity();
    this.#settleBootstrap();
  }

  /** `agent_response` steps carry the reply as `text_delta`s. Each `tool` step, and each
   * `subagent` step that hands work to subagents, is announced once and ended once, whether agy
   * reports it ACTIVE first or only DONE. A subagent runs on its own: its steps are not in this
   * stream, and its report arrives later as a `system_message`. Other step types (`user_input`,
   * `system_message`, `checkpoint`) carry no Activity. */
  #handleStep(step: Record<string, unknown> | undefined): void {
    if (!step) return;
    if (step.step_type === "agent_response") {
      const text = nonEmpty(step.text_delta);
      if (text) this.#emit({ type: "text-delta", text });
      return;
    }
    const subagent = step.step_type === "subagent";
    if ((!subagent && step.step_type !== "tool") || typeof step.step_index !== "number") return;
    const index = step.step_index;
    const info = asRecord(step.tool_info);
    const id = `${this.#sessionId ?? "agy"}:${index}`;
    if (!this.#startedTools.has(index)) {
      this.#startedTools.add(index);
      const name = nonEmpty(step.tool_name) ?? nonEmpty(info?.name) ?? "unknown_tool";
      this.#emit({
        type: "tool-start",
        id,
        ...(subagent
          ? { name, input: antigravitySubagentInput(step.subagent_info) }
          : antigravityToolCall(name, info?.parameters)),
      });
    }
    if (step.state !== "DONE" || this.#endedTools.has(index)) return;
    this.#endedTools.add(index);
    // A failed step carries an `error` object with `type` and `message` (headless docs).
    const error = asRecord(info?.error);
    const output = error
      ? (nonEmpty(error.message) ?? nonEmpty(error.type))
      : nonEmpty(info?.output);
    if (output) this.#emit({ type: "tool-output", id, text: output });
    this.#emit({ type: "tool-end", id, isError: error !== undefined });
  }

  #handleResult(result: Record<string, unknown> | undefined): void {
    if (!result) return;
    // agy answers the SIGINT of `interrupt()` with an INTERRUPTED (or CANCELED) result; that is
    // the requested stop, which the turn's exit reports as interrupted, not a runtime error.
    if (this.#state === "interrupting" && INTERRUPTED_STATUSES.has(result.status)) return;
    this.#resultFailed = result.status !== "SUCCESS";
    if (!this.#resultFailed) return;
    const status = nonEmpty(result.status) ?? "unknown";
    this.#emit({
      type: "error",
      message: nonEmpty(result.error)?.trim() || `Antigravity turn ended with status ${status}`,
      providerErrorCode: status,
    });
  }

  /** The turn ends at process exit; the `result` frame only records whether it failed. A non-zero
   * or signal exit with no `result` fails the turn with the exit summary and agy's stderr (where
   * it prints sign-in errors and its `AGY_ERROR` line), so the failure explains itself. */
  #onTurnExit(turn: AntigravityTurnProcess, result: AntigravityTurnResult): void {
    if (this.#currentTurn !== turn) return;
    this.#currentTurn = undefined;
    if (this.#conversationLost) {
      this.#restartLostConversation(turn.prompt);
      return;
    }
    this.#settleBootstrap(
      new Error(`Antigravity did not establish a conversation (${exitFailureMessage(result)})`),
    );
    let status: "completed" | "interrupted" | "failed";
    if (this.#state === "interrupting") {
      status = "interrupted";
    } else if (this.#resultFailed) {
      status = "failed";
    } else if (result.exitCode === 0) {
      status = "completed";
      this.#everCompletedTurn = true;
      this.#setIdentity("resumable");
      this.#reportIdentity();
    } else {
      status = "failed";
      this.#emit({ type: "error", message: exitFailureMessage(result) });
    }
    this.#emit({ type: "completed", status });
    this.#interrupt.settle();
    if (this.#state === "disposed") return;
    this.#drainQueueOrIdle();
  }

  /** Bootstraps a fresh conversation after a resume agy could not honor, then sends the input the
   * discarded turn carried - unless that turn was being interrupted, in which case the input is
   * dropped as the interrupt asked. */
  #restartLostConversation(prompt: string): void {
    this.#conversationLost = false;
    this.#replacedSessionId = this.#sessionId;
    this.#sessionId = undefined;
    this.#identity = undefined;
    this.#everCompletedTurn = false;
    if (this.#state === "disposed") return;
    if (this.#state === "interrupting") {
      this.#emit({ type: "completed", status: "interrupted" });
      this.#interrupt.settle();
    } else {
      this.#queue.unshift({ text: prompt, resolve: () => undefined, reject: () => undefined });
    }
    try {
      this.#spawnTurn(this.#options.instructions);
    } catch (error) {
      this.#state = "idle";
      const failure = toError(error);
      this.#emit({ type: "error", message: failure.message });
      // The discarded input was already accepted, so its turn fails visibly rather than vanishing.
      this.#emit({ type: "completed", status: "failed" });
      this.#rejectQueue(failure);
    }
  }

  #drainQueueOrIdle(): void {
    if (this.#queue.length === 0) {
      this.#state = "idle";
      return;
    }
    const entries = this.#queue.splice(0);
    try {
      this.#spawnTurn(entries.map((entry) => entry.text).join("\n\n"));
      for (const entry of entries) entry.resolve();
    } catch (error) {
      this.#state = "idle";
      const failure = toError(error);
      for (const entry of entries) entry.reject(failure);
    }
  }

  #rejectQueue(error: Error): void {
    for (const entry of this.#queue.splice(0)) entry.reject(error);
  }

  /** Resolves a pending bootstrap, or rejects it with `error`; a no-op when none is pending. */
  #settleBootstrap(error?: Error): void {
    const bootstrap = this.#bootstrap;
    this.#bootstrap = undefined;
    if (error) bootstrap?.reject(error);
    else bootstrap?.resolve();
  }

  #setIdentity(state: AgentSessionIdentity["state"]): void {
    if (!this.#sessionId) return;
    if (this.#identity?.sessionId === this.#sessionId && this.#identity.state === state) return;
    this.#identity = { sessionId: this.#sessionId, state };
    this.#emit({ type: "session", identity: this.#identity });
  }

  /** Reports the conversation to the daemon. The first report after a lost resume also names the
   * conversation it replaced, so the daemon invalidates the stale one and tells the person the
   * earlier context was not restored. */
  #reportIdentity(): void {
    const sessionId = this.#sessionId;
    const onSessionId = this.#options.onSessionId;
    if (!sessionId || !onSessionId) return;
    const replaced = this.#replacedSessionId;
    this.#replacedSessionId = undefined;
    this.#sessionReports = this.#sessionReports
      .then(() => onSessionId(sessionId, replaced))
      .catch((error: unknown) => {
        this.#emit({
          type: "error",
          message: errorMessage(error) || "Antigravity session identity report failed",
        });
      });
  }

  #emit(event: AgentRuntimeEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
}
