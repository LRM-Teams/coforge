import { getLogger } from "@logtape/logtape";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import type { AgentSession, AgentSessionIdentity, AgentSessionOptions } from "@coforge/agent";
import {
  type AgentRuntimeEvent,
  type CodeAgentProvider,
  type ProviderDiscoveryOptions,
} from "#src/code-agent/contract";
import { InterruptTracker } from "#src/code-agent/interrupt-tracker";
import { agentEnvironment } from "#src/code-agent/environment";
import { exitFailureMessage } from "#src/code-agent/exit-failure-message";
import { errorMessage } from "#src/code-agent/json-record";
import { discoverExternalCodeAgents } from "#src/code-agent/runtime-inventory";
import { GrokTurnProcess, type GrokTurnResult } from "./turn-process";
import { assertGrokVersionSupported } from "./version";
import { readGrokUsage } from "./usage";
import type { UsageSnapshot } from "@coforge/agent";

/**
 * Grok Build (`grok`, xAI) is a per-turn provider, the same shape as OpenCode's (ADR 0058):
 * every turn is its own `grok -p <prompt> --output-format streaming-json` child process and the
 * turn ends when that process exits. The stream is one ACP-shaped NDJSON session update per line
 * (`thought` / `text` / `end` / `error`, verified live on 1.0.41), which is exactly the
 * `server/pkg/agent/grok.go` contract the bundled Raft reference documents.
 *
 * Unlike OpenCode, Grok has a system-prompt channel (`--rules` appends to the agent's system
 * prompt), so the standing Agent instructions ride every turn as rules and a fresh session needs
 * **no bootstrap turn** — nothing is spawned until real input arrives. Session identity is
 * generated here (a UUID) and pinned with `--session-id`, which creates a NEW session and refuses
 * an id that is already in use (14-headless-mode.md, "Named Sessions"); once a turn has been
 * spawned with it, every later turn carries `--resume <id>`, whatever that turn's outcome was.
 */
const logger = getLogger(["coforge", "daemon", "code-agent", "grok"]);

export class GrokProvider implements CodeAgentProvider {
  readonly provider = RUNTIME_PROVIDER.GROK;
  readonly #command: readonly string[];

  constructor(options: { command?: readonly string[] } = {}) {
    this.#command = options.command ?? ["grok"];
  }

  async discoverRuntime(options: ProviderDiscoveryOptions = {}) {
    return (
      await discoverExternalCodeAgents(
        options.probe,
        options.environment,
        options.platform,
        RUNTIME_PROVIDER.GROK,
      )
    )[0];
  }

  async readUsage(options: {
    workingDirectory: string;
    timeoutMs?: number;
  }): Promise<UsageSnapshot | null> {
    return readGrokUsage(options.workingDirectory, {
      command: this.#command,
      timeoutMs: options.timeoutMs,
    });
  }

