import { decodeAgentActivity, type AgentActivity } from "@coforge/protocol";

import { getDatabaseClient } from "../db/client.server";
import { PrismaAgentRepository } from "../db/repositories/agent.repositories.server";

type AgentActivityPublicationDependencies = {
  proxySecret: string | undefined;
  agentBelongsToWorkspace(workspaceId: string, agentId: string): Promise<boolean>;
  computerBelongsToWorkspace(workspaceId: string, computerId: string): Promise<boolean>;
  observe(activity: AgentActivity): Promise<void>;
};

const unauthorized = () =>
  Response.json({ error: { code: 403, message: "activity publication is not authorized" } });

/** Validate one client-originated Centrifugo publication before it reaches the Activity channel. */
export async function handleAgentActivityPublication(
  request: Request,
  dependencies: AgentActivityPublicationDependencies,
): Promise<Response> {
  if (
    !dependencies.proxySecret ||
    request.headers.get("x-coforge-centrifugo-proxy-secret") !== dependencies.proxySecret
  )
    return unauthorized();

  try {
    const body = (await request.json()) as {
      user?: unknown;
      channel?: unknown;
      b64data?: unknown;
      meta?: { workspace_id?: unknown; computer_id?: unknown };
    };
    const workspaceId = body.meta?.workspace_id;
    const computerId = body.meta?.computer_id;
    if (
      typeof body.user !== "string" ||
      typeof workspaceId !== "string" ||
      typeof computerId !== "string" ||
      typeof body.b64data !== "string" ||
      body.channel !== `activity:${workspaceId}`
    )
      return unauthorized();

    const payload = Uint8Array.from(atob(body.b64data), (character) => character.charCodeAt(0));
    const activity = decodeAgentActivity(payload);
    if (
      activity.protocolMajor !== 1 ||
      activity.workspaceId !== workspaceId ||
      !(await dependencies.computerBelongsToWorkspace(workspaceId, computerId)) ||
      !(await dependencies.agentBelongsToWorkspace(workspaceId, activity.agentId))
    )
      return unauthorized();

    try {
      await dependencies.observe(activity);
    } catch {
      // Observation failures do not turn Activity into a reliable business message.
    }
    return Response.json({ result: { skip_history: true } });
  } catch {
    return unauthorized();
  }
}

export function createAgentActivityPublicationHandler() {
  return async (request: Request) => {
    const db = getDatabaseClient();
    if (!db) return unauthorized();
    const agents = new PrismaAgentRepository(db);
    return handleAgentActivityPublication(request, {
      proxySecret: process.env.COFORGE_CENTRIFUGO_PROXY_SECRET,
      agentBelongsToWorkspace: async (workspaceId, agentId) =>
        (await agents.getById(agentId))?.workspaceId === workspaceId,
      computerBelongsToWorkspace: async (workspaceId, computerId) =>
        Boolean(
          await db.workspaceComputer.findUnique({
            where: { workspaceId_computerId: { workspaceId, computerId } },
            select: { id: true },
          }),
        ),
      observe: async (activity) => console.info("agent:activity", activity),
    });
  };
}
