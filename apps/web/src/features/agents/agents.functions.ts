import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { RUNTIME_PROVIDER } from "@coforge/protocol";
import { getDatabaseClient } from "../../server/db/client.server";
import {
  PrismaAgentRepository,
  RepositoryAgentAuthorization,
} from "../../server/db/repositories/agent.repositories.server";
import {
  AgentCollection,
  type AgentCreateInput,
} from "../../server/agents/agent-collection.server";
import { CloudAgentUseCase } from "../../server/agents/cloud-agent.server";
import { createCentrifugoServerApi } from "../../server/centrifugo/server-api.server";
import { requireBrowserUser } from "../../server/auth/require-user.server";

function dependencies(userId: string) {
  const db = getDatabaseClient();
  if (!db) throw new Error("Agent persistence is unavailable");
  const agents = new PrismaAgentRepository(db);
  const collection = new AgentCollection(agents, {
    start: (intent, ownerId) =>
      new CloudAgentUseCase(
        new RepositoryAgentAuthorization(agents),
        createCentrifugoServerApi(),
        async () => {},
      ).start(intent, ownerId),
  });
  return db.workspaceMembership
    .findFirst({
      where: { userId },
      select: { workspaceId: true },
      orderBy: [{ workspace: { createdAt: "asc" } }, { workspaceId: "asc" }],
    })
    .then((membership) => {
      if (!membership) throw new Error("No Workspace membership exists for the authenticated user");
      return { collection, workspaceId: membership.workspaceId };
    });
}

function validateCreateInput(data: unknown): AgentCreateInput {
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new Error("Agent creation input is required");
  const name = Reflect.get(data, "name");
  const displayName = Reflect.get(data, "displayName");
  const provider = Reflect.get(data, "provider");
  const model = Reflect.get(data, "model");
  const reasoning = Reflect.get(data, "reasoning");
  if (typeof name !== "string" || typeof displayName !== "string")
    throw new Error("Agent name and displayName must be strings");
  if (
    provider !== RUNTIME_PROVIDER.PI &&
    provider !== RUNTIME_PROVIDER.CODEX &&
    provider !== RUNTIME_PROVIDER.CLAUDE_CODE
  )
    throw new Error("Agent provider is not supported");
  if (model !== undefined && typeof model !== "string")
    throw new Error("Agent model must be a string");
  if (reasoning !== undefined && typeof reasoning !== "string")
    throw new Error("Agent reasoning must be a string");
  return { name, displayName, provider, model, reasoning };
}

export const listAgents = createServerFn({ method: "GET" }).handler(async () => {
  const user = requireBrowserUser(getRequest().headers.get("cookie") ?? undefined);
  const { collection, workspaceId } = await dependencies(user.id);
  return collection.list({ userId: user.id, workspaceId });
});

export const createAgent = createServerFn({ method: "POST" })
  .validator(validateCreateInput)
  .handler(async ({ data }) => {
    const user = requireBrowserUser(getRequest().headers.get("cookie") ?? undefined);
    const { collection, workspaceId } = await dependencies(user.id);
    return collection.create({ userId: user.id, workspaceId }, data);
  });
