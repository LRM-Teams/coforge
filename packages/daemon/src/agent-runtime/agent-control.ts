import { getLogger } from "@logtape/logtape";
import type {
  AgentControlResult,
  AgentControlScope,
  AgentSessionInvalidateReason,
  AgentStartIntent,
  AgentWorkspaceResetRequest,
  SessionIdentity,
} from "@lrm/coforge-sdk/internal";
import { AgentSessionRecoveryError } from "../code-agent/contract";
import { diagnosticErrorCode } from "../platform/diagnostic-error-code";
import { launchFailureTrace } from "./launch-failure";
import type { AgentRuntimeRecord, AgentRuntimeState } from "./agent-runtime-state";
import type { AgentSessions } from "./agent-session";
import { LAUNCH_FAILURE_MAX_ATTEMPTS, LaunchFailureBackoff } from "./launch-failure-backoff";

const logger = getLogger(["coforge", "daemon", "agent-control"]);

/** Live phases a repair may rewrite: the record still claims the process is up or mid-transition. */
const LIVE_PHASES = new Set<AgentRuntimeRecord["phase"]>(["running", "starting", "stopping"]);

type Runtime = {
  running(agentId: string): boolean;
  stop(agentId: string): Promise<SessionIdentity | undefined>;
  launch(
    intent: AgentStartIntent,
    launchId: string,
    replacedSessionId?: string,
    /** Set only alongside `replacedSessionId`, for the same `invalidateSession` call that
     * preceded this retry launch; narrates the fresh launch's cold-start Activity with the
     * reason that was actually reported, without a daemon-side side-channel map (fix for the
     * removed `#pendingSessionInvalidateReason`). */
    invalidateReason?: AgentSessionInvalidateReason,
  ): Promise<SessionIdentity | undefined>;
  wake?(intent: AgentStartIntent): Promise<void>;
  /** Fire-and-forget; never blocks or fails the launch it is reported alongside. */
  invalidateSession?(
    intent: AgentStartIntent,
    launchId: string,
    sessionId: string,
    reason: AgentSessionInvalidateReason,
  ): void;
  /**
   * Rebinds an already-running process to a newer control scope without spawning a second one
   * (docs/adr/0041): a Start that finds `running(agentId)` true under an older, TERMINAL
   * operation adopts the new request instead of being rejected, mirroring Raft's
   * `rebindRunningStart`. `launchId` is the identity the running process adopts for every later
   * daemon->server message about it (today always `intent.launchId`, the server-supplied id for
   * this new operation) — re-points every place that remembers the previous launch's identity
   * (session reference, activity launch/clientSeq, status, pending Activity/invalidate
   * bookkeeping) and sends the immediate Session re-report and `agent:status(active)` under the
   * new scope. Returns the running process's current Session identity, exactly like `launch`
   * does for a fresh start, so the caller can report it in the rebind's `started` result. Never
   * requests a new launch config/credential — the running process's existing Agent API key and
   * local proxy token are kept.
   */
  rebind(intent: AgentStartIntent, launchId: string): Promise<SessionIdentity | undefined>;
  result(result: AgentControlResult): Promise<void>;
  /** True when `error` (from `stop`/`launch`'s cleanup) means the local process's exit could not
   * be confirmed — the one case a stale-looking record must keep fencing rather than repair. */
  cleanupUnconfirmed(agentId: string, error: unknown): boolean;
};

/** Injectable timer seam for the automatic launch retry: production uses plain `setTimeout`, and
 * tests drive the delays deterministically instead of sleeping through them. */
export type LaunchRetryScheduler = {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
};

