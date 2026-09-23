import {
  createCentrifugoServerApi,
  type CentrifugoServerApi,
} from "#src/server/centrifugo/server-api.server";
import { agentStatusChannel } from "#src/features/agents/agent-status-realtime";

/**
 * The `agent:visibility_changed` publisher. After a visibility change commits, every
 * already-connected browser needs to know: refetch its Agent list, drop the Agent if it can no
 * longer see it, or (re)subscribe to its per-Agent channels if it still can. The event carries
 * only the Agent id — on the existing shared status channel, since it names nothing a viewer who
 * already has the roster doesn't already know — so every member's already-open connection
 * receives it without a new subscription grant.
 *
 * `ChangeAgentVisibility` calls it after its transaction commits.
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
