import { createServerFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import { authMiddleware } from "@/server/auth/function-auth";
import { getDatabaseClient } from "@/server/db/client.server";
import { AgentActivityRepository } from "@/server/db/repositories/agent-activity.repositories.server";
import { requireWorkspaceIdForRequest } from "@/server/workspaces/selection.server";

export const getWorkspaceActivity = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const user = context.user;
    const db = getDatabaseClient();
    if (!db) throw new Error("Agent persistence is unavailable");
    const workspaceId = await requireWorkspaceIdForRequest(db, user.id);
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