const systemLaunchRetryScheduler: LaunchRetryScheduler = {
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Owns separate stop, workspace reset, and start primitives. */
export class AgentControl {
  readonly #known = new Set<string>();
  /** Per-Agent launch-failure streaks and the cooldown each one owes (Raft's
   * `SPAWN-FAIL BACKOFF`): counted here rather than derived from the control record, so a
   * superseding Stop/Start cannot reset the limiter by rewriting that record. */
  readonly #launchFailures = new LaunchFailureBackoff();
  /** The one pending automatic launch retry per Agent, if any. */
  readonly #launchRetries = new Map<string, unknown>();
  constructor(
    private readonly instanceId: string,
    private readonly state: AgentRuntimeState,
    private readonly sessions: AgentSessions,
    private readonly runtime: Runtime,
    private readonly launchRetryScheduler: LaunchRetryScheduler = systemLaunchRetryScheduler,
  ) {}
  private get store() {
    return this.state.store;
  }
  /**
   * A stale lifecycle fact is a bug in the writer that left it behind (a gone daemon instance, or
   * a Stop whose failure receipt was never retried), so every repair is logged at error level —
   * it must never become the silent normal path. Repairs only a record whose phase still claims
   * the process is up or mid-transition, only when the process is confirmed not running, only
   * when the last writer never flagged the exit itself as unconfirmed, and only when that phase
   * is explained by a gone writer (a different daemon instance) or a stuck failed Stop receipt.
   * Leaves everything else (notably "clearing", mid reset-workspace) untouched. Preserves scope,
   * sequence, identity and every prior receipt so idempotency/monotonicity are unaffected; only
   * `phase` moves to "stopped".
   */
  private async repairStaleRecord(
    agentId: string,
    record: AgentRuntimeRecord | undefined,
  ): Promise<AgentRuntimeRecord | undefined> {
    if (
      !record ||
      !LIVE_PHASES.has(record.phase) ||
      record.exitUnconfirmed ||
      this.runtime.running(agentId)
    )
      return record;
    const staleWriter = record.daemonInstanceId !== this.instanceId;
    const stuckStopping = record.phase === "stopping" && record.stopResult?.phase === "failed";
    if (!staleWriter && !stuckStopping) return record;
    const previousPhase = record.phase;
    const previousDaemonInstanceId = record.daemonInstanceId;
    const repaired: AgentRuntimeRecord = { ...record, phase: "stopped" };
    await this.store.write(agentId, repaired);
    logger.error("Stale Agent control record repaired", {
      event: "agent_control:stale_record_repaired",
      agent_id: agentId,
      previous_phase: previousPhase,
      previous_daemon_instance_id: previousDaemonInstanceId,
      daemon_instance_id: this.instanceId,
      epoch: record.scope.epoch,
    });
    return repaired;
  }
  private fence(record: AgentRuntimeRecord | undefined, scope: AgentControlScope) {
    if (!record) return;
    const old = record.scope;
    if (
      old.workspaceId !== scope.workspaceId ||
      old.computerId !== scope.computerId ||
      old.agentId !== scope.agentId ||
      old.epoch > scope.epoch ||
      (old.epoch === scope.epoch && old.provider !== scope.provider)
    )
      throw new Error("stale_control_request");
    if (
      record.daemonInstanceId !== this.instanceId &&
      ["running", "starting", "stopping"].includes(record.phase)
    )
      throw new Error("previous_process_stop_unconfirmed");
  }
  async initialize() {
    for (const id of await this.store.listAgentIds()) {
      const record = await this.store.read(id);
      this.#known.add(id);
      await this.#settleInterruptedOperation(id, record);
    }
  }

  /** Boot-time settle results for records a gone daemon instance left in a live phase. `initialize`
   * runs before the transport connects, so these are collected there and flushed once `#start` has
   * completed the ready handshake — the same after-ready ordering the pre-ready publication buffer
   * uses. `flushPendingBootResults` is idempotent and safe to call when the list is empty. */
  readonly #pendingBootResults: AgentControlResult[] = [];

  /** Sends every settle result `initialize` collected, logging (not swallowing) a per-result
   * delivery failure with the facts a later investigation needs. */
  async flushPendingBootResults(): Promise<void> {
    const pending = this.#pendingBootResults.splice(0);
    for (const result of pending) {
      try {
        await this.runtime.result(result);
      } catch (error) {
        logger.warning("Boot settle result for an interrupted Agent operation failed to deliver", {
          event: "agent_control:boot_result_delivery_failed",
          agent_id: result.agentId,
          request_id: result.requestId,
          result_phase: result.phase,
          epoch: result.epoch,
          error_code: diagnosticErrorCode(error),
        });
      }
    }
  }

  /** Boot-time counterpart of the lazy `repairStaleRecord`: a record left in a live phase by a
   * gone daemon instance otherwise sits there until some control operation touches the Agent —
   * the UI keeps showing "Starting…"/"Stopping…" and the server's operation for the interrupted
   * start stays non-terminal forever, because the automatic launch retry that would have
   * settled it died with the old instance (Raft's wait states carry an instance id + deadline
   * precisely so they cannot outlive their writer). Repair the record to its honest terminal
   * phase and report a result under the interrupted operation's own scope, so the server
   * settles it without waiting for a newer command; a result for an op the server already
   * superseded is rejected and logged (ADR 0035's decision B) — harmless.
   *
   * The repaired phase is always "stopped" — never "failed": the server's `recover()` treats a
   * failed state as terminal and starts fresh, but republishing the SAME epoch at a record that
   * reads "failed" would be fenced as `previous_control_not_completed`, so a "failed" repair
   * could block the very recovery that follows this boot. The reported result is still `failed`
   * for an interrupted start — that is the honest outcome for the operation — while the local
   * record stays startable. */
  async #settleInterruptedOperation(
    agentId: string,
    record: AgentRuntimeRecord | undefined,
  ): Promise<void> {
    if (
      !record ||
      !LIVE_PHASES.has(record.phase) ||
      record.exitUnconfirmed ||
      this.runtime.running(agentId) ||
      record.daemonInstanceId === this.instanceId
    )
      return;
    const previousPhase = record.phase;
    const repaired: AgentRuntimeRecord = { ...record, phase: "stopped" };
    let result: AgentControlResult | undefined;
    if (previousPhase === "starting") {
      // A launch that never finished: settle the server's operation as failed under the op's own
      // scope so its pending state resolves; the next Start (including the Daemon-ready recovery
      // dispatch) starts fresh with a new epoch.
      repaired.lastResult = {
        ...record.scope,
        phase: "failed",
        launchId: record.launchId,
        sequence: ++repaired.sequence,
        errorCode: "daemon_restarted",
      };
      result = repaired.lastResult;
    } else if (previousPhase === "stopping") {
      result = record.stopResult;
      if (!result) {
        repaired.lastResult = {
          ...record.scope,
          phase: "stopped",
          sequence: ++repaired.sequence,
        };
        result = repaired.lastResult;
      }
    }
    await this.store.write(agentId, repaired);
    logger.error("Agent control record left live by a gone daemon instance; repaired at boot", {
      event: "agent_control:interrupted_operation_repaired",
      agent_id: agentId,
      previous_phase: previousPhase,
      previous_daemon_instance_id: record.daemonInstanceId,
      daemon_instance_id: this.instanceId,
      epoch: record.scope.epoch,
      ...(result ? { reported_result_phase: result.phase } : {}),
    });
    if (result) this.#pendingBootResults.push(result);
  }
  managed(agentId: string) {
    return this.#known.has(agentId);
  }
  private async requireRecord(
    record: AgentRuntimeRecord | undefined,
    agentId: string,
    known: boolean,
  ) {
    if (
      !record &&
      (known || (!this.runtime.running(agentId) && (await this.store.workspaceExists(agentId))))
    )
      throw new Error("control_record_missing");
  }
  stop(scope: AgentControlScope): Promise<void> {
    const known = this.#known.has(scope.agentId);
    this.#known.add(scope.agentId);
    return this.state.run(scope.agentId, async () => {
      let record = await this.store.read(scope.agentId);
      await this.requireRecord(record, scope.agentId, known);
      record = await this.repairStaleRecord(scope.agentId, record);
      this.fence(record, scope);
      if (record?.scope.epoch === scope.epoch && record.stopResult) {
        if (record.stopResult.requestId !== scope.requestId)
          throw new Error("control_request_mismatch");
        await this.runtime.result(record.stopResult).catch(() => {});
        return;
      }
      if (record?.scope.epoch === scope.epoch && record.phase === "failed")
        throw new Error("previous_control_not_completed");
      // An accepted Stop supersedes any pending automatic launch retry: the streak and the armed
      // retry both belong to the launch operation this Stop is ending. Cleared only after every
      // validation above passed, so a stale/out-of-scope Stop cannot disarm a live retry.
      this.#clearLaunchRetry(scope.agentId);
      this.#launchFailures.reset(scope.agentId);
      const resetWorkspaceRequired =
        record?.action === "reset-workspace" && record.phase !== "workspace-reset";
      record = {
        version: 1,
        scope,
        action: resetWorkspaceRequired ? "reset-workspace" : "stop",
        phase: "stopping",
        daemonInstanceId: this.instanceId,
        sequence: record?.scope.epoch === scope.epoch ? record.sequence : 0,
        ...(record?.identity ? { identity: record.identity } : {}),
      };
      await this.store.write(scope.agentId, record);
      try {
        const identity = await this.runtime.stop(scope.agentId);
        this.sessions.capture(record, identity ?? record.identity);
        // A Stop receipt proves exit, not completion of interrupted deletion.
        record.phase = resetWorkspaceRequired ? "clearing" : "stopped";
        record.stopResult = {
          ...scope,
          phase: "stopped",
          sequence: ++record.sequence,
          ...(record.identity ? { identity: record.identity } : {}),
        };
        record.lastResult = record.stopResult;
      } catch (error) {
        // The failed receipt is terminal for this request, not proof of process exit.
        record.phase = "stopping";
        record.stopResult = {
          ...scope,
          phase: "failed",
          sequence: ++record.sequence,
          errorCode: "stop_failed",
        };
        record.lastResult = record.stopResult;
        const unconfirmed = this.runtime.cleanupUnconfirmed(scope.agentId, error);
        if (unconfirmed) record.exitUnconfirmed = true;
        logger.warning("Agent Stop did not confirm process exit", {
          event: "agent_control:stop_failed",
          agent_id: scope.agentId,
          exit_unconfirmed: unconfirmed,
          error_code: diagnosticErrorCode(error),
        });
      }
      await this.store.write(scope.agentId, record);
      await this.runtime.result(record.lastResult).catch(() => {});
    });
  }
  resetWorkspace(scope: AgentWorkspaceResetRequest): Promise<void> {
    return this.state.run(scope.agentId, async () => {
      let record = await this.store.read(scope.agentId);
      record = await this.repairStaleRecord(scope.agentId, record);
      this.fence(record, scope);
      if (!record || record.scope.epoch !== scope.epoch || record.stopResult?.phase !== "stopped")
        throw new Error("confirmed_stop_required");
      this.#known.add(scope.agentId);
      if (record.workspaceResetResult) {
        if (record.workspaceResetResult.requestId !== scope.requestId)
          throw new Error("control_request_mismatch");
        await this.runtime.result(record.workspaceResetResult).catch(() => {});
        return;
      }
      if (
        !["stopped", "clearing"].includes(record.phase) ||
        record.startResult ||
        this.runtime.running(scope.agentId)
      )
        throw new Error("confirmed_stop_required");
      record.action = "reset-workspace";
      record.phase = "clearing";
      await this.store.write(scope.agentId, record);
      // A clear failure is non-fatal (liveness over durable receipts): it never latches the
      // Agent into a terminal state only an explicit reset retry could leave. The session
      // association is still cleared locally and the chain still proceeds to Start. Matching
      // Raft 1.0.32's resetWorkspace, this is logged only — there is no result field, state, or
      // anything else that blocks a later agent:start.
      try {
        await this.store.clearWorkspace(scope.agentId);
      } catch (error) {
        logger.error("Agent workspace clear did not complete", {
          event: "agent_control:workspace_clear_failed",
          request_id: scope.requestId,
          workspace_id: scope.workspaceId,
          computer_id: scope.computerId,
          agent_id: scope.agentId,
          error_code: diagnosticErrorCode(error),
          outcome: "failed",
        });
      }
      this.sessions.clear(record);
      record.phase = "workspace-reset";
      record.workspaceResetResult = {
        ...scope,
        phase: "workspace-reset",
        sequence: ++record.sequence,
      };
      record.lastResult = record.workspaceResetResult;
      await this.store.write(scope.agentId, record);
      await this.runtime.result(record.lastResult).catch(() => {});
    });
  }
  start(intent: AgentStartIntent): Promise<void> {
    const known = this.#known.has(intent.agentId);
    this.#known.add(intent.agentId);
    return this.state.run(intent.agentId, async () => {
      if (!intent.controlEpoch) throw new Error("control_epoch_required");
      const scope: AgentControlScope = {
        protocolMajor: 1,
        requestId: intent.requestId,
        workspaceId: intent.workspaceId,
        computerId: intent.computerId,
        agentId: intent.agentId,
        provider: intent.provider,
        epoch: intent.controlEpoch,
      };
      let record = await this.store.read(intent.agentId);
      await this.requireRecord(record, intent.agentId, known);
      record = await this.repairStaleRecord(intent.agentId, record);
      this.fence(record, scope);
      if (record?.scope.epoch === scope.epoch && record.startResult) {
        if (record.startResult.requestId !== scope.requestId)
          throw new Error("control_request_mismatch");
        if (
          record.phase === "running" &&
          this.runtime.running(intent.agentId) &&
          intent.wakeMessage
        )
          await this.runtime.wake?.(intent);
        await this.runtime.result(record.startResult).catch(() => {});
        return;
      }
      // A newer operation supersedes our own pending launch retry. The record still says
      // "starting" because that retry has not given up yet, but the retry is a daemon-side timer,
      // never a concurrent launch — so refusing the fresher operation would block a user's
      // Start/Restart for the whole retry window for no reason. Drop the retry (and its streak)
      // and let this operation launch, exactly as a record the previous failure had marked
      // "failed" did before retries existed.
      const supersededRetry =
        record !== undefined &&
        record.phase === "starting" &&
        record.scope.epoch < scope.epoch &&
        this.#launchRetries.has(scope.agentId);
      if (supersededRetry) {
        this.#clearLaunchRetry(scope.agentId);
        this.#launchFailures.reset(scope.agentId);
      } else if (
        record &&
        (["stopping", "clearing", "starting"].includes(record.phase) ||
          (record.phase === "failed" && record.scope.epoch === scope.epoch))
      )
        throw new Error("previous_control_not_completed");
      if (!intent.launchId) {
        // ADR 0041: the server mints and supplies launchId for every managed start; the SDK
        // decode step already rejects a controlEpoch-carrying intent with none, so this is a
        // defensive, should-not-happen guard. Checked before the running-process branch below:
        // a rebind needs a launchId to adopt just as much as a fresh launch needs one to use.
        await this.runtime
          .result({
            ...scope,
            phase: "failed",
            sequence: (record?.scope.epoch === scope.epoch ? record.sequence : 0) + 1,
            errorCode: "agent_launch_id_required",
          })
          .catch(() => {});
        throw new Error("agent_launch_id_required");
      }
      if (this.runtime.running(intent.agentId)) {
        // ADR 0041: a Start that reaches an already-running process under an older, TERMINAL
        // operation (a user Start racing a Daemon-ready `recover()` Start, or Start clicked on
        // an Agent the UI wrongly shows offline) rebinds the running process to the new scope
        // instead of rejecting it — matching Raft's `rebindRunningStart`. Every precondition is
        // checked explicitly: a genuinely different, higher epoch (the fence above already
        // rejects a lower one; an equal epoch was already handled by the replay branch), the
        // same provider, a live record actually claiming "running", and a `launchId` to adopt
        // from. Anything else falls through to the "should not happen" branch below.
        if (
          record &&
          record.phase === "running" &&
          record.launchId &&
          record.scope.provider === scope.provider &&
          scope.epoch > record.scope.epoch
        )
          return this.#rebindRunning(record, scope, intent);
        // The process is running but there is no matching running record to rebind to (the
        // record is missing, or claims a different phase — should not happen). Send a failed
        // result so the server's new operation terminates instead of hanging forever, then
        // still throw so this stays diagnosable (ADR 0033's `control_code` logging).
        const sequence = (record?.scope.epoch === scope.epoch ? record.sequence : 0) + 1;
        await this.runtime
          .result({ ...scope, phase: "failed", sequence, errorCode: "agent_already_running" })
          .catch(() => {});
        throw new Error("agent_already_running");
      }
      if (!record || record.scope.epoch !== scope.epoch)
        record = {
          version: 1,
          scope,
          action: "start",
          phase: "stopped",
          sequence: 0,
          daemonInstanceId: this.instanceId,
        };
      await this.#attemptStart(intent, scope, record, intent.launchId, 1);
    });
  }

  /**
   * One launch attempt for a managed Start, plus its retry bookkeeping (Raft 1.0.32's
   * `SPAWN-FAIL BACKOFF`): a failed spawn does not end the operation with one `launch_failed`
   * record any more — it counts, the next attempt waits an exponentially growing capped cooldown,
   * and the attempt is retried automatically until it succeeds or the attempts run out.
   *
   * Extracted from `start()` so a retry can re-enter exactly this code under the same control
   * scope. That reuse is not an optimisation: the server only authorizes a daemon-side relaunch
   * while its operation is still `starting` under a matching requestId/epoch/launchId
   * (`agent-control.server.ts#authorizeLaunch` — "never for a superseded, failed, or stopped
   * operation"), so a retry can never be a fresh control operation the daemon invents; it must
   * stay inside the managed Start it is recovering.
   *
   * On failure the attempt either schedules the next one (the record stays `starting`, no result
   * is reported, and the server's operation stays pending) or, once the attempts are used up,
   * reports the same terminal `launch_failed` result this path always reported.
   */
  async #attemptStart(
    intent: AgentStartIntent,
    scope: AgentControlScope,
    record: AgentRuntimeRecord,
    launchId: string,
    attempt: number,
  ): Promise<void> {
    record.scope = scope;
    record.action = "start";
    record.phase = "starting";
    record.launchId = launchId;
    record.daemonInstanceId = this.instanceId;
    this.sessions.beginLaunch(record);
    await this.store.write(intent.agentId, record);
    try {
      let identity;
      try {
        identity = await this.runtime.launch(intent, launchId);
      } catch (error) {
        if (!intent.sessionId || !(error instanceof AgentSessionRecoveryError)) throw error;
        const { sessionId: replaced, sessionMode: _, ...fresh } = intent;
        // Fire-and-forget: tell the server the stale session is gone BEFORE the fresh
        // launch attempt, so a later Restart never tries it again — even if this launch
        // then fails. Only the two invalidation reasons are reported; "session_in_use"
        // is a retry signal, not evidence the session itself is gone, so `reason` stays
        // undefined and neither `invalidateSession` nor the retry's narration fires.
        const reason: AgentSessionInvalidateReason | undefined =
          error.code === "session_missing"
            ? "missing"
            : error.code === "provider_replay_rejected"
              ? "provider_replay_rejected"
              : undefined;
        if (reason) this.runtime.invalidateSession?.(intent, launchId, replaced, reason);
        // The retry creates a new native session, so it is an explicit create launch and gets
        // the same startup turn as any other launch that creates a session.
        identity = await this.runtime.launch(
          { ...fresh, sessionMode: "create" },
          launchId,
          replaced,
          reason,
        );
      }
      record.phase = "running";
      record.startResult = {
        ...scope,
        phase: "started",
        launchId,
        sequence: ++record.sequence,
        ...(identity ? { identity } : {}),
      };
      record.lastResult = record.startResult;
      this.sessions.capture(record, identity);
      await this.store.write(intent.agentId, record);
      this.#onLaunchSucceeded(intent.agentId);
    } catch (launchError) {
      try {
        await this.runtime.stop(intent.agentId);
      } catch (stopError) {
        // Cleanup after a failed launch could not confirm the process exited: the record
        // must keep fencing (phase stays "starting", already written above), not be repaired.
        record.exitUnconfirmed = this.runtime.cleanupUnconfirmed(intent.agentId, stopError);
        await this.store.write(intent.agentId, record).catch(() => {});
        logger.error("Agent launch cleanup did not confirm process exit; record stays fenced", {
          event: "agent_control:launch_cleanup_unconfirmed",
          agent_id: intent.agentId,
          exit_unconfirmed: record.exitUnconfirmed,
          error_code: diagnosticErrorCode(stopError),
        });
        throw stopError;
      }
      const failure = this.#launchFailures.recordFailure(intent.agentId);
      if (attempt < LAUNCH_FAILURE_MAX_ATTEMPTS) {
        logger.warning("Agent launch failed; retrying after backoff", {
          event: "agent_control:launch_retry_scheduled",
          agent_id: intent.agentId,
          attempt,
          attempts: failure.attempts,
          cooldown_ms: failure.cooldownMs,
          retry_at_ms: failure.untilMs,
          outcome: "retry",
          error_code: diagnosticErrorCode(launchError),
          ...launchFailureTrace(launchError),
        });
        // The record deliberately stays "starting": a live phase, so the next daemon instance
        // repairs a launch that died mid-cooldown instead of fencing on it
        // (`repairStaleRecord`), and the server's operation stays non-terminal so the retry is
        // still authorized. `lastResult` is left as it was — the retry owns the outcome now.
        await this.store.write(intent.agentId, record);
        this.#scheduleLaunchRetry(intent, scope, launchId, attempt + 1, failure.cooldownMs);
        return;
      }
      const attempts = this.#launchFailures.reset(intent.agentId);
      this.#clearLaunchRetry(intent.agentId);
      record.phase = "failed";
      record.lastResult = {
        ...scope,
        phase: "failed",
        launchId,
        sequence: ++record.sequence,
        errorCode: "launch_failed",
      };
      logger.warning("Agent launch failed", {
        event: "agent_control:launch_failed",
        agent_id: intent.agentId,
        attempts,
        error_code: diagnosticErrorCode(launchError),
        // The terminal record of an exhausted launch carries the same classified evidence as the
        // retry warnings above: once the retries are gone this is the only log line left, so the
        // category/provider/model facts must not be stranded on the earlier `launch_retry_scheduled`.
        ...launchFailureTrace(launchError),
      });
      await this.store.write(intent.agentId, record);
    }
    await this.runtime.result(record.lastResult).catch(() => {});
  }

  /** Clears the failure streak after a successful launch, narrating a recovery only when there
   * actually was a streak to recover from. */
  #onLaunchSucceeded(agentId: string): void {
    const attempts = this.#launchFailures.reset(agentId);
    this.#clearLaunchRetry(agentId);
    if (attempts > 0)
      logger.info("Agent launch recovered after retrying", {
        event: "agent_control:launch_retry_recovered",
        agent_id: agentId,
        attempts,
      });
  }

  /**
   * Arms the single automatic retry for this Agent after `delayMs`. The callback re-reads the
   * control record under the same per-Agent mutex every other transition takes, so a Stop or a
   * newer Start that landed during the cooldown wins: the retry sees a phase/epoch/launchId it
   * does not own and simply returns.
   */
  #scheduleLaunchRetry(
    intent: AgentStartIntent,
    scope: AgentControlScope,
    launchId: string,
    attempt: number,
    delayMs: number,
  ): void {
    this.#clearLaunchRetry(intent.agentId);
    const handle = this.launchRetryScheduler.schedule(() => {
      this.#launchRetries.delete(intent.agentId);
      void this.state
        .run(intent.agentId, async () => {
          const record = await this.store.read(intent.agentId);
          if (
            !record ||
            record.phase !== "starting" ||
            record.scope.epoch !== scope.epoch ||
            record.launchId !== launchId
          )
            return;
          if (this.runtime.running(intent.agentId)) {
            // Something else brought the process up first (a rebind, or a wake through the
            // runtime); adopt that success instead of spawning a second process.
            this.#onLaunchSucceeded(intent.agentId);
            return;
          }
          await this.#attemptStart(intent, scope, record, launchId, attempt);
        })
        .catch((error) => {
          logger.error("Agent launch retry could not run", {
            event: "agent_control:launch_retry_error",
            agent_id: intent.agentId,
            attempt,
            error_code: diagnosticErrorCode(error),
          });
        });
    }, delayMs);
    this.#launchRetries.set(intent.agentId, handle);
  }

  #clearLaunchRetry(agentId: string): void {
    const handle = this.#launchRetries.get(agentId);
    if (handle === undefined) return;
    this.#launchRetries.delete(agentId);
    this.launchRetryScheduler.cancel(handle);
  }

  /** Drops every pending retry and every failure streak. Called on daemon shutdown: a pending
   * retry has no meaning for the next daemon instance, which re-derives its work from the
   * control records (a retry this one died mid-cooldown left behind a repairable "starting"
   * record). */
  dispose(): void {
    for (const handle of this.#launchRetries.values()) this.launchRetryScheduler.cancel(handle);
    this.#launchRetries.clear();
    this.#launchFailures.clear();
  }
  /**
   * A Start met an already-running process under an older, terminal operation (docs/adr/0041).
   * Keeps the process — never spawns, never stops it — and adopts the new scope: the record
   * moves to the new epoch/requestId, keeps `identity`/`daemonInstanceId`, and takes the new
   * `launchId` the server minted for this operation. Sequence restarts the way a fresh record's
   * does; the previous epoch's stop/workspace-reset/start receipts are dropped so they cannot
   * leak into this new epoch's equal-epoch replay branch (`record.startResult` below is this
   * epoch's own, freshly built). Runs inside the same `state.run(agentId, ...)` mutex `start()`
   * already holds — no separate lock, no second in-flight launch possible.
   */
  async #rebindRunning(
    record: AgentRuntimeRecord,
    scope: AgentControlScope,
    intent: AgentStartIntent,
  ): Promise<void> {
    const launchId = intent.launchId as string; // checked by the caller before this is reached.
    const previousEpoch = record.scope.epoch;
    record.scope = scope;
    record.action = "start";
    record.launchId = launchId;
    record.sequence = 0;
    delete record.stopResult;
    delete record.workspaceResetResult;
    delete record.startResult;
    // Never touches `daemonInstanceId` (this daemon instance already owns the running process,
    // confirmed by `runtime.running()`) — "keeps identity, daemonInstanceId" per the brief.
    await this.store.write(scope.agentId, record);
    // Re-points every place the runtime remembers this launch's requestId/controlEpoch/launchId
    // fence (session reference, activity launch, pending Activity/invalidate bookkeeping) and
    // sends the immediate Session re-report + `agent:status(active)` under the new scope; returns
    // the running process's current identity, exactly like a fresh `launch` would.
    const identity = await this.runtime.rebind(intent, launchId);
    record.identity = identity ?? record.identity;
    record.startResult = {
      ...scope,
      phase: "started",
      launchId,
      sequence: ++record.sequence,
      ...(record.identity ? { identity: record.identity } : {}),
    };
    record.lastResult = record.startResult;
    this.sessions.capture(record, record.identity);
    await this.store.write(scope.agentId, record);
    // Reuses the same hook the equal-epoch replay branch already uses to deliver a Start's wake
    // message to a running process — never spawns anything.
    if (intent.wakeMessage) await this.runtime.wake?.(intent);
    await this.runtime.result(record.lastResult).catch(() => {});
    logger.info("Agent Start rebound to an already-running process", {
      event: "agent_control:start_rebound",
      agent_id: scope.agentId,
      request_id: scope.requestId,
      previous_epoch: previousEpoch,
      epoch: scope.epoch,
      launch_id: launchId,
      outcome: "rebound",
    });
  }
  stopped(agentId: string, launchId: string, identity?: SessionIdentity) {
    return this.state.run(agentId, async () => {
      const record = await this.store.read(agentId);
      if (!record || record.phase !== "running" || record.launchId !== launchId) return;
      record.phase = "stopped";
      this.sessions.capture(record, identity ?? record.identity);
      await this.store.write(agentId, record);
    });
  }
  /**
   * The mirror image of `stopped()` (docs/adr/0042): a daemon-initiated (self-launched) wake
   * that reused this Agent's remembered `launchId` makes the on-disk record truthful again —
   * without it, a later server Start would find `phase: "stopped"` (or a stale `launchId`) and
   * either fail to rebind or spawn a second process. Never touches `scope`/`requestId`/`epoch`:
   * a wake carries no new server scope of its own, only the identity it reused, so the existing
   * fence in `start()`/`stop()` is unaffected. A no-op unless the record is exactly the one this
   * launch resumed (`phase === "stopped"` and the same `launchId`) — any other phase means a
   * concurrent server operation (Stop, a fresh Start, a rebind) already moved the record on, and
   * that operation's own writes must win, not this best-effort local wake.
   */
  wake(agentId: string, launchId: string, identity?: SessionIdentity) {
    return this.state.run(agentId, async () => {
      const record = await this.store.read(agentId);
      if (!record || record.phase !== "stopped" || record.launchId !== launchId) return;
      record.phase = "running";
      this.sessions.capture(record, identity ?? record.identity);
      await this.store.write(agentId, record);
    });
  }
  async replay() {
    for (const id of this.#known)
      await this.state.run(id, async () => {
        const record = await this.store.read(id);
        if (record?.lastResult) await this.runtime.result(record.lastResult).catch(() => {});
      });
  }
}
