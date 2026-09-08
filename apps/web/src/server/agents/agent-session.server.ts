import type { AgentSessionReport, AgentSessionSnapshot } from "@coforge/protocol";
import { requireCurrentAgentScope, type AgentControlStore } from "./agent-control.server";

/** Persists current Session identity; never advances or completes a control operation. */
export class AgentSessionReceiver {
  constructor(private readonly store: AgentControlStore) {}

  async authorize(claim: { workspaceId: string; computerId: string }, report: AgentSessionReport) {
    const agent = await this.store.get(report.agentId);
    if (!agent) throw new Error("Agent Session scope is not authorized");
    if (!agent.state && report.controlEpoch === undefined) return;
    const current = await requireCurrentAgentScope(this.store, claim, {
      ...report,
      requestId: report.startRequestId,
      epoch: report.controlEpoch ?? 0,
    });
    if (
      current.state.launchId !== report.launchId ||
      !["starting", "completed"].includes(current.state.phase)
    )
      throw new Error("Session launch is not current");
  }

  async accept(claim: { workspaceId: string; computerId: string }, snapshot: AgentSessionSnapshot) {
    const agent = await requireCurrentAgentScope(this.store, claim, snapshot);
    const state = agent.state;
    if (state.launchId !== snapshot.launchId || !["starting", "completed"].includes(state.phase))
      throw new Error("Session launch is not current");
    if (snapshot.sequence <= state.sessionSequence) return;
    const identityChanged =
      !!state.identity?.sessionId && state.identity.sessionId !== snapshot.identity.sessionId;
    if (identityChanged && state.launchIdentityBound)
      throw new Error("Native Session identity changed during launch");
    if (
      !(await this.store.replace(agent, {
        ...state,
        identity: snapshot.identity,
        sessionSequence: snapshot.sequence,
        launchIdentityBound: true,
        ...(state.recovered || (identityChanged && state.identity?.state !== "empty")
          ? { recovered: true }
          : {}),
      }))
    )
      throw new Error("Session snapshot lost its fence");
  }
}
