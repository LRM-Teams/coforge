import { createServerFn } from "@tanstack/react-start";
import { getRequest, setResponseHeader } from "@tanstack/react-start/server";
import { z } from "zod";
import { requireBrowserUser } from "../../server/auth/require-user.server";
import { AgentControl } from "../../server/agents/agent-control.server";
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
    ),
  };
}

export const executeAgentControl = createServerFn({ method: "POST" })
  .validator(executeInput)
  .handler(async ({ data }) => {
    setResponseHeader("cache-control", "no-store");
    const user = requireBrowserUser(getRequest().headers.get("cookie") ?? undefined);
    const { db, control } = dependencies();
    const workspaceId = await requireWorkspaceIdForRequest(db, user.id);
    const result = await control.execute({ ...data, userId: user.id, workspaceId });
    if (result.phase === "failed") throw new Error("Agent control failed");
  });
