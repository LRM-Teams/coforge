import { createServerFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import { z } from "zod";
import { agentIdSchema } from "./agent.schemas";
import { workspaceMemberMiddleware } from "../../server/auth/function-auth";
import {
  AgentRemindersQuery,
  prismaAgentReminderReadStore,
} from "../../server/agents/agent-reminders.server";

const listSchema = z.object({
  agentId: agentIdSchema,
  cursor: z.object({ id: z.uuid() }).optional(),
});

export const listAgentReminders = createServerFn({ method: "GET" })
  .middleware([workspaceMemberMiddleware])
  .validator(listSchema)
  .handler(async ({ context: { user, db, workspaceId }, data }) => {
    setResponseHeader("Cache-Control", "no-store");
    return new AgentRemindersQuery(prismaAgentReminderReadStore(db)).list(
      { userId: user.id, workspaceId },
      data,
    );
  });
