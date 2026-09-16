import { createServerFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import { workspaceMemberMiddleware } from "@/server/auth/function-auth";
import { AgentActivityRepository } from "@/server/db/repositories/agent-activity.repositories.server";

export const getWorkspaceActivity = createServerFn({ method: "GET" })
  .middleware([workspaceMemberMiddleware])
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
