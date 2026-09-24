import { createServerFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { AgentActivityRepository } from "#src/server/db/repositories/agent-activity.repositories.server";
import { agentIdSchema } from "./agent.schemas";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import {
  agentVisibilityViewerForUser,
  assertAgentVisible,
} from "#src/server/agents/agent-visibility.server";

export const getWorkspaceActivity = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context }) => {
    const { user, db, workspaceId } = context;
    setResponseHeader("cache-control", "no-store");
    const agents = await new AgentActivityRepository(db).listForMember(workspaceId, user.id);
    return {
      workspaceId,
      agents: agents.map((agent) => ({
        ...agent,
        activity: agent.activity,
      })),
    };
  });

/** The Agent detail Activity tab's feed, without the rest of `getAgentDetail`'s payload. */
export const getAgentActivityFeed = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(agentIdSchema)
  .handler(async ({ data: agentId, context }) => {
    const { user, db, workspaceId } = context;
    const agent = await db.agent.findFirst({
      where: {
        id: agentId,
        workspaceId,
        workspace: { members: { some: { userId: user.id } } },
        ...ACTIVE_AGENT_WHERE,
      },
      select: { id: true, ownerId: true, visibility: true },
    });
    if (!agent) throw new Error("Agent not found");
    // Reached directly (not only through the profile panel that normally gated this
    // tab), so the same visibility check applies here too.
    const viewer = await agentVisibilityViewerForUser(db, workspaceId, user.id);
    assertAgentVisible(viewer, agent);
    setResponseHeader("cache-control", "no-store");
    return new AgentActivityRepository(db).list(workspaceId, agentId);
  });
