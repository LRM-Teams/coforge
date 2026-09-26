import { createServerFn } from "@tanstack/react-start";
import { declareNoStore } from "./no-store-response.server";
import { z } from "zod";
import { agentIdSchema } from "./agent.schemas";
import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import {
  AgentRemindersQuery,
  prismaAgentReminderReadStore,
} from "#src/server/agents/agent-reminders.server";

const listSchema = z.object({
  agentId: agentIdSchema,
  cursor: z.object({ id: z.uuid() }).optional(),
});

export const listAgentReminders = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(listSchema)
  .handler(async ({ context: { user, db, workspaceId }, data }) => {
    declareNoStore();
    return new AgentRemindersQuery(prismaAgentReminderReadStore(db)).list(
      { userId: user.id, workspaceId },
      data,
    );
  });
