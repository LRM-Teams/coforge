import type {
  AgentControlResult,
  AgentControlScope,
  AgentStartIntent,
  AgentWorkspaceResetRequest,
  SessionIdentity,
} from "@coforge/protocol";
import { AgentSessionRecoveryError } from "../code-agent/contract";
import type { AgentRuntimeRecord, AgentRuntimeState } from "./agent-runtime-state";
import type { AgentSessions } from "./agent-session";

type Runtime = {
  running(agentId: string): boolean;
  stop(agentId: string): Promise<SessionIdentity | undefined>;
  launch(
    intent: AgentStartIntent,
    launchId: string,
    replacedSessionId?: string,
  ): Promise<SessionIdentity | undefined>;
  wake?(intent: AgentStartIntent): Promise<void>;
  result(result: AgentControlResult): Promise<void>;
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
      } catch {
        // The failed receipt is terminal for this request, not proof of process exit.
        record.phase = "stopping";
        record.stopResult = {
          ...scope,
          phase: "failed",
          sequence: ++record.sequence,
          errorCode: "stop_failed",
        };
        record.lastResult = record.stopResult;
      }
      await this.store.write(scope.agentId, record);
      await this.runtime.result(record.lastResult).catch(() => {});
    });
  }
  resetWorkspace(scope: AgentWorkspaceResetRequest): Promise<void> {
    return this.state.run(scope.agentId, async () => {
      const record = await this.store.read(scope.agentId);
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
      try {
        await this.store.clearWorkspace(scope.agentId);
        this.sessions.clear(record);
        record.phase = "workspace-reset";
        record.workspaceResetResult = {
          ...scope,
          phase: "workspace-reset",
          sequence: ++record.sequence,
        };
        record.lastResult = record.workspaceResetResult;
      } catch {
        record.phase = "failed";
        record.workspaceResetResult = {
          ...scope,
          phase: "failed",
          sequence: ++record.sequence,
          errorCode: "workspace_clear_failed",
        };
        record.lastResult = record.workspaceResetResult;
      }
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
          (record.phase === "failed" &&
            (record.scope.epoch === scope.epoch || record.action === "reset-workspace")))
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
      } catch {
        await this.runtime.stop(intent.agentId);
        record.phase = "failed";
        record.lastResult = {
          ...scope,
          phase: "failed",
          launchId,
          sequence: ++record.sequence,
          errorCode: "launch_failed",
        };
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
