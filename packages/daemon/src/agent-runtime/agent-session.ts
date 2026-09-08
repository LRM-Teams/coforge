import type { AgentSessionSnapshot, SessionIdentity } from "@coforge/protocol";
import type { AgentRuntimeRecord, AgentRuntimeState } from "./agent-runtime-state";

/** Owns native Session bindings and reliable current-snapshot reporting. */
export class AgentSessions {
  constructor(
    private readonly state: AgentRuntimeState,
    private readonly send: (snapshot: AgentSessionSnapshot) => Promise<void>,
  ) {}

  // Draft operations participate in the caller's existing state.run transaction.
  // They never perform a separate write that could race a control transition.
  beginLaunch(record: AgentRuntimeRecord) {
    delete record.report;
  }

  capture(record: AgentRuntimeRecord, identity: SessionIdentity | undefined) {
    record.identity = identity;
    if (identity && record.launchId && ["running", "stopped"].includes(record.phase))
      record.report = {
        ...record.scope,
        launchId: record.launchId,
        sequence: ++record.sequence,
        identity,
        daemonInstanceId: record.daemonInstanceId,
      };
  }

  clear(record: AgentRuntimeRecord) {
    delete record.identity;
    delete record.report;
  }

  update(agentId: string, launchId: string, identity: SessionIdentity) {
    return this.state.run(agentId, async () => {
      const record = await this.state.store.read(agentId);
      if (!record || record.launchId !== launchId || record.phase !== "running") return;
      this.capture(record, identity);
      await this.state.store.write(agentId, record);
      if (record.report) await this.send(record.report).catch(() => {});
    });
  }

  async replay(agentId?: string) {
    const ids = agentId ? [agentId] : await this.state.store.listAgentIds();
    for (const id of ids)
      await this.state.run(id, async () => {
        const record = await this.state.store.read(id);
        if (record?.report) await this.send(record.report).catch(() => {});
      });
  }
}
