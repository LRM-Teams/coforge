import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import type { AgentSession, AgentSessionIdentity, AgentSessionOptions } from "@coforge/agent";
import {
  type AgentRuntimeEvent,
  type CodeAgentProvider,
  type ProviderDiscoveryOptions,
} from "../contract";
import { agentEnvironment } from "../environment";
import { asRecord, eventTime } from "../json-record";
import { discoverExternalCodeAgents } from "../runtime-inventory";
import { discoverCursorCatalog } from "./catalog";
import { CursorTurnProcess, type CursorTurnResult } from "./turn-process";

/**
 * Cursor CLI (`cursor-agent`) is a per-turn provider: every turn is its own child process, with
 * the prompt passed as the final argv item (no stdin channel) and the turn ending when that
 * process exits. There is no native system-prompt flag, so the standing Agent instructions are
 * sent as the whole prompt of a fresh session's very first turn; a resumed launch refreshes
 * them once, with its first real input.
 */
export class CursorProvider implements CodeAgentProvider {
  readonly provider = RUNTIME_PROVIDER.CURSOR;
  readonly #command: readonly string[];

  constructor(options: { command?: readonly string[] } = {}) {
    this.#command = options.command ?? ["cursor-agent"];
  }

  async discoverRuntime(options: ProviderDiscoveryOptions = {}) {
    return (
      await discoverExternalCodeAgents(
        options.probe,
        options.environment,
        options.platform,
        RUNTIME_PROVIDER.CURSOR,
      )
    )[0];
  }

