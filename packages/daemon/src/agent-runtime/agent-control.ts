import { getLogger } from "@logtape/logtape";
import type {
  AgentControlResult,
  AgentControlScope,
  AgentStartIntent,
  AgentWorkspaceResetRequest,
  SessionIdentity,
} from "@lrm/coforge-sdk/internal";
import { AgentSessionRecoveryError } from "../code-agent/contract";
import { diagnosticErrorCode } from "../platform/diagnostic-error-code";
import type { AgentRuntimeRecord, AgentRuntimeState } from "./agent-runtime-state";
import type { AgentSessions } from "./agent-session";

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
  ): Promise<SessionIdentity | undefined>;
  wake?(intent: AgentStartIntent): Promise<void>;
  /** Fire-and-forget; never blocks or fails the launch it is reported alongside. */
  invalidateSession?(
    intent: AgentStartIntent,
    launchId: string,
    sessionId: string,
    reason: "missing" | "provider_replay_rejected",
  ): void;
  result(result: AgentControlResult): Promise<void>;
  /** True when `error` (from `stop`/`launch`'s cleanup) means the local process's exit could not
   * be confirmed — the one case a stale-looking record must keep fencing rather than repair. */
  cleanupUnconfirmed(agentId: string, error: unknown): boolean;
};

/** Owns separate stop, workspace reset, and start primitives. */
export class AgentControl {
  readonly #known = new Set<string>();
  constructor(
    private readonly instanceId: string,
    private readonly state: AgentRuntimeState,
    private readonly sessions: AgentSessions,
    private readonly runtime: Runtime,
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
      await this.store.read(id);
      this.#known.add(id);
    }
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
      if (
        record &&
        (["stopping", "clearing", "starting"].includes(record.phase) ||
          (record.phase === "failed" && record.scope.epoch === scope.epoch))
      )
        throw new Error("previous_control_not_completed");
      if (this.runtime.running(intent.agentId)) throw new Error("agent_already_running");
      if (!record || record.scope.epoch !== scope.epoch)
        record = {
          version: 1,
          scope,
          action: "start",
          phase: "stopped",
          sequence: 0,
          daemonInstanceId: this.instanceId,
        };
      record.scope = scope;
      record.action = "start";
      const launchId = crypto.randomUUID();
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
          // is a retry signal, not evidence the session itself is gone.
          if (error.code === "session_missing" || error.code === "provider_replay_rejected")
            this.runtime.invalidateSession?.(
              intent,
              launchId,
              replaced,
              error.code === "session_missing" ? "missing" : "provider_replay_rejected",
            );
          identity = await this.runtime.launch(fresh, launchId, replaced);
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
          error_code: diagnosticErrorCode(launchError),
        });
        await this.store.write(intent.agentId, record);
      }
      await this.runtime.result(record.lastResult).catch(() => {});
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
  async replay() {
    for (const id of this.#known)
      await this.state.run(id, async () => {
        const record = await this.store.read(id);
        if (record?.lastResult) await this.runtime.result(record.lastResult).catch(() => {});
      });
  }
}
