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
import { AgentDetailQuery } from "../../server/agents/agent-detail.server";
import { AgentActivityRepository } from "../../server/db/repositories/agent-activity.repositories.server";

function dependencies(userId: string) {
  const db = getDatabaseClient();
  if (!db) throw new Error("Agent persistence is unavailable");
  const agents = new PrismaAgentRepository(db);
  const collection = new AgentCollection(
    agents,
    {
      start: (intent, ownerId) =>
        new CloudAgentUseCase(
          new RepositoryAgentAuthorization(agents),
          createCentrifugoServerApi(),
          async () => {},
        ).start(intent, ownerId),
    },
    {
      canRun: async (workspaceId, computerId, config) => {
        const connection = await db.workspaceComputer.findFirst({
          where: { workspaceId, computerId },
          select: {
            computer: {
              select: {
                runtimes: { where: { provider: config.provider }, select: { id: true } },
                modelCatalogs: {
                  where: { provider: config.provider },
                  select: { models: true },
                },
              },
            },
          },
        });
        if (!connection) return false;
        if (config.provider !== RUNTIME_PROVIDER.PI && connection.computer.runtimes.length === 0)
          return false;
        if (!config.model) return !config.modelProvider && !config.reasoning;
        const models = connection.computer.modelCatalogs[0]?.models;
        if (!Array.isArray(models)) return false;
        return models.some((value) => {
          if (!value || typeof value !== "object" || Array.isArray(value)) return false;
          const id = Reflect.get(value, "id");
          const modelProvider = Reflect.get(value, "modelProvider");
          const efforts = Reflect.get(value, "reasoningEfforts");
          return (
            id === config.model &&
            modelProvider === config.modelProvider &&
            (!config.reasoning || (Array.isArray(efforts) && efforts.includes(config.reasoning)))
          );
        });
      },
    },
  );
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
  const modelProvider = Reflect.get(data, "modelProvider");
  const reasoning = Reflect.get(data, "reasoning");
  const computerId = Reflect.get(data, "computerId");
  if (typeof name !== "string" || typeof displayName !== "string")
    throw new Error("Agent name and displayName must be strings");
  if (!displayName.trim() || displayName.length > 200)
    throw new Error("Agent displayName must be non-empty and at most 200 characters");
  if (
    provider !== RUNTIME_PROVIDER.PI &&
    provider !== RUNTIME_PROVIDER.CODEX &&
    provider !== RUNTIME_PROVIDER.CLAUDE_CODE
  )
    throw new Error("Agent provider is not supported");
  if (model !== undefined && typeof model !== "string")
    throw new Error("Agent model must be a string");
  if (modelProvider !== undefined && typeof modelProvider !== "string")
    throw new Error("Agent modelProvider must be a string");
  if (reasoning !== undefined && typeof reasoning !== "string")
    throw new Error("Agent reasoning must be a string");
  if (typeof computerId !== "string" || !computerId)
    throw new Error("Agent computerId is required");
  return { name, displayName, provider, model, modelProvider, reasoning, computerId };
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

export const getAgentDetail = createServerFn({ method: "GET" })
  .validator((agentId: unknown) => {
    if (typeof agentId !== "string" || !agentId) throw new Error("Agent id is required");
    return agentId;
  })
  .handler(async ({ data: agentId }) => {
    const user = requireBrowserUser(getRequest().headers.get("cookie") ?? undefined);
    const db = getDatabaseClient();
    if (!db) throw new Error("Agent persistence is unavailable");
    const membership = await db.workspaceMembership.findFirst({
      where: { userId: user.id },
      select: { workspaceId: true },
      orderBy: [{ workspace: { createdAt: "asc" } }, { workspaceId: "asc" }],
    });
    if (!membership) throw new Error("Agent not found");
    const activity = new AgentActivityRepository(db);
    const query = new AgentDetailQuery({
      findAuthorized: (workspaceId, id, userId) =>
        db.agent
          .findFirst({
            where: { id, workspaceId, workspace: { members: { some: { userId } } } },
            select: {
              id: true,
              workspaceId: true,
              name: true,
              displayName: true,
              createdAt: true,
              runtimeConfig: true,
              owner: { select: { id: true, username: true } },
            },
          })
          .then((agent) => agent ?? undefined),
      listActivity: (workspaceId, id) => activity.list(workspaceId, id),
    });
    const result = await query.get(membership.workspaceId, agentId, user.id);
    if (!result) throw new Error("Agent not found");
    return result;
  });
