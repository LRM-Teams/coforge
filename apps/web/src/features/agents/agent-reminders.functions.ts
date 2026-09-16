import { createServerFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import { z } from "zod";
import { agentIdSchema } from "./agent.schemas";
import { authMiddleware } from "../../server/auth/function-auth";
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

async function context(user: { id: string }) {
  setResponseHeader("Cache-Control", "no-store");
  const db = getDatabaseClient();
  if (!db) throw new Error("Agent persistence is unavailable");
  const workspaceId = await requireWorkspaceIdForRequest(db, user.id);
  return {
    query: new AgentRemindersQuery(prismaAgentReminderReadStore(db)),
    viewer: { userId: user.id, workspaceId },
  };
}

export const listAgentReminders = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(listSchema)
  .handler(async ({ context: authContext, data }) => {
    const { query, viewer } = await context(authContext.user);
    return query.list(viewer, data);
  });