  async discoverModelCatalog(options: ProviderDiscoveryOptions = {}) {
    return discoverCursorCatalog(
      options.command ?? [...this.#command, "models"],
      options.cwd ?? process.cwd(),
      options.environment ?? Bun.env,
    );
  }

  async createAgentSession(options: AgentSessionOptions): Promise<AgentSession> {
    if (options.sessionId !== undefined && !options.sessionId.trim())
      throw new Error("Invalid session ID");
    const session = new CursorAgentSession(options, this.#command);
    if (!options.sessionId) {
      // A fresh session has no history to resume, so CoForge establishes it immediately with a
      // first turn whose only content is the standing instructions - there is no other way to
      // hand Cursor a system prompt. A resumed session spawns nothing until real input arrives.
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

type PendingOutcome = "success" | "failed" | undefined;
type SessionState = "idle" | "running" | "interrupting" | "disposed";

class CursorAgentSession implements AgentSession {
  readonly #options: AgentSessionOptions;
  readonly #command: readonly string[];
  readonly #listeners = new Set<(event: AgentRuntimeEvent) => void>();
  readonly #exitListeners = new Set<() => void>();
  readonly #queue: Array<{ text: string; resolve(): void; reject(error: Error): void }> = [];
  #state: SessionState = "idle";
  #closed = false;
  #currentTurn: CursorTurnProcess | undefined;
  #sessionId: string | undefined;
  #instructionsPending: boolean;
  #resumeId: string | undefined;
  #identity: AgentSessionIdentity | undefined;
  #everCompletedTurn: boolean;
  #pendingOutcome: PendingOutcome;
  #sessionReports: Promise<void> = Promise.resolve();
  #bootstrap: { resolve(): void; reject(error: Error): void } | undefined;
  #pendingInterrupt:
    | { promise: Promise<void>; resolve(): void; reject(error: Error): void }
    | undefined;

  constructor(options: AgentSessionOptions, command: readonly string[]) {
    this.#options = options;
    this.#command = command;
    this.#resumeId = options.sessionId;
    this.#instructionsPending = Boolean(options.sessionId);
    this.#sessionId = options.sessionId;
    this.#everCompletedTurn = Boolean(options.sessionId);
    this.#identity = options.sessionId
      ? { sessionId: options.sessionId, state: "resumable" }
      : undefined;
  }

  /** Spawns a fresh session's first (instructions-only) turn and resolves once its `system/init`
   * frame names a session id, or rejects if that turn ends (or fails to spawn) before one does. */
  async bootstrap(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.#bootstrap = { resolve, reject };
      try {
        this.#spawnTurn(this.#options.instructions);
      } catch (error) {
        this.#bootstrap = undefined;
        reject(error instanceof Error ? error : new Error(String(error)));
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
      this.#currentTurn?.interrupt();
    } catch (error) {
      this.#pendingInterrupt = undefined;
      if (!this.#isDisposed()) this.#state = "running";
      reject(error instanceof Error ? error : new Error(String(error)));
    }
    return promise;
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

  /** A finished turn is not a session exit - the process it owned is simply gone until the next
   * one is spawned. `onExit` fires only here, when the session itself is torn down. */
  async dispose(): Promise<void> {
    if (this.#state === "disposed") return;
    this.#state = "disposed";
    const disposeError = new Error("code agent session was disposed");
    this.#rejectQueue(disposeError);
    if (this.#bootstrap) {
      const reject = this.#bootstrap.reject;
      this.#bootstrap = undefined;
      reject(disposeError);
    }
    if (this.#pendingInterrupt) {
      const pending = this.#pendingInterrupt;
      this.#pendingInterrupt = undefined;
      pending.reject(disposeError);
    }
    const turn = this.#currentTurn;
    this.#currentTurn = undefined;
    if (turn) await turn.dispose();
    this.#finishClose();
  }

  #spawnTurn(prompt: string): void {
    this.#state = "running";
    this.#pendingOutcome = undefined;
    if (this.#sessionId) this.#setIdentity("unknown");
    const argv = this.#buildArgv(
      this.#instructionsPending ? `${this.#options.instructions}\n\n${prompt}` : prompt,
    );
    const environment = {
      ...agentEnvironment(this.#options.environment, Bun.env, undefined, {
        envVars: this.#options.runtime?.envVars,
        gitHooks: this.#options.gitHooks,
      }),
      NO_COLOR: "1",
    };
    const turn = new CursorTurnProcess(argv, this.#options.agentWorkspaceDirectory, environment);
    this.#instructionsPending = false;
    this.#currentTurn = turn;
    turn.onRecord((record) => this.#handleRecord(record));
    void turn.exited.then((result) => this.#onTurnExit(turn, result));
  }

  #buildArgv(prompt: string): string[] {
    const argv = [...this.#command, "--print", "--output-format", "stream-json", "--force"];
    const model = this.#options.runtime?.model;
    if (model && model !== "default") argv.push("--model", model);
    if (this.#resumeId) argv.push("--resume", this.#resumeId);
    argv.push(prompt);
    return argv;
  }

  /**
   * Maps only the frames CoForge's contract defines: `system/init` (session identity),
   * `system/status:compacting` and `system/compact_boundary` (compaction), `assistant` message
   * content blocks (thinking/text/tool_use), and `result` (turn outcome). Every other frame type
   * `cursor-agent` actually emits in its stream-json output - measured `thinking`, `tool_call`,
   * `connection`, and `retry` frames, and the `user` echo of the prompt - carries no CoForge
   * Activity today; see the ADR for what that leaves unobserved.
   */
  #handleRecord(record: Readonly<Record<string, unknown>>): void {
    if (this.#state === "disposed") return;
    if (record.type === "system" && record.subtype === "init") {
      this.#handleInit(record);
      return;
    }
    if (record.type === "system" && record.subtype === "status" && record.status === "compacting") {
      this.#emit({ type: "compaction-started", occurredAt: eventTime(record) });
      return;
    }
    if (record.type === "system" && record.subtype === "compact_boundary") {
      this.#emit({ type: "compaction-finished", occurredAt: eventTime(record) });
      return;
    }
    if (record.type === "assistant") {
      this.#handleAssistant(record);
      return;
    }
    if (record.type === "result") {
      this.#handleResult(record);
    }
  }

  #handleInit(record: Readonly<Record<string, unknown>>): void {
    if (typeof record.session_id !== "string" || !record.session_id.trim()) return;
    this.#sessionId = record.session_id;
    // Cursor never fails a `--resume` of an unknown id; it silently starts a fresh chat under
    // whatever id it reports instead. There is no missing-session recovery to run here - the
    // next turn simply resumes whatever this turn's init frame named.
    this.#resumeId = record.session_id;
    this.#setIdentity(this.#everCompletedTurn ? "unknown" : "empty");
    this.#reportIdentity();
    if (this.#bootstrap) {
      const resolve = this.#bootstrap.resolve;
      this.#bootstrap = undefined;
      resolve();
    }
  }

  #handleAssistant(record: Readonly<Record<string, unknown>>): void {
    const content = asRecord(record.message)?.content;
    if (!Array.isArray(content)) return;
    for (const raw of content) {
      const block = asRecord(raw);
      if (!block) continue;
      if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking) {
        this.#emit({ type: "thinking-delta", text: block.thinking });
      } else if (block.type === "text" && typeof block.text === "string" && block.text) {
        this.#emit({ type: "text-delta", text: block.text });
      } else if (block.type === "tool_use") {
        this.#emit({
          type: "tool-start",
          id: typeof block.id === "string" && block.id ? block.id : crypto.randomUUID(),
          name: typeof block.name === "string" && block.name ? block.name : "unknown_tool",
          input: block.input,
          occurredAt: eventTime(record),
        });
      }
    }
  }

  #handleResult(record: Readonly<Record<string, unknown>>): void {
    const subtype = typeof record.subtype === "string" ? record.subtype : "success";
    if (subtype !== "success" || record.is_error === true) {
      const parts: string[] = [];
      if (Array.isArray(record.errors)) {
        for (const entry of record.errors) {
          if (typeof entry === "string" && entry.trim()) parts.push(entry.trim());
        }
      }
      if (typeof record.result === "string" && record.result.trim())
        parts.push(record.result.trim());
      this.#emit({
        type: "error",
        message: parts.length > 0 ? parts.join(" | ") : "Execution failed",
      });
      this.#pendingOutcome = "failed";
    } else {
      this.#pendingOutcome = "success";
    }
  }

  /** Turn end is the process exit, not the `result` frame - `result` only records whether the
   * turn reported an error. A clean exit completes the turn; a non-zero or signal exit (such as
   * the free-plan/named-model rejection, which prints its reason only on stderr) fails it with the
   * exit summary and the recent stderr lines, so the failure explains itself. */
  #onTurnExit(turn: CursorTurnProcess, result: CursorTurnResult): void {
    if (this.#currentTurn !== turn) return;
    this.#currentTurn = undefined;
    if (this.#bootstrap) {
      const reject = this.#bootstrap.reject;
      this.#bootstrap = undefined;
      reject(
        new Error(`Cursor did not establish a session identity (${exitFailureMessage(result)})`),
      );
    }
    const interrupted = this.#state === "interrupting";
    const outcome = this.#pendingOutcome;
    this.#pendingOutcome = undefined;
    let status: "completed" | "interrupted" | "failed";
    if (interrupted) {
      status = "interrupted";
    } else if (outcome === "failed") {
      // The result frame already emitted the specific error above.
      status = "failed";
    } else if (result.exitCode === 0) {
      // A clean exit ends the turn successfully even when no `result` frame arrived.
      status = "completed";
      this.#everCompletedTurn = true;
      this.#setIdentity("resumable");
      this.#reportIdentity();
    } else {
      status = "failed";
      this.#emit({ type: "error", message: exitFailureMessage(result) });
    }
    this.#emit({ type: "completed", status });
    const pending = this.#pendingInterrupt;
    if (pending) {
      this.#pendingInterrupt = undefined;
      pending.resolve();
    }
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
      const failure = error instanceof Error ? error : new Error(String(error));
      for (const entry of entries) entry.reject(failure);
    }
  }

  #rejectQueue(error: Error): void {
    for (const entry of this.#queue.splice(0)) entry.reject(error);
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
          message: error instanceof Error ? error.message : "Cursor session identity report failed",
        });
      });
  }

  #emit(event: AgentRuntimeEvent): void {
    for (const listener of this.#listeners) listener(event);
  }

  #finishClose(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const listener of this.#exitListeners) listener();
    this.#exitListeners.clear();
  }
}

function exitFailureMessage(result: CursorTurnResult): string {
  const summary =
    result.exitCode === null ? "terminated by signal" : `exit code ${result.exitCode}`;
  const stderrLines = result.stderrTail
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  // Raw facts only: the daemon core redacts and caps runtime error text before it becomes Activity.
  return stderrLines.length ? `${summary} | stderr: ${stderrLines.join(" | ")}` : summary;
}
