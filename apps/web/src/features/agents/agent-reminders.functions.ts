import { createServerFn } from "@tanstack/react-start";
import { getRequest, setResponseHeader } from "@tanstack/react-start/server";
import { z } from "zod";
import { agentIdSchema } from "./agent.schemas";
import { requireBrowserUser } from "../../server/auth/require-user.server";
import { getDatabaseClient } from "../../server/db/client.server";
import { requireWorkspaceIdForRequest } from "../../server/workspaces/selection.server";
import {
  AgentRemindersQuery,
  prismaAgentReminderReadStore,
} from "../../server/agents/agent-reminders.server";

const listSchema = z.object({
  agentId: agentIdSchema,
  cursor: z.object({ id: z.uuid() }).optional(),
});

async function context() {
  setResponseHeader("Cache-Control", "no-store");
  const user = requireBrowserUser(getRequest().headers.get("cookie") ?? undefined);
  const db = getDatabaseClient();
  if (!db) throw new Error("Agent persistence is unavailable");
  const workspaceId = await requireWorkspaceIdForRequest(db, user.id);
  return {
    query: new AgentRemindersQuery(prismaAgentReminderReadStore(db)),
    viewer: { userId: user.id, workspaceId },
  };
}

export const listAgentReminders = createServerFn({ method: "GET" })
  .validator(listSchema)
  .handler(async ({ data }) => {
    const { query, viewer } = await context();
    return query.list(viewer, data);
  });
