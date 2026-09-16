import { createServerFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import { z } from "zod";
import { authMiddleware } from "../../server/auth/function-auth";
import { AgentControl } from "../../server/agents/agent-control.server";
import { getAgentControlSignal } from "../../server/agents/agent-control-signal.server";
import { PrismaAgentControlStore } from "../../server/db/repositories/agent-control.repositories.server";
import { createAgentSessions } from "../../server/db/repositories/agent-session.repositories.server";
import { getAgentRuntimeLock } from "../../server/agents/agent-runtime-lock.server";
import { createCentrifugoServerApi } from "../../server/centrifugo/server-api.server";
import { getDatabaseClient } from "../../server/db/client.server";
import { requireWorkspaceIdForRequest } from "../../server/workspaces/selection.server";

const agentId = z.string().uuid();
const executeInput = z.object({
  agentId,
  action: z.enum(["restart", "reset-session", "full-reset"]),
  requestId: z.string().uuid(),
  confirmed: z.boolean().optional(),
});

function dependencies() {
  const db = getDatabaseClient();
  if (!db) throw new Error("Agent control persistence is unavailable");
  return {
    db,
    control: new AgentControl(
      new PrismaAgentControlStore(db),
      createCentrifugoServerApi(),
      getAgentRuntimeLock(),
      undefined,
      createAgentSessions(db),
      getAgentControlSignal(),
    ),
  };
}

export const executeAgentControl = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(executeInput)
  .handler(async ({ data, context }) => {
    setResponseHeader("cache-control", "no-store");
    const user = context.user;
    const { db, control } = dependencies();
    const workspaceId = await requireWorkspaceIdForRequest(db, user.id);
    const result = await control.execute({ ...data, userId: user.id, workspaceId });
    if (result.phase === "failed") throw new Error("Agent control failed");
  });
