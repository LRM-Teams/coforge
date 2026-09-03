import { createServerFn } from "@tanstack/react-start";
import { getRequest, setResponseHeader } from "@tanstack/react-start/server";
import { RUNTIME_PROVIDER } from "@coforge/protocol";
import { getDatabaseClient } from "../../server/db/client.server";
import {
  PrismaAgentRepository,
  RepositoryAgentAuthorization,
} from "../../server/db/repositories/agent.repositories.server";
import {
  AgentCollection,
  runtimeStartFields,
  type AgentCreateInput,
} from "../../server/agents/agent-collection.server";
import { CloudAgentUseCase } from "../../server/agents/cloud-agent.server";
import { createCentrifugoServerApi } from "../../server/centrifugo/server-api.server";
import { requireBrowserUser } from "../../server/auth/require-user.server";
import { AgentDetailQuery } from "../../server/agents/agent-detail.server";
import { AgentActivityRepository } from "../../server/db/repositories/agent-activity.repositories.server";
import { workspaceIdForUser } from "../../server/workspaces/enrollment.server";
import { requireWorkspaceIdForRequest } from "../../server/workspaces/selection.server";
import { ComputerRuntimeVisibility } from "../../server/computers/computer-runtime-visibility.server";
import { PrismaComputerRuntimeRepository } from "../../server/db/repositories/computer-runtime.repositories.server";
import { PrismaAgentRuntimeCredentialRepository } from "../../server/db/repositories/agent-runtime-credential.repositories.server";
import {
  AgentRuntimeCredentials,
  readAgentRuntimeCredentialEncryptionKey,
} from "../../server/agents/agent-runtime-credentials.server";
import {
  parseAgentRuntimeConfig,
  publicAgentRuntimeConfig,
} from "../../server/agents/agent-runtime-config.server";

function dependencies() {
  const db = getDatabaseClient();
  if (!db) throw new Error("Agent persistence is unavailable");
  const agents = new PrismaAgentRepository(db);
  const runtimeVisibility = new ComputerRuntimeVisibility(new PrismaComputerRuntimeRepository(db));
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
      canRun: async (workspaceId, userId, computerId, config) => {
        const connection = await db.workspaceComputer.findFirst({
          where: { workspaceId, computerId },
          select: {
            computer: {
              select: {
                modelCatalogs: {
                  where: { provider: config.provider },
                  select: { models: true },
                },
              },
            },
          },
        });
        if (!connection) return false;
        if (
          config.provider !== RUNTIME_PROVIDER.PI &&
          !(await runtimeVisibility.canSelect({ workspaceId, userId }, computerId, config.provider))
        )
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
  return { collection, db };
}

function runtimeCredentials(
  db: NonNullable<ReturnType<typeof getDatabaseClient>>,
  decrypt = false,
) {
  return new AgentRuntimeCredentials(
    new PrismaAgentRuntimeCredentialRepository(db),
    decrypt ? readAgentRuntimeCredentialEncryptionKey(process.env) : undefined,
  );
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
  const { collection, db } = dependencies();
  const workspaceId = await requireWorkspaceIdForRequest(db, user.id);
  return collection.list({ userId: user.id, workspaceId });
});

export const createAgent = createServerFn({ method: "POST" })
  .validator(validateCreateInput)
  .handler(async ({ data }) => {
    const user = requireBrowserUser(getRequest().headers.get("cookie") ?? undefined);
    const { collection, db } = dependencies();
    const workspaceId = await workspaceIdForUser(
      db,
      user,
      getRequest().headers.get("accept-language") ?? "",
    );
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
    const workspaceId = await requireWorkspaceIdForRequest(db, user.id);
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
    const result = await query.get(workspaceId, agentId, user.id);
    if (!result) throw new Error("Agent not found");
    setResponseHeader("cache-control", "no-store");
    const ownedByCurrentUser = result.owner.id === user.id;
    const runtimeCredential = ownedByCurrentUser
      ? await runtimeCredentials(db).summary({ workspaceId, userId: user.id }, agentId)
      : null;
    return {
      ...result,
      runtimeConfig: publicAgentRuntimeConfig(parseAgentRuntimeConfig(result.runtimeConfig)),
      ownedByCurrentUser,
      runtimeCredential,
    };
  });

export const saveAgentRuntimeCredential = createServerFn({ method: "POST" })
  .validator((data: unknown) => {
    if (!data || typeof data !== "object" || Array.isArray(data))
      throw new Error("Agent runtime credential input is required");
    const agentId = Reflect.get(data, "agentId");
    const apiKey = Reflect.get(data, "apiKey");
    if (typeof agentId !== "string" || !agentId || typeof apiKey !== "string")
      throw new Error("Agent runtime credential input is invalid");
    return { agentId, apiKey };
  })
  .handler(async ({ data }) => {
    const user = requireBrowserUser(getRequest().headers.get("cookie") ?? undefined);
    const db = getDatabaseClient();
    if (!db) throw new Error("Agent persistence is unavailable");
    const workspaceId = await requireWorkspaceIdForRequest(db, user.id);
    const credentials = runtimeCredentials(db, true);
    const summary = await credentials.save(
      { workspaceId, userId: user.id },
      data.agentId,
      data.apiKey,
    );
    const agents = new PrismaAgentRepository(db);
    const agent = await agents.getById(data.agentId);
    if (agent?.computerId) {
      try {
        await new CloudAgentUseCase(
          new RepositoryAgentAuthorization(agents),
          createCentrifugoServerApi(),
          async () => {},
        ).start(
          {
            protocolMajor: 1,
            requestId: crypto.randomUUID(),
            workspaceId,
            computerId: agent.computerId,
            agentId: agent.id,
            ...runtimeStartFields(agent.runtimeConfig),
          },
          user.id,
        );
      } catch {
        // The encrypted config is saved; daemon ready recovery retries the launch.
      }
    }
    return summary;
  });

export const deleteAgentRuntimeCredential = createServerFn({ method: "POST" })
  .validator((agentId: unknown) => {
    if (typeof agentId !== "string" || !agentId) throw new Error("Agent id is required");
    return agentId;
  })
  .handler(async ({ data: agentId }) => {
    const user = requireBrowserUser(getRequest().headers.get("cookie") ?? undefined);
    const db = getDatabaseClient();
    if (!db) throw new Error("Agent persistence is unavailable");
    const workspaceId = await requireWorkspaceIdForRequest(db, user.id);
    await runtimeCredentials(db).delete({ workspaceId, userId: user.id }, agentId);
    return { deleted: true as const };
  });
