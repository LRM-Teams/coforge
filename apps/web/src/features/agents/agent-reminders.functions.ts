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

const statusSchema = z.enum(["scheduled", "fired", "canceled"]);
const listSchema = z.object({
  agentId: agentIdSchema,
  status: statusSchema.optional(),
  cursor: z.object({ id: z.uuid() }).optional(),
});
const historySchema = z.object({ agentId: agentIdSchema, reminderId: z.uuid() });

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

export const getAgentReminderHistory = createServerFn({ method: "GET" })
  .validator(historySchema)
  .handler(async ({ data }) => {
    const { query, viewer } = await context();
    return query.history(viewer, data);
  });
