import type { AgentSession, AgentSessionIdentity, AgentSessionOptions } from "@coforge/agent";
import type { AgentRuntimeEvent } from "#src/code-agent/contract";
import { agentEnvironment } from "#src/code-agent/environment";
import { exitFailureMessage } from "#src/code-agent/exit-failure-message";
import { InterruptTracker } from "#src/code-agent/interrupt-tracker";
import { errorMessage } from "#src/code-agent/json-record";
import { TurnProcess, type TurnResult } from "./turn-process";
import type { TurnProtocol, TurnReader, TurnScope } from "./turn-protocol";

type SessionState = "idle" | "running" | "interrupting" | "disposed";
type QueuedInput = { text: string; resolve(): void; reject(error: Error): void };
/** The turn in flight: its process, the input it carries, and the reader of its records. */
type ActiveTurn = { process: TurnProcess; prompt: string; reader: TurnReader };

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * The `AgentSession` of a per-turn provider: every turn is its own child process, and the turn ends
 * when that process exits. A fresh session has no history to resume, so - for a provider that has
 * no system-prompt channel of its own - it is established at once with a first turn whose only
 * content is the standing instructions; a resumed session spawns nothing until real input arrives.
 * The provider's `TurnProtocol` says how to launch a turn and how to read its records.
 */
export async function createPerTurnSession(
  protocol: TurnProtocol,
  options: AgentSessionOptions,
): Promise<AgentSession> {
  const session = new PerTurnAgentSession(protocol, options);
  if (!options.sessionId) {
    try {
      await session.bootstrap();
    } catch (error) {
      await session.dispose().catch(() => undefined);
      throw error;
    }
  }
  return session;
}

