import type { AgentSession, AgentSessionIdentity, AgentSessionOptions } from "@coforge/agent";
import type { AgentRuntimeEvent } from "#src/code-agent/contract";
import { agentEnvironment } from "#src/code-agent/environment";
import { exitFailureMessage } from "#src/code-agent/exit-failure-message";
import { InterruptTracker } from "#src/code-agent/interrupt-tracker";
import { errorMessage } from "#src/code-agent/json-record";
import { TurnProcess, type TurnResult } from "./turn-process";
import type { TurnProtocol, TurnReader, TurnRequest, TurnScope } from "./turn-protocol";

type SessionState = "idle" | "running" | "interrupting" | "disposed";
type QueuedInput = { text: string; resolve(): void; reject(error: Error): void };
/** The turn in flight: its process, the input it carries, and the reader of its records. */
type ActiveTurn = {
  process: TurnProcess;
  prompt: string;
  reader: TurnReader;
  /** Its reader stopped it: the rest of its records are dropped. */
  abandoned: boolean;
};

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
  if (!options.sessionId && protocol.instructionsTurn) {
    try {
      await session.bootstrap(protocol.instructionsTurn.identityNoun);
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
    sessionId: () => this.#sessionId,
    interrupting: () => this.#state === "interrupting",
    abandon: () => this.#abandonTurn(),
  };
  readonly #listeners = new Set<(event: AgentRuntimeEvent) => void>();
  readonly #exitListeners = new Set<() => void>();
  readonly #queue: QueuedInput[] = [];
  #state: SessionState = "idle";
  #closed = false;
  #currentTurn: ActiveTurn | undefined;
  #sessionId: string | undefined;
  /** Whether the next turn creates the session (`TurnRequest.creating`). It is cleared once a turn
   * has been spawned that way, never at that turn's exit: a CLI creates the session before the
   * turn can fail, so a failed or interrupted first turn must not be created again. */
  #creating: boolean;
  #identity: AgentSessionIdentity | undefined;
  /** Whether a turn of this session has completed successfully. */
  #everCompletedTurn: boolean;
  /** The session a lost resume replaced, reported once with its replacement. */
  #replacedSessionId: string | undefined;
  /** The id the daemon was last told about (or is being told about). */
  #reportedSessionId: string | undefined;
  #sessionReports: Promise<void> = Promise.resolve();
  #bootstrap: { identityNoun: string; resolve(): void; reject(error: Error): void } | undefined;
  #interrupt = new InterruptTracker();

  constructor(protocol: TurnProtocol, options: AgentSessionOptions) {
    this.#protocol = protocol;
    this.#options = options;
    // A provider that chooses its own session ids is told a session is new when the daemon asks to
    // `create` it, however it got its id (`AgentSessionOptions.sessionMode`); only a `resume`
    // carries a conversation to continue. Every other provider resumes any id it is given.
    const resuming =
      options.sessionId !== undefined &&
      !(protocol.mintSessionId && options.sessionMode === "create");
    this.#sessionId = options.sessionId ?? protocol.mintSessionId?.();
    this.#creating = protocol.mintSessionId !== undefined && !resuming;
    this.#everCompletedTurn = resuming;
    this.#identity = this.#sessionId
      ? { sessionId: this.#sessionId, state: resuming ? protocol.resumedIdentity : "empty" }
      : undefined;
  }

  /** Spawns a fresh session's first (instructions-only) turn and resolves once a record names a
   * session id, or rejects if that turn ends (or fails to spawn) before one does. */
  async bootstrap(identityNoun: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.#bootstrap = { identityNoun, resolve, reject };
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
    const request: TurnRequest = { prompt, sessionId: this.#sessionId, creating: this.#creating };
    const command = this.#protocol.launch(request);
    // Building the command (a protocol may refuse a request) and constructing the process can
    // throw (`Bun.spawn` throws synchronously for a working directory that no longer exists), so
    // the session records the turn as running only once the process exists; a throw leaves it
    // exactly as it was, and the caller reports it.
    const turnProcess = new TurnProcess({
      provider: this.#protocol.provider,
      displayName: this.#protocol.displayName,
      argv: command.argv,
      cwd: this.#options.agentWorkspaceDirectory,
      environment: this.#environment(),
      input: command.input,
    });
    const reader = this.#protocol.openTurn(this.#scope, request);
    const turn: ActiveTurn = { process: turnProcess, prompt, reader, abandoned: false };
    this.#currentTurn = turn;
    this.#state = "running";
    this.#creating = false;
    turnProcess.onRecord((record) => {
      if (this.#state !== "disposed" && !turn.abandoned) reader.read(record);
    });
    void turnProcess.exited.then((result) => this.#onTurnExit(turn, result));
    if (this.#sessionId) this.#setIdentity("unknown");
  }

  #environment(): Record<string, string> {
    const sanitize = this.#protocol.sanitizeEnvironment;
    const declared = this.#options.environment;
    return {
      ...agentEnvironment(
        sanitize && declared ? sanitize(declared) : declared,
        sanitize ? sanitize(Bun.env) : Bun.env,
        undefined,
        { envVars: this.#options.runtime?.envVars, gitHooks: this.#options.gitHooks },
      ),
      ...this.#protocol.environment,
    };
  }

  /** Stops reading the current turn's records and kills its process. */
  #abandonTurn(): void {
    const turn = this.#currentTurn;
    if (!turn) return;
    turn.abandoned = true;
    void turn.process.dispose();
  }

  /** Adopts the session id a record names. A record that repeats the id the session already has
   * counts only when the provider says so (`repeatedSessionId`). */
  #observeSessionId(sessionId: string): void {
    const repeated = sessionId === this.#sessionId;
    if (repeated && this.#protocol.repeatedSessionId === "ignore") return;
    this.#sessionId = sessionId;
    this.#setIdentity(this.#everCompletedTurn ? "unknown" : "empty");
    if (!repeated || this.#protocol.repeatedSessionId === "reaffirm-and-report") {
      this.#reportIdentity();
    }
    this.#settleBootstrap();
  }

  /** Turn end is the process exit, not any record - a record only tells whether the turn reported
   * an error. A clean exit completes the turn; a non-zero or signal exit fails it with the exit
   * summary and the recent stderr lines, so the failure explains itself. */
  #onTurnExit(turn: ActiveTurn, result: TurnResult): void {
    if (this.#currentTurn !== turn) return;
    this.#currentTurn = undefined;
    const interrupted = this.#state === "interrupting";
    if (turn.reader.lostResume?.({ ...result, interrupted })) {
      this.#restartFresh(turn.prompt, interrupted);
      return;
    }
    if (this.#bootstrap) {
      const { displayName } = this.#protocol;
      const { identityNoun } = this.#bootstrap;
      this.#settleBootstrap(
        new Error(
          `${displayName} did not establish ${identityNoun} (${exitFailureMessage(result)})`,
        ),
      );
    }
    let status: "completed" | "interrupted" | "failed";
    if (interrupted) {
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

  /** Starts the session over after a resume the provider could not honour. With an instructions
   * turn, that turn establishes the new session first and the lost turn's input follows it -
   * unless the lost turn was being interrupted, when the input is dropped as the interrupt asked.
   * Without one, the input runs in the new session at once. The replacement is reported once,
   * with the id it replaces, so the daemon invalidates the stale one and tells the person the
   * earlier context was not restored. */
  #restartFresh(prompt: string, interrupted: boolean): void {
    this.#replacedSessionId ??= this.#sessionId;
    this.#sessionId = this.#protocol.mintSessionId?.();
    this.#creating = this.#protocol.mintSessionId !== undefined;
    this.#everCompletedTurn = false;
    // The lost session's identity no longer holds; a provider that chose the replacement's id
    // already has it, the others learn it from the instructions turn.
    this.#identity = undefined;
    this.#setIdentity("empty");
    const instructionsTurn = this.#protocol.instructionsTurn !== undefined;
    if (instructionsTurn) {
      if (interrupted) {
        this.#emit({ type: "completed", status: "interrupted" });
        this.#interrupt.settle();
      } else {
        this.#queue.unshift({ text: prompt, resolve: () => undefined, reject: () => undefined });
      }
    }
    try {
      this.#spawnTurn(instructionsTurn ? this.#options.instructions : prompt);
    } catch (error) {
      this.#state = "idle";
      const failure = toError(error);
      // The discarded input was already accepted, so its turn fails visibly rather than vanishing.
      this.#emit({ type: "error", message: failure.message });
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

  /** Tells the daemon the session's id. The first report after a lost resume also names the
   * session it replaced. */
  #reportIdentity(): void {
    const sessionId = this.#sessionId;
    const onSessionId = this.#options.onSessionId;
    if (!sessionId || !onSessionId) return;
    const oncePerId = this.#protocol.identityReports === "once-per-id";
    if (oncePerId && sessionId === this.#reportedSessionId) return;
    const replaced = this.#replacedSessionId;
    this.#replacedSessionId = undefined;
    if (oncePerId) this.#reportedSessionId = sessionId;
    this.#sessionReports = this.#sessionReports
      .then(() => onSessionId(sessionId, replaced))
      .catch((error: unknown) => {
        if (oncePerId) {
          // A report that fails is retried by the next completed turn.
          if (this.#reportedSessionId === sessionId) this.#reportedSessionId = undefined;
          this.#replacedSessionId ??= replaced;
        }
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
