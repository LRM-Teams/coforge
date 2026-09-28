import { createServerFn } from "@tanstack/react-start";
import { declareNoStore } from "#src/features/no-store-response.server";
import { z } from "zod";
import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { userAgentControl } from "#src/server/agents/user-agent-control.server";

const agentId = z.string().uuid();
const executeInput = z.object({
  agentId,
  action: z.enum(["start", "stop", "restart", "reset-session", "full-reset"]),
  requestId: z.string().uuid(),
  confirmed: z.boolean().optional(),
});

export const executeAgentControl = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(executeInput)
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    declareNoStore();
    const result = await userAgentControl(db).execute({ ...data, userId: user.id, workspaceId });
    if (result.phase === "failed") throw new Error("Agent control failed");
  });
