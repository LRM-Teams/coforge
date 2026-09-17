import type {
  AgentSessionReport,
  AgentSessionSnapshot,
  AgentSessionInvalidate,
} from "@lrm/coforge-sdk/internal";
import { requireCurrentAgentScope, type AgentControlStore } from "./agent-control.server";

/** Persists current Session identity; never advances or completes a control operation. */
export class AgentSessionReceiver {
  constructor(
    private readonly store: AgentControlStore,
    /** Same daemon-freshness check `AgentSessions.verify` uses; optional so existing
     * composition/tests that never call `invalidate` need not supply it. */
    private readonly currentDaemon?: (
      workspaceId: string,
      computerId: string,
    ) => Promise<string | undefined>,
  ) {}

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

  /**
   * A daemon-initiated notice that a stored native Session is gone or was rejected on
   * replay. Idempotent and best-effort: an unknown Agent, a scope mismatch, a stale daemon
   * instance, or a Session/launch that no longer matches the current control state are all
   * silently ignored (never an error) so a late or duplicate report can never clear a newer
   * Session. Clears the current Session association the same way "Reset Session" does
   * (`clearSession`), preserving the old native Session row, and marks the control state
   * `recovered` when an operation is in flight so the UI's existing presentation is used.
   */
  async invalidate(
    claim: { workspaceId: string; computerId: string },
    message: AgentSessionInvalidate,
  ): Promise<void> {
    if (claim.workspaceId !== message.workspaceId || claim.computerId !== message.computerId)
      return;
    const agent = await this.store.get(message.agentId);
    if (
      !agent ||
      agent.workspaceId !== message.workspaceId ||
      agent.computerId !== message.computerId ||
      agent.runtimeConfig.runtime !== message.provider
    )
      return;
    if (
      this.currentDaemon &&
      (await this.currentDaemon(message.workspaceId, message.computerId)) !==
        message.daemonInstanceId
    )
      return;
    const state = agent.state;
    if (
      !state ||
      state.launchId !== message.launchId ||
      state.identity?.sessionId !== message.sessionId
    )
      return;
    const { identity: _identity, ...fields } = state;
    const inFlight = state.phase !== "completed" && state.phase !== "failed";
    await this.store
      .replace(
        agent,
        { ...fields, ...(inFlight || state.recovered ? { recovered: true } : {}) },
        { clearSession: true },
      )
      .catch(() => {
        // Lost a concurrent race (e.g. a newer result/snapshot already moved the Session
        // association forward). Safe to drop: never retried, never surfaced as an error.
      });
  }
}
