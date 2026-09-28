import { createServerFn } from "@tanstack/react-start";
import { declareNoStore } from "#src/features/no-store-response.server";
import { encodeAgentSkillsListRequest } from "@lrm/coforge-sdk/internal";
import { agentIdSchema } from "./agent.schemas";
import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import {
  AgentSkillsQuery,
  findOwnedSkillsAssignment,
} from "#src/server/agents/agent-skills.server";
import {
  createCentrifugoServerApi,
  daemonControlChannel,
} from "#src/server/centrifugo/server-api.server";
import { getComputerStatusCache } from "#src/server/centrifugo/computer-status.server";
import { getAgentSkillsResults } from "#src/server/centrifugo/agent-skills-cache.server";

export const getAgentSkills = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(agentIdSchema)
  .handler(async ({ data: agentId, context }) => {
    declareNoStore();
    const { user, db, workspaceId } = context;
    const query = new AgentSkillsQuery({
      findOwned: (viewer, id) => findOwnedSkillsAssignment(db, viewer, id),
      online: (scope) => getComputerStatusCache().get(scope),
      publish: (request) =>
        createCentrifugoServerApi().publish(
          daemonControlChannel(request.workspaceId, request.computerId),
          encodeAgentSkillsListRequest(request),
        ),
      results: getAgentSkillsResults(),
    });
    return query.get({ userId: user.id, workspaceId }, agentId);
  });
