import { decodeAgentContextUsage, type AgentContextUsage } from "@lrm/coforge-sdk/internal";
import type { AgentControlStore } from "../agents/agent-control.server";
import type { AgentDisplay } from "../agents/agent-display.server";
import type { CentrifugoServerApi } from "./server-api.server";
import {
  agentStatusChannel,
  agentStatusChannelForAgent,
} from "../../features/agents/agent-status-realtime";
import { AGENT_VISIBILITY } from "../../features/agents/agent-visibility";
import type { CentrifugoRpcMethod } from "./rpc-handler.server";

/**
 * Fire-and-forget from the daemon's side (never awaited or retried there), gated exactly like
 * `agent:session:invalidate` (`agent-session-receiver.server.ts`): accepted only when
 * `AgentControlState.launchId === message.launchId` for the Agent, so a dead or superseded
 * launch's reading never paints the badge (ADR 0050). Every domain-level mismatch (unknown
 * Agent, foreign scope, non-matching provider, stale launch) is its own idempotent no-op — the
 * daemon must never treat this observation as something to retry — matching the invalidate
 * receiver's own contract. A malformed payload or foreign transport principal is the only 403.
 */
export function createAgentContextUsageMethod(
  agents: Pick<AgentControlStore, "get">,
  display?: Pick<AgentDisplay, "putContextUsage">,
  displayEvents?: Pick<CentrifugoServerApi, "publishJson">,
  /** ADR 0059: the Agent's current visibility, read fresh (no cache). Omitted, or anything other
   * than `"public"`, routes this display push to the per-Agent status channel — the same
   * fail-closed default the publish proxy and Activity sweep use. */
  agentVisibility?: (workspaceId: string, agentId: string) => Promise<string | undefined>,
): CentrifugoRpcMethod {
  return async (payload, metadata) => {
    if (
      !metadata.principal.userId ||
      !metadata.principal.workspaceId ||
      !metadata.principal.computerId
    )
      return { code: 401, message: "daemon authentication required" };
    if (metadata.principal.agentId) return { code: 403, message: "daemon authentication required" };
    let message: AgentContextUsage | undefined;
    try {
      message = decodeAgentContextUsage(payload);
    } catch {
      return { code: 400, message: "invalid Agent context usage" };
    }
    if (
      metadata.principal.workspaceId !== message.workspaceId ||
      metadata.principal.computerId !== message.computerId
    )
      return { code: 403, message: "Agent context usage scope is not authorized" };
    try {
      const agent = await agents.get(message.agentId);
      if (
        !agent ||
        agent.workspaceId !== message.workspaceId ||
        agent.computerId !== message.computerId ||
        agent.runtimeConfig.runtime !== message.provider ||
        agent.state?.launchId !== message.launchId
      )
        return new Uint8Array();
      if (display) {
        const snapshot = await display.putContextUsage(message);
        if (snapshot && displayEvents) {
          const visibility = await agentVisibility?.(message.workspaceId, message.agentId);
          const isPrivate = visibility !== undefined && visibility !== AGENT_VISIBILITY.PUBLIC;
          const channel = isPrivate
            ? agentStatusChannelForAgent(message.workspaceId, message.agentId)
            : agentStatusChannel(message.workspaceId);
          await displayEvents.publishJson(channel, {
            type: "agent:display",
            ...snapshot,
          });
        }
      }
      return new Uint8Array();
    } catch (error) {
      // Every domain-level mismatch above is already a no-op; anything reaching this catch is a
      // genuine failure (DB, schema parse), logged with the same convention #321 introduced for
      // `agent_control:result_rejected`/`agent_session:snapshot_rejected` so it stays diagnosable.
      console.warn(
        JSON.stringify({
          event: "agent_context_usage:rejected",
          request_id: message.requestId,
          agent_id: message.agentId,
          workspace_id: metadata.principal.workspaceId,
          computer_id: metadata.principal.computerId,
          launch_id: message.launchId,
          reason: `unexpected: ${error instanceof Error ? error.name : typeof error}`,
        }),
      );
      return { code: 403, message: "Agent context usage is not authorized" };
    }
  };
}
