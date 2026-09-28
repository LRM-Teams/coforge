import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import type { AgentSession, AgentSessionIdentity, AgentSessionOptions } from "@coforge/agent";
import {
  type AgentRuntimeEvent,
  type CodeAgentProvider,
  type ProviderDiscoveryOptions,
} from "#src/code-agent/contract";
import { agentEnvironment } from "#src/code-agent/environment";
import { exitFailureMessage } from "#src/code-agent/exit-failure-message";
import { asRecord, eventTime } from "#src/code-agent/json-record";
import { discoverExternalCodeAgents } from "#src/code-agent/runtime-inventory";
import { discoverOpenCodeCatalog } from "./catalog";
import { OpenCodeTurnProcess, type OpenCodeTurnResult } from "./turn-process";
import { assertOpenCodeVersionSupported } from "./version";

/**
 * OpenCode (`opencode`, SST) is a per-turn provider: every turn is its own
 * `opencode run --format json` child process, with the prompt as the final argv item and the turn
 * ending when that process exits — the same shape as Cursor's. Resume is `--session <id>`, which
 * OpenCode reports on its own events (`sessionID`).
 *
 * The standing Agent instructions are sent as the whole prompt of a fresh session's first turn:
 * OpenCode v2 reads a project's `AGENTS.md` itself and has no system-prompt flag, so there is no
 * other channel for them. A resumed session never resends them.
 */
export class OpenCodeProvider implements CodeAgentProvider {
  readonly provider = RUNTIME_PROVIDER.OPENCODE;
  readonly #command: readonly string[];

  constructor(options: { command?: readonly string[] } = {}) {
    this.#command = options.command ?? ["opencode"];
  }

  async discoverRuntime(options: ProviderDiscoveryOptions = {}) {
    return (
      await discoverExternalCodeAgents(
        options.probe,
        options.environment,
        options.platform,
        RUNTIME_PROVIDER.OPENCODE,
      )
    )[0];
  }

  async discoverModelCatalog(options: ProviderDiscoveryOptions = {}) {
    return discoverOpenCodeCatalog(
      options.command ?? [...this.#command, "models"],
      options.cwd ?? process.cwd(),
      options.environment ?? Bun.env,
    );
  }

  async createAgentSession(options: AgentSessionOptions): Promise<AgentSession> {
    if (options.sessionId !== undefined && !options.sessionId.trim())
      throw new Error("Invalid session ID");
    await assertOpenCodeVersionSupported(this.#command);
    const session = new OpenCodeAgentSession(options, this.#command);
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
}

type PendingOutcome = "success" | "failed" | undefined;
type SessionState = "idle" | "running" | "interrupting" | "disposed";

class OpenCodeAgentSession implements AgentSession {
  readonly #options: AgentSessionOptions;
  readonly #command: readonly string[];
  readonly #listeners = new Set<(event: AgentRuntimeEvent) => void>();
  readonly #exitListeners = new Set<() => void>();
  readonly #queue: Array<{ text: string; resolve(): void; reject(error: Error): void }> = [];
  #state: SessionState = "idle";
  #closed = false;
  #currentTurn: OpenCodeTurnProcess | undefined;
  #sessionId: string | undefined;
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
    this.#sessionId = options.sessionId;
    this.#everCompletedTurn = Boolean(options.sessionId);
    this.#identity = options.sessionId
      ? { sessionId: options.sessionId, state: "resumable" }
      : undefined;
  }

  /** Spawns a fresh session's first (instructions-only) turn and resolves once an event names a
   * session id, or rejects if that turn ends (or fails to spawn) before one does. */
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

  /** Idle delivers immediately as a new turn. A turn already in flight — including the fresh
   * session's own bootstrap turn — queues the text; queued texts are joined and delivered together
   * as the next turn once the running process exits (resolved once that next turn's process has
   * actually been spawned, never once it finishes). */
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

  /** A finished turn is not a session exit — the process it owned is simply gone until the next
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
    const argv = this.#buildArgv(prompt);
    const environment = {
      ...agentEnvironment(this.#options.environment, Bun.env, undefined, {
        envVars: this.#options.runtime?.envVars,
        gitHooks: this.#options.gitHooks,
      }),
      // OpenCode resolves its discovery root (AGENTS.md walk-up, `.opencode/skills/`) from the
      // process working directory / `PWD`; v2 has no `--dir` flag, so the turn pins both (cwd is
      // passed to the spawn) and this override keeps an inherited `PWD` from pointing the Agent at
      // the wrong tree. Raft pins the same pair.
      PWD: this.#options.agentWorkspaceDirectory,
      NO_COLOR: "1",
    };
    const turn = new OpenCodeTurnProcess(argv, this.#options.agentWorkspaceDirectory, environment);
    this.#currentTurn = turn;
    turn.onRecord((record) => this.#handleRecord(record));
    void turn.exited.then((result) => this.#onTurnExit(turn, result));
  }

  #buildArgv(prompt: string): string[] {
    // OpenCode v2's `run` surface, verified against the released `2.0.x` CLI: `--auto` replaced
    // `--dangerously-skip-permissions`, the working directory is the process cwd (there is no
    // `--dir`), and the reasoning effort rides the model id as `provider/model#variant` (there is
    // no standalone `--variant`). `--format json` and `--session` are unchanged.
    const argv = [...this.#command, "run", "--format", "json", "--auto"];
    const model = this.#options.runtime?.model;
    // OpenCode calls the reasoning-effort selection a `variant`; the catalog's `variants` keys are
    // exactly what `#variant` accepts.
    const reasoning = this.#options.runtime?.reasoning;
    if (model && model !== "default") {
      argv.push("--model", reasoning ? `${model}#${reasoning}` : model);
    }
    // A variant with no explicit model has nowhere to go in v2 (`#variant` needs a model id), so
    // it is dropped rather than invented; the runtime's own default model keeps its own effort.
    if (this.#resumeId) argv.push("--session", this.#resumeId);
    argv.push(prompt);
    return argv;
  }

  /**
   * Maps the `--format json` events CoForge's contract defines: `text` (output), `tool_use`
   * (tool call and its result, which OpenCode reports on the same event), `error`, `step_start`
   * (liveness) and `step_finish`. Every event that carries `sessionID` establishes the session
   * identity used for resume.
   */
  #handleRecord(record: Readonly<Record<string, unknown>>): void {
    if (this.#state === "disposed") return;
    this.#observeSessionId(record);
    const part = asRecord(record.part);
    switch (record.type) {
      case "step_start": {
        this.#emit({ type: "progress", occurredAt: eventTime(record) });
        return;
      }
      case "text": {
        const text = typeof part?.text === "string" ? part.text : "";
        if (text) this.#emit({ type: "text-delta", text });
        return;
      }
      case "tool_use": {
        this.#handleToolUse(record, part);
        return;
      }
      case "error": {
        this.#emit({ type: "error", message: openCodeErrorMessage(record) });
        this.#pendingOutcome = "failed";
        return;
      }
      default:
        return;
    }
  }

  #handleToolUse(
    record: Readonly<Record<string, unknown>>,
    part: Record<string, unknown> | undefined,
  ): void {
    const toolName = typeof part?.tool === "string" && part.tool ? part.tool : "unknown_tool";
    const id = typeof part?.callID === "string" && part.callID ? part.callID : crypto.randomUUID();
    const state = asRecord(part?.state);
    this.#emit({
      type: "tool-start",
      id,
      name: toolName,
      input: state?.input,
      occurredAt: eventTime(record),
    });
    if (state?.status !== "completed" && state?.status !== "error") return;
    const output = state.output;
    if (typeof output === "string" && output) this.#emit({ type: "tool-output", id, text: output });
    this.#emit({ type: "tool-end", id, isError: state.status === "error" });
  }