  async createAgentSession(options: AgentSessionOptions): Promise<AgentSession> {
    if (options.sessionId !== undefined && !options.sessionId.trim())
      throw new Error("Invalid session ID");
    await assertGrokVersionSupported(this.#command);
    return new GrokAgentSession(options, this.#command);
  }
}

type PendingOutcome = "success" | "failed" | undefined;
type SessionState = "idle" | "running" | "interrupting" | "disposed";
/** The turn in flight: its process, the input it carries, and whether it resumes a session. */
type ActiveTurn = { process: GrokTurnProcess; prompt: string; resumed: boolean };

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * A `--resume` of an id grok has no session for fails with two stderr lines and no stdout frames:
 * `Session "<id>" not found locally, restoring conversation from remote...` and then
 * `Error: Failed to restore session from remote: ... 404 Not Found` (observed on 1.0.41;
 * 14-headless-mode.md says only that `--resume` "errors if the session does not exist"). Both
 * phrases are required, so a restore that fails for another reason - the remote being down, say -
 * fails the turn rather than discarding a session that may still exist.
 */
function isMissingSession(stderr: string): boolean {
  return stderr.includes("not found locally") && stderr.includes("Failed to restore session");
}

class GrokAgentSession implements AgentSession {
  readonly #options: AgentSessionOptions;
  readonly #command: readonly string[];
  readonly #listeners = new Set<(event: AgentRuntimeEvent) => void>();
  readonly #exitListeners = new Set<() => void>();
  readonly #queue: Array<{ text: string; resolve(): void; reject(error: Error): void }> = [];
  #state: SessionState = "idle";
  #closed = false;
  #currentTurn: ActiveTurn | undefined;
  #sessionId: string;
  /** Whether the next turn creates the session with `--session-id`. It is cleared once a turn has
   * been spawned that way, never at that turn's exit: grok creates the session before the turn can
   * fail, and refuses `--session-id` for an id that exists, so a failed or interrupted first turn
   * must not be created again. */
  #creatingSession: boolean;
  /** Whether a turn of this session has completed successfully. */
  #everCompletedTurn: boolean;
  /** The session a lost resume replaced, reported once with its replacement. */
  #replacedSessionId: string | undefined;
  /** The id the daemon was last told about (or is being told about). */
  #reportedSessionId: string | undefined;
  #identity: AgentSessionIdentity | undefined;
  #pendingOutcome: PendingOutcome;
  #sessionReports: Promise<void> = Promise.resolve();
  #interrupt = new InterruptTracker();

  constructor(options: AgentSessionOptions, command: readonly string[]) {
    this.#options = options;
    this.#command = command;
    // A session the daemon names but asks to `create` is new to grok, however it got its id
    // (`AgentSessionOptions.sessionMode`); only a `resume` carries a conversation to continue.
    const resuming = options.sessionId !== undefined && options.sessionMode !== "create";
    this.#sessionId = options.sessionId ?? crypto.randomUUID();
    this.#creatingSession = !resuming;
    this.#everCompletedTurn = resuming;
    this.#identity = { sessionId: this.#sessionId, state: resuming ? "unknown" : "empty" };
  }

  async sendMessage(text: string): Promise<void> {
    return this.#deliver(text);
  }

  /** Idle delivers immediately as a new turn. A turn already in flight queues the text; queued
   * texts are joined and delivered together as the next turn once the running process exits
   * (resolved once that next turn's process has actually been spawned, never once it finishes). */
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

  async notify(text: string): Promise<void> {
    return this.#deliver(text);
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
      this.#interrupt.fail(error instanceof Error ? error : new Error(String(error)));
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

  /** A finished turn is not a session exit — the process it owned is simply gone until the next
   * one is spawned. `onExit` fires only here, when the session itself is torn down. */
  async dispose(): Promise<void> {
    if (this.#state === "disposed") return;
    this.#state = "disposed";
    const disposeError = new Error("code agent session was disposed");
    this.#rejectQueue(disposeError);
    this.#interrupt.fail(disposeError);
    const turn = this.#currentTurn;
    this.#currentTurn = undefined;
    if (turn) await turn.process.dispose();
    this.#finishClose();
  }

  #spawnTurn(prompt: string): void {
    const resumed = !this.#creatingSession;
    const argv = this.#buildArgv(prompt);
    const environment = {
      ...agentEnvironment(this.#options.environment, Bun.env, undefined, {
        envVars: this.#options.runtime?.envVars,
        gitHooks: this.#options.gitHooks,
      }),
      // Grok resolves its workspace from the process working directory; the override keeps an
      // inherited `PWD` from pointing the Agent at the wrong tree.
      PWD: this.#options.agentWorkspaceDirectory,
      NO_COLOR: "1",
    };
    // Constructing the process is the one step that can throw (`Bun.spawn` throws synchronously for
    // a working directory that no longer exists), so the session records the turn as running only
    // once the process exists; a throw leaves it exactly as it was, and the caller reports it.
    const child = new GrokTurnProcess(argv, this.#options.agentWorkspaceDirectory, environment);
    const turn: ActiveTurn = { process: child, prompt, resumed };
    this.#currentTurn = turn;
    this.#state = "running";
    this.#pendingOutcome = undefined;
    this.#creatingSession = false;
    child.onRecord((record) => this.#handleRecord(record));
    void child.exited.then((result) => this.#onTurnExit(turn, result));
    this.#setIdentity("unknown");
  }

  #buildArgv(prompt: string): string[] {
    // The one-shot headless surface, verified against the 1.0 CLI (1.0.40/1.0.41) and matching the
    // bundled Raft reference's argv: the prompt rides `-p`, auto-approval and daemon-owned memory
    // isolation are explicit, and the standing instructions ride `--rules` on every turn of a
    // fresh session (Grok appends rather than replaces).
    const argv = [
      ...this.#command,
      "-p",
      prompt,
      "--output-format",
      "streaming-json",
      "--always-approve",
      "--no-memory",
    ];
    // `--rules` appends to the system prompt, which is per invocation: the standing instructions
    // ride every turn of this session, fresh or resumed.
    argv.push("--rules", this.#options.instructions);
    const model = this.#options.runtime?.model;
    if (model && model !== "default") argv.push("--model", model);
    const reasoning = this.#options.runtime?.reasoning;
    if (reasoning) argv.push("--reasoning-effort", reasoning);
    if (this.#creatingSession) argv.push("--session-id", this.#sessionId);
    else argv.push("--resume", this.#sessionId);
    return argv;
  }

  /**
   * Maps the `streaming-json` events this adapter consumes (the vocabulary Raft's
   * `server/pkg/agent/grok.go` documents, verified against 1.0.41's output): `text` (output),
   * `thought` (reasoning), `end` (turn boundary; carries the session id and the stop reason),
   * `error`, and `max_turns_reached`. `available_commands` (and any future unknown type) is
   * ignored — it announces the tool vocabulary, not turn content.
   */
  #handleRecord(record: Readonly<Record<string, unknown>>): void {
    if (this.#state === "disposed") return;
    this.#observeSessionId(record);
    const data = typeof record.data === "string" ? record.data : "";
    switch (record.type) {
      case "text": {
        if (data) this.#emit({ type: "text-delta", text: data });
        return;
      }
      case "thought": {
        if (data) this.#emit({ type: "thinking-delta", text: data });
        return;
      }
      case "end": {
        // An `end` with no failure reason is the turn's success boundary; stopReason carries the
        // abnormal exits (Raft's adapter treats cancelled and max-turns the same way).
        const reason = typeof record.stopReason === "string" ? record.stopReason.toLowerCase() : "";
        if (reason === "cancelled" || reason === "canceled" || reason === "aborted") {
          this.#emit({ type: "error", message: "Grok stopped: " + record.stopReason });
          this.#pendingOutcome = "failed";
        } else if (
          reason === "max_turns" ||
          reason === "maxturns" ||
          reason === "max_turns_reached"
        ) {
          this.#emit({ type: "error", message: "Grok reached max turns" });
          this.#pendingOutcome = "failed";
        } else {
          this.#pendingOutcome = "success";
        }
        return;
      }
      case "error": {
        const message =
          (typeof record.message === "string" && record.message.trim()) || data || "Grok error";
        this.#emit({ type: "error", message });
        this.#pendingOutcome = "failed";
        return;
      }
      case "max_turns_reached": {
        this.#emit({ type: "error", message: "Grok reached max turns" });
        this.#pendingOutcome = "failed";
        return;
      }
      default: {
        // The vocabulary above is Raft-reference + CLI-help derived, with the 402-constrained
        // live probe able to observe only the envelope: an unknown event is logged and ignored,
        // never fatal — a mis-mapped vocabulary costs one unrendered update, not the turn.
        logger.warning("Grok turn emitted an unrecognized event", {
          event: "code_agent.grok.unknown_event",
          type: typeof record.type === "string" ? record.type : "untyped",
          outcome: "unknown",
        });
        return;
      }
    }
  }

  /** Records the session id Grok reports on its `end` and `error` events; the id is also pinned
   * up front with `--session-id`, so a mismatched report means Grok replaced our id. */
  #observeSessionId(record: Readonly<Record<string, unknown>>): void {
    const sessionId =
      typeof record.sessionId === "string" && record.sessionId.trim()
        ? record.sessionId.trim()
        : undefined;
    if (!sessionId || sessionId === this.#sessionId) return;
    this.#sessionId = sessionId;
    this.#setIdentity(this.#everCompletedTurn ? "unknown" : "empty");
    this.#reportIdentity();
  }

  /** Turn end is the process exit: a clean exit completes the turn, a non-zero one fails it with
   * the exit summary and the recent stderr lines. */
  #onTurnExit(turn: ActiveTurn, result: GrokTurnResult): void {
    if (this.#currentTurn !== turn) return;
    this.#currentTurn = undefined;
    const interrupted = this.#state === "interrupting";
    const outcome = this.#pendingOutcome;
    this.#pendingOutcome = undefined;
    if (
      !interrupted &&
      turn.resumed &&
      outcome === undefined &&
      result.exitCode !== 0 &&
      isMissingSession(result.stderrTail)
    ) {
      this.#restartMissingSession(turn.prompt);
      return;
    }
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
    this.#interrupt.settle();
    if (this.#state === "disposed") return;
    this.#drainQueueOrIdle();
  }

  /** Runs the input of a resume grok could not honor as a fresh session under a new id. The
   * standing instructions ride `--rules` on every turn, so the new session needs no bootstrap; the
   * discarded attempt emits nothing, and the daemon is told about the replacement once, with the
   * id it replaces, when the new session is reported. */
  #restartMissingSession(prompt: string): void {
    this.#replacedSessionId ??= this.#sessionId;
    this.#sessionId = crypto.randomUUID();
    this.#creatingSession = true;
    this.#everCompletedTurn = false;
    this.#setIdentity("empty");
    try {
      this.#spawnTurn(prompt);
    } catch (error) {
      // The discarded input was already accepted, so its turn fails visibly rather than vanishing.
      this.#emit({ type: "error", message: toError(error).message });
      this.#emit({ type: "completed", status: "failed" });
      this.#interrupt.settle();
      this.#drainQueueOrIdle();
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

  #setIdentity(state: AgentSessionIdentity["state"]): void {
    if (this.#identity?.sessionId === this.#sessionId && this.#identity.state === state) return;
    this.#identity = { sessionId: this.#sessionId, state };
    this.#emit({ type: "session", identity: this.#identity });
  }

  /** Reports the session to the daemon once per id. The first report after a lost resume also
   * names the session it replaced, so the daemon invalidates the stale one and tells the person the
   * earlier context was not restored. A report that fails is retried by the next completed turn. */
  #reportIdentity(): void {
    const sessionId = this.#sessionId;
    const onSessionId = this.#options.onSessionId;
    if (!onSessionId || sessionId === this.#reportedSessionId) return;
    const replaced = this.#replacedSessionId;
    this.#replacedSessionId = undefined;
    this.#reportedSessionId = sessionId;
    this.#sessionReports = this.#sessionReports
      .then(() => onSessionId(sessionId, replaced))
      .catch((error: unknown) => {
        if (this.#reportedSessionId === sessionId) this.#reportedSessionId = undefined;
        this.#replacedSessionId ??= replaced;
        this.#emit({
          type: "error",
          message: errorMessage(error) || "Grok session identity report failed",
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
