import { createServerFn } from "@tanstack/react-start";
import { getRequest, setResponseHeader } from "@tanstack/react-start/server";
import { requireBrowserUser } from "@/server/auth/require-user.server";
import { getDatabaseClient } from "@/server/db/client.server";
import { AgentActivityRepository } from "@/server/db/repositories/agent-activity.repositories.server";
import { requireWorkspaceIdForRequest } from "@/server/workspaces/selection.server";

export const getWorkspaceActivity = createServerFn({ method: "GET" }).handler(async () => {
  const user = requireBrowserUser(getRequest().headers.get("cookie") ?? undefined);
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