  /** Records the session id OpenCode reports, on the event or inside its part. */
  #observeSessionId(record: Readonly<Record<string, unknown>>): void {
    const sessionId =
      typeof record.sessionID === "string" && record.sessionID.trim()
        ? record.sessionID
        : typeof asRecord(record.part)?.sessionID === "string" &&
            (asRecord(record.part)!.sessionID as string).trim()
          ? (asRecord(record.part)!.sessionID as string)
          : undefined;
    if (!sessionId || sessionId === this.#sessionId) return;
    this.#sessionId = sessionId;
    this.#resumeId = sessionId;
    this.#setIdentity(this.#everCompletedTurn ? "unknown" : "empty");
    this.#reportIdentity();
    if (this.#bootstrap) {
      const resolve = this.#bootstrap.resolve;
      this.#bootstrap = undefined;
      resolve();
    }
  }

  /** Turn end is the process exit: a clean exit completes the turn, a non-zero one fails it with
   * the exit summary and the recent stderr lines. */
  #onTurnExit(turn: OpenCodeTurnProcess, result: OpenCodeTurnResult): void {
    if (this.#currentTurn !== turn) return;
    this.#currentTurn = undefined;
    if (this.#bootstrap) {
      const reject = this.#bootstrap.reject;
      this.#bootstrap = undefined;
      reject(
        new Error(`OpenCode did not establish a session identity (${exitFailureMessage(result)})`),
      );
    }
    const interrupted = this.#state === "interrupting";
    const outcome = this.#pendingOutcome;
    this.#pendingOutcome = undefined;
    let status: "completed" | "interrupted" | "failed";
    if (interrupted) {
      status = "interrupted";
    } else if (outcome === "failed") {
      // The error event already emitted the specific error above.
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
          message:
            error instanceof Error ? error.message : "OpenCode session identity report failed",
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

/** OpenCode reports provider failures as `{ error: { name, data: { message } } }` (auth errors
 * carry the text there) and provider quota/HTTP failures as the top-level envelope the 2026-09-23
 * live capture showed: `{ error: { type: "provider.quota", message, status: 429 } }`. Prefer the
 * data message, then the classified kind plus the raw message, then the name — a bare
 * "Execution failed" here is exactly how a quota failure degraded into an unexplainable
 * "Agent runtime failed." (boss ruling: expose the real error). The classifier already maps
 * `rate.limit`/`429` text to the `rate_limited` reason, so the surfaced cause flows into the
 * Activity's class and retry decision unchanged. */
function openCodeErrorMessage(record: Readonly<Record<string, unknown>>): string {
  const error = asRecord(record.error);
  const data = asRecord(error?.data);
  if (typeof data?.message === "string" && data.message.trim()) return data.message.trim();
  const kind = typeof error?.type === "string" ? error.type.trim() : "";
  const status = typeof error?.status === "number" ? ` (HTTP ${error.status})` : "";
  if (typeof error?.message === "string" && error.message.trim()) {
    const detail = error.message.trim();
    return kind ? `${kind}${status}: ${detail}` : detail;
  }
  if (kind) return `${kind}${status || ""}`.trim();
  if (typeof error?.name === "string" && error.name.trim()) return error.name.trim();
  return "Execution failed";
}
