import {
  createCentrifugoServerApi,
  type CentrifugoServerApi,
} from "../centrifugo/server-api.server";
import { agentStatusChannel } from "../../features/agents/agent-status-realtime";

/**
 * ADR 0059's `agent:visibility_changed` publisher. After a visibility change commits, every
 * already-connected browser needs to know: refetch its Agent list, drop the Agent if it can no
 * longer see it, or (re)subscribe to its per-Agent channels if it still can. The event carries
 * only the Agent id — on the existing shared status channel, since it names nothing a viewer who
 * already has the roster doesn't already know — so every member's already-open connection
 * receives it without a new subscription grant.
 *
 * The visibility-change use case (a separate, parallel slice) calls `publishAgentVisibilityChanged`
 * after its transaction commits; it does not import this module directly today, so the two slices
 * merge independently — the exact exported name/signature is the agreed seam between them.
 */
export function createAgentVisibilityChangedPublisher(
  api: Pick<CentrifugoServerApi, "publishJson">,
): (workspaceId: string, agentId: string) => Promise<void> {
  return (workspaceId, agentId) =>
    api.publishJson(agentStatusChannel(workspaceId), {
      type: "agent:visibility_changed",
      agentId,
    });
}

export const publishAgentVisibilityChanged: (
  workspaceId: string,
  agentId: string,
) => Promise<void> = (workspaceId, agentId) =>
  createAgentVisibilityChangedPublisher(createCentrifugoServerApi())(workspaceId, agentId);
