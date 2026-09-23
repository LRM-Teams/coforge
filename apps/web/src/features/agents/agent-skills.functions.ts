import { createServerFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import { encodeAgentSkillsListRequest } from "@lrm/coforge-sdk/internal";
import { agentIdSchema } from "./agent.schemas";
import { workspaceUserMiddleware } from "@/features/auth/function-auth";
import { AgentSkillsQuery, findOwnedSkillsAssignment } from "@/server/agents/agent-skills.server";
import {
  createCentrifugoServerApi,
  daemonControlChannel,
} from "@/server/centrifugo/server-api.server";
import { getComputerStatusCache } from "@/server/centrifugo/computer-status.server";
import { getAgentSkillsResults } from "@/server/centrifugo/agent-skills-cache.server";

export const getAgentSkills = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(agentIdSchema)
  .handler(async ({ data: agentId, context }) => {
    setResponseHeader("Cache-Control", "no-store");
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
