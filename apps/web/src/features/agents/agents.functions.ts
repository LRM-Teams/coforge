import { createServerFn } from "@tanstack/react-start";
import { getRequest, setResponseHeader } from "@tanstack/react-start/server";
import { RUNTIME_PROVIDER } from "@coforge/protocol";
import {
  agentIdSchema,
  createAgentInputSchema,
  saveAgentRuntimeCredentialInputSchema,
} from "./agent.schemas";
import { getDatabaseClient } from "../../server/db/client.server";
import {
  PrismaAgentRepository,
  RepositoryAgentAuthorization,
} from "../../server/db/repositories/agent.repositories.server";
import { AgentCollection, runtimeStartFields } from "../../server/agents/agent-collection.server";
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
import { getAgentStatusCache } from "../../server/agents/agent-status.server";
import { issueBrowserRealtimeToken } from "../../server/auth/browser-realtime-token.server";

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
                  where: {
                    provider: config.provider,
                  },
                  select: { models: true },
                },
              },
            },
          },
        });
        if (!connection) return false;
        if (
          config.provider !== RUNTIME_PROVIDER.PI &&
          config.provider !== RUNTIME_PROVIDER.COFORGE &&
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

export const listAgents = createServerFn({ method: "GET" }).handler(async () => {
  const user = requireBrowserUser(getRequest().headers.get("cookie") ?? undefined);
  const { collection, db } = dependencies();
  const workspaceId = await requireWorkspaceIdForRequest(db, user.id);
  const agents = await collection.list({ userId: user.id, workspaceId });
  const statuses = getAgentStatusCache();
  return Promise.all(
    agents.map(async (agent) => {
      const status = agent.computerId
        ? await statuses.snapshot({ workspaceId, computerId: agent.computerId, agentId: agent.id })
        : { status: "inactive" as const, expiresAt: null };
      return { ...agent, status: status.status, statusExpiresAt: status.expiresAt };
    }),
  );
});

export const getAgentStatusConnectionToken = createServerFn({ method: "GET" }).handler(async () => {
  const user = requireBrowserUser(getRequest().headers.get("cookie") ?? undefined);
  const db = getDatabaseClient();
  if (!db) throw new Error("Agent persistence is unavailable");
  const workspaceId = await requireWorkspaceIdForRequest(db, user.id);
  return issueBrowserRealtimeToken({ userId: user.id, workspaceId });
});

export const retryAgentStart = createServerFn({ method: "POST" })
  .validator(agentIdSchema)
  .handler(async ({ data: agentId }) => {
    const user = requireBrowserUser(getRequest().headers.get("cookie") ?? undefined);
    const { collection, db } = dependencies();
    const workspaceId = await requireWorkspaceIdForRequest(db, user.id);
    await collection.retryStart({ userId: user.id, workspaceId }, agentId);
  });

export const createAgent = createServerFn({ method: "POST" })
  .validator(createAgentInputSchema)
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
  .validator(agentIdSchema)
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
              description: true,
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
  .validator(saveAgentRuntimeCredentialInputSchema)
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
  .validator(agentIdSchema)
  .handler(async ({ data: agentId }) => {
    const user = requireBrowserUser(getRequest().headers.get("cookie") ?? undefined);
    const db = getDatabaseClient();
    if (!db) throw new Error("Agent persistence is unavailable");
    const workspaceId = await requireWorkspaceIdForRequest(db, user.id);
    await runtimeCredentials(db).delete({ workspaceId, userId: user.id }, agentId);
    return { deleted: true as const };
  });
