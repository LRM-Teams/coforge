import { createServerFn } from "@tanstack/react-start";
import { getRequest, setResponseHeader } from "@tanstack/react-start/server";
import { encodeAgentSkillsListRequest } from "@coforge/protocol";
import { agentIdSchema } from "./agent.schemas";
import { requireBrowserUser } from "../../server/auth/require-user.server";
import { getDatabaseClient } from "../../server/db/client.server";
import { requireWorkspaceIdForRequest } from "../../server/workspaces/selection.server";
import {
  AgentSkillsQuery,
  findOwnedSkillsAssignment,
} from "../../server/agents/agent-skills.server";
import {
  createCentrifugoServerApi,
  daemonControlChannel,
} from "../../server/centrifugo/server-api.server";
import { getComputerStatusCache } from "../../server/centrifugo/computer-status.server";
import { getAgentSkillsResults } from "../../server/centrifugo/agent-skills-cache.server";

export const getAgentSkills = createServerFn({ method: "POST" })
  .validator(agentIdSchema)
  .handler(async ({ data: agentId }) => {
    setResponseHeader("Cache-Control", "no-store");
    const user = requireBrowserUser(getRequest().headers.get("cookie") ?? undefined);
    const db = getDatabaseClient();
    if (!db) throw new Error("Agent persistence is unavailable");
    const workspaceId = await requireWorkspaceIdForRequest(db, user.id);
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
