import { createServerFn } from "@tanstack/react-start";
import { getRequest, setResponseHeader } from "@tanstack/react-start/server";
import { RUNTIME_PROVIDER } from "@coforge/protocol";
import {
  agentIdSchema,
  createAgentInputSchema,
  saveAgentRuntimeCredentialInputSchema,
  saveAgentEnvironmentInputSchema,
  updateAgentInputSchema,
} from "./agent.schemas";
import { getDatabaseClient } from "../../server/db/client.server";
import {
  PrismaAgentRepository,
  RepositoryAgentAuthorization,
} from "../../server/db/repositories/agent.repositories.server";
import { ManageAgents } from "../../server/agents/manage-agents.server";
import { PublishAgentRuntimeControl } from "../../server/agents/agent-runtime-control.server";
import { AgentControl } from "../../server/agents/agent-control.server";
import { PrismaAgentControlStore } from "../../server/db/repositories/agent-control.repositories.server";
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
import { ChangeAgentRuntimeCredential } from "../../server/agents/change-agent-runtime-credential.server";
import { getAgentRuntimeLock } from "../../server/agents/agent-runtime-lock.server";
import {
  parseAgentRuntimeConfig,
  publicAgentRuntimeConfig,
} from "../../server/agents/agent-runtime-config.server";
import { getAgentStatusCache } from "../../server/agents/agent-status.server";
import {
  issueAgentActivitySubscriptionToken,
  issueBrowserRealtimeToken,
} from "../../server/auth/browser-realtime-token.server";
import { createAgentSessions } from "../../server/db/repositories/agent-session.repositories.server";
import { getAgentDisplay } from "../../server/agents/agent-display.server";
import { AgentEnvironment } from "../../server/agents/agent-environment.server";

type Database = NonNullable<ReturnType<typeof getDatabaseClient>>;

function database(): Database {
  const db = getDatabaseClient();
  if (!db) throw new Error("Agent persistence is unavailable");
  return db;
}

/** The browser caller and the Workspace their request is scoped to. */
async function browserScope() {
  const user = requireBrowserUser(getRequest().headers.get("cookie") ?? undefined);
  const db = database();
  const workspaceId = await requireWorkspaceIdForRequest(db, user.id);
  return { user, db, workspaceId, scope: { workspaceId, userId: user.id } };
}

/** Runtime start/stop publisher wired to one database and Agent repository. */
function runtimeControl(db: Database, agents: PrismaAgentRepository) {
  const centrifugo = createCentrifugoServerApi();
  const sessions = createAgentSessions(db);
  return new PublishAgentRuntimeControl(
    new RepositoryAgentAuthorization(agents),
    centrifugo,
    async () => {},
    sessions,
    new AgentControl(
      new PrismaAgentControlStore(db),
      centrifugo,
      getAgentRuntimeLock(),
      undefined,
      sessions,
    ),
  );
}

function dependencies() {
  const db = database();
  const agents = new PrismaAgentRepository(db);
  const runtimeLock = getAgentRuntimeLock();
  const runtimeVisibility = new ComputerRuntimeVisibility(new PrismaComputerRuntimeRepository(db));
  const agentManagement = new ManageAgents(
    agents,
    {
      start: (intent, ownerId) => runtimeControl(db, agents).start(intent, ownerId),
      stop: (intent, ownerId) => runtimeControl(db, agents).stop(intent, ownerId),
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
                    workspaceId,
                    provider:
                      config.provider === RUNTIME_PROVIDER.PI && config.hasApiKey
                        ? { in: [RUNTIME_PROVIDER.PI, RUNTIME_PROVIDER.COFORGE] }
                        : config.provider,
                  },
                  select: { models: true },
                },
              },
            },
          },
        });
        if (!connection) return false;
        if (
          !(await runtimeVisibility.canSelect({ workspaceId, userId }, computerId, config.provider))
        )
          return false;
        if (!config.model) return !config.modelProvider && !config.reasoning;
        if (config.provider === RUNTIME_PROVIDER.COFORGE && config.modelProvider) return true;
        const models = connection.computer.modelCatalogs.flatMap((catalog) =>
          Array.isArray(catalog.models) ? catalog.models : [],
        );
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
    runtimeLock,
    () => runtimeCredentials(db, true),
  );
  return { agentManagement, db };
}

function runtimeCredentials(db: Database, decrypt = false) {
  return new AgentRuntimeCredentials(
    new PrismaAgentRuntimeCredentialRepository(db),
    decrypt ? readAgentRuntimeCredentialEncryptionKey(process.env) : undefined,
  );
}

function changeRuntimeCredential(db: Database, decrypt = false) {
  const agents = new PrismaAgentRepository(db);
  return new ChangeAgentRuntimeCredential(
    agents,
    runtimeCredentials(db, decrypt),
    runtimeControl(db, agents),
    getAgentRuntimeLock(),
  );
}

