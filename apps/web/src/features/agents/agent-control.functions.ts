import { createServerFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import { z } from "zod";
import { workspaceUserMiddleware, type WorkspaceUserContext } from "../auth/function-auth";
import { AgentControl } from "../../server/agents/agent-control.server";
import { getAgentControlSignal } from "../../server/agents/agent-control-signal.server";
import { PrismaAgentControlStore } from "../../server/db/repositories/agent-control.repositories.server";
import { createAgentSessions } from "../../server/db/repositories/agent-session.repositories.server";
import { PrismaDirectConversationRepository } from "../../server/db/repositories/direct-conversation.repositories.server";
import { getAgentRuntimeLock } from "../../server/agents/agent-runtime-lock.server";
import { createCentrifugoServerApi } from "../../server/centrifugo/server-api.server";

const agentId = z.string().uuid();
const executeInput = z.object({
  agentId,
  action: z.enum(["start", "stop", "restart", "reset-session", "full-reset"]),
  requestId: z.string().uuid(),
  confirmed: z.boolean().optional(),
});

function agentControl(db: WorkspaceUserContext["db"]) {
  return new AgentControl(
    new PrismaAgentControlStore(db),
    createCentrifugoServerApi(),
    getAgentRuntimeLock(),
    undefined,
    createAgentSessions(db),
    getAgentControlSignal(),
    new PrismaDirectConversationRepository(db),
  );
}

export const executeAgentControl = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(executeInput)
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    setResponseHeader("cache-control", "no-store");
    const result = await agentControl(db).execute({ ...data, userId: user.id, workspaceId });
    if (result.phase === "failed") throw new Error("Agent control failed");
  });