class PerTurnAgentSession implements AgentSession {
  readonly #protocol: TurnProtocol;
  readonly #options: AgentSessionOptions;
  readonly #scope: TurnScope = {
    emit: (event) => this.#emit(event),
    observeSessionId: (sessionId) => this.#observeSessionId(sessionId),
  };
  readonly #listeners = new Set<(event: AgentRuntimeEvent) => void>();
  readonly #exitListeners = new Set<() => void>();
  readonly #queue: QueuedInput[] = [];
  #state: SessionState = "idle";
  #closed = false;
  #currentTurn: ActiveTurn | undefined;
  #sessionId: string | undefined;
  #identity: AgentSessionIdentity | undefined;
  /** Whether a turn of this session has completed successfully. */
  #everCompletedTurn: boolean;
  #sessionReports: Promise<void> = Promise.resolve();
  #bootstrap: { resolve(): void; reject(error: Error): void } | undefined;
  #interrupt = new InterruptTracker();

  constructor(protocol: TurnProtocol, options: AgentSessionOptions) {
    this.#protocol = protocol;
    this.#options = options;
    this.#sessionId = options.sessionId;
    this.#everCompletedTurn = Boolean(options.sessionId);
    this.#identity = options.sessionId
      ? { sessionId: options.sessionId, state: "resumable" }
      : undefined;
  }

  /** Spawns a fresh session's first (instructions-only) turn and resolves once a record names a
   * session id, or rejects if that turn ends (or fails to spawn) before one does. */
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

  /** Idle delivers immediately as a new turn. A turn already in flight - including the fresh
   * session's own bootstrap turn - queues the text; queued texts are joined and delivered
   * together as the next turn once the running process exits (resolved once that next turn's
   * process has actually been spawned, never once it finishes). */
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
      this.#currentTurn?.process.interrupt();
    } catch (error) {
      if (!this.#isDisposed()) this.#state = "running";
      this.#interrupt.fail(toError(error));
    }
    return interrupted;
  }

  /** The state can change under a synchronous `interrupt()` (a dispose while the process is being
   * signalled), which the compiler cannot see across the assignment above. */
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

  /** A finished turn is not a session exit - the process it owned is simply gone until the next
   * one is spawned. `onExit` fires only here, when the session itself is torn down. */
  async dispose(): Promise<void> {
    if (this.#state === "disposed") return;
    this.#state = "disposed";
    const disposeError = new Error("code agent session was disposed");
    this.#rejectQueue(disposeError);
    this.#settleBootstrap(disposeError);
    this.#interrupt.fail(disposeError);
    const turn = this.#currentTurn;
    this.#currentTurn = undefined;
    if (turn) await turn.process.dispose();
    this.#closed = true;
    for (const listener of this.#exitListeners) listener();
    this.#exitListeners.clear();
  }

  #spawnTurn(prompt: string): void {
    const command = this.#protocol.launch({ prompt, sessionId: this.#sessionId });
    // Constructing the process is the one step that can throw (`Bun.spawn` throws synchronously
    // for a working directory that no longer exists), so the session records the turn as running
    // only once the process exists; a throw leaves it exactly as it was, and the caller reports it.
    const turnProcess = new TurnProcess({
      provider: this.#protocol.provider,
      displayName: this.#protocol.displayName,
      argv: command.argv,
      cwd: this.#options.agentWorkspaceDirectory,
      environment: this.#environment(),
      input: command.input,
    });
    const reader = this.#protocol.openTurn(this.#scope);
    const turn: ActiveTurn = { process: turnProcess, prompt, reader };
    this.#currentTurn = turn;
    this.#state = "running";
    turnProcess.onRecord((record) => {
      if (this.#state !== "disposed") reader.read(record);
    });
    void turnProcess.exited.then((result) => this.#onTurnExit(turn, result));
    if (this.#sessionId) this.#setIdentity("unknown");
  }

  #environment(): Record<string, string> {
    return {
      ...agentEnvironment(this.#options.environment, Bun.env, undefined, {
        envVars: this.#options.runtime?.envVars,
        gitHooks: this.#options.gitHooks,
      }),
      ...this.#protocol.environment,
    };
  }

  /** Adopts the session id a record names. A record that repeats the id the session already has
   * counts only when the provider says so (`repeatedSessionId`). */
  #observeSessionId(sessionId: string): void {
    if (sessionId === this.#sessionId && this.#protocol.repeatedSessionId === "ignore") return;
    this.#sessionId = sessionId;
    this.#setIdentity(this.#everCompletedTurn ? "unknown" : "empty");
    this.#reportIdentity();
    this.#settleBootstrap();
  }

  /** Turn end is the process exit, not any record - a record only tells whether the turn reported
   * an error. A clean exit completes the turn; a non-zero or signal exit fails it with the exit
   * summary and the recent stderr lines, so the failure explains itself. */
  #onTurnExit(turn: ActiveTurn, result: TurnResult): void {
    if (this.#currentTurn !== turn) return;
    this.#currentTurn = undefined;
    if (this.#bootstrap) {
      const { displayName, identityNoun } = this.#protocol;
      this.#settleBootstrap(
        new Error(
          `${displayName} did not establish ${identityNoun} (${exitFailureMessage(result)})`,
        ),
      );
    }
    let status: "completed" | "interrupted" | "failed";
    if (this.#state === "interrupting") {
      status = "interrupted";
    } else if (turn.reader.failed) {
      // The record that failed the turn already emitted the specific error.
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

  #drainQueueOrIdle(): void {
    if (this.#queue.length === 0) {
      this.#state = "idle";
      return;
    }
    const entries = this.#queue.splice(0);
    const text = entries.map((entry) => entry.text).join("\n\n");
    try {
      this.#spawnTurn(text);
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

  #reportIdentity(): void {
    const sessionId = this.#sessionId;
    const onSessionId = this.#options.onSessionId;
    if (!sessionId || !onSessionId) return;
    this.#sessionReports = this.#sessionReports
      .then(() => onSessionId(sessionId))
      .catch((error: unknown) => {
        this.#emit({
          type: "error",
          message:
            errorMessage(error) || `${this.#protocol.displayName} session identity report failed`,
        });
      });
  }

  #emit(event: AgentRuntimeEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
}