function agentEnvironment(db: Database) {
  const agents = new PrismaAgentRepository(db);
  return new AgentEnvironment(
    new PrismaAgentRuntimeCredentialRepository(db),
    agents,
    runtimeControl(db, agents),
    getAgentRuntimeLock(),
    readAgentRuntimeCredentialEncryptionKey(process.env),
  );
}

export const listAgents = createServerFn({ method: "GET" }).handler(async () => {
  const { workspaceId, scope } = await browserScope();
  const agents = await dependencies().agentManagement.list(scope);
  const statuses = getAgentStatusCache();
  return Promise.all(
    agents.map(async (agent) => {
      const status = agent.computerId
        ? await statuses.snapshot({
            workspaceId,
            computerId: agent.computerId,
            agentId: agent.id,
          })
        : undefined;
      let displaySnapshot;
      if (agent.computerId) {
        try {
          displaySnapshot = await getAgentDisplay().snapshot({
            workspaceId,
            computerId: agent.computerId,
            agentId: agent.id,
          });
        } catch {
          // An unavailable display read model must not hide an Agent profile.
        }
      }
      return {
        ...agent,
        ...(displaySnapshot ? { display: displaySnapshot } : {}),
        status: {
          value: status?.status ?? ("inactive" as const),
          expiresAt: status?.expiresAt ?? null,
          ordering: status
            ? {
                daemonInstanceId: status.daemonInstanceId,
                clientSeq: status.clientSeq,
                observedAtMs: status.observedAtMs,
              }
            : null,
        },
      };
    }),
  );
});

export const getAgentStatusConnectionToken = createServerFn({
  method: "GET",
}).handler(async () => issueBrowserRealtimeToken((await browserScope()).scope));

export const getAgentActivitySubscriptionToken = createServerFn({
  method: "GET",
}).handler(async () => issueAgentActivitySubscriptionToken((await browserScope()).scope));

export const createAgent = createServerFn({ method: "POST" })
  .validator(createAgentInputSchema)
  .handler(async ({ data }) => {
    const user = requireBrowserUser(getRequest().headers.get("cookie") ?? undefined);
    const { agentManagement, db } = dependencies();
    const workspaceId = await workspaceIdForUser(
      db,
      user,
      getRequest().headers.get("accept-language") ?? "",
    );
    return agentManagement.create({ userId: user.id, workspaceId }, data);
  });

export const updateAgent = createServerFn({ method: "POST" })
  .validator(updateAgentInputSchema)
  .handler(async ({ data }) => {
    const { scope } = await browserScope();
    return dependencies().agentManagement.update(scope, data);
  });

export const getAgentDetail = createServerFn({ method: "GET" })
  .validator(agentIdSchema)
  .handler(async ({ data: agentId }) => {
    const { user, db, workspaceId, scope } = await browserScope();
    const activity = new AgentActivityRepository(db);
    const query = new AgentDetailQuery(
      {
        findAuthorized: (workspaceId, id, userId) =>
          db.agent
            .findFirst({
              where: {
                id,
                workspaceId,
                workspace: { members: { some: { userId } } },
              },
              select: {
                id: true,
                workspaceId: true,
                name: true,
                displayName: true,
                description: true,
                createdAt: true,
                computerId: true,
                runtimeConfig: true,
                owner: { select: { id: true, username: true } },
              },
            })
            .then((agent) => agent ?? undefined),
        listActivity: (workspaceId, id) => activity.list(workspaceId, id),
      },
      {
        snapshot: (scope) => getAgentStatusCache().snapshot(scope),
      },
      {
        snapshot: (scope) => getAgentDisplay().snapshot(scope),
      },
    );
    const result = await query.get(workspaceId, agentId, user.id);
    if (!result) throw new Error("Agent not found");
    setResponseHeader("cache-control", "no-store");
    const ownedByCurrentUser = result.owner.id === user.id;
    const runtimeCredential = ownedByCurrentUser
      ? await runtimeCredentials(db).summary(scope, agentId)
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
    const { db, scope } = await browserScope();
    return changeRuntimeCredential(db, true).save(scope, data.agentId, data.apiKey);
  });

export const deleteAgentRuntimeCredential = createServerFn({ method: "POST" })
  .validator(agentIdSchema)
  .handler(async ({ data: agentId }) => {
    const { db, scope } = await browserScope();
    return changeRuntimeCredential(db).delete(scope, agentId);
  });

export const getAgentEnvironment = createServerFn({ method: "GET" })
  .validator(agentIdSchema)
  .handler(async ({ data: agentId }) => {
    const { db, scope } = await browserScope();
    setResponseHeader("cache-control", "no-store");
    return agentEnvironment(db).get(scope, agentId);
  });

export const saveAgentEnvironment = createServerFn({ method: "POST" })
  .validator(saveAgentEnvironmentInputSchema)
  .handler(async ({ data }) => {
    const { db, scope } = await browserScope();
    return agentEnvironment(db).save(scope, data.agentId, data.envVars);
  });
