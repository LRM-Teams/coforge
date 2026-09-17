import { createServerFn } from "@tanstack/react-start";
import { getRequest, setResponseHeader } from "@tanstack/react-start/server";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import {
  agentIdSchema,
  createAgentInputSchema,
  saveAgentRuntimeCredentialInputSchema,
  saveAgentEnvironmentInputSchema,
  updateAgentInputSchema,
  updateAgentRoleInputSchema,
} from "./agent.schemas";
import { setAgentRole } from "../../server/agents/agent-role.server";
import { isAdminLike, type WorkspaceMemberRole } from "../../server/workspaces/member-role.server";
import { requireDatabaseClient } from "../../server/db/client.server";
import {
  PrismaAgentRepository,
  RepositoryAgentAuthorization,
} from "../../server/db/repositories/agent.repositories.server";
import { ManageAgents } from "../../server/agents/manage-agents.server";
import { PublishAgentRuntimeControl } from "../../server/agents/agent-runtime-control.server";
import { AgentControl } from "../../server/agents/agent-control.server";
import { getAgentControlSignal } from "../../server/agents/agent-control-signal.server";
import { PrismaAgentControlStore } from "../../server/db/repositories/agent-control.repositories.server";
import { createCentrifugoServerApi } from "../../server/centrifugo/server-api.server";
import { authMiddleware, workspaceUserMiddleware } from "../../server/auth/function-auth";
import { ActionCards } from "../../server/conversations/action-cards.server";
import { CentrifugoConversationRealtime } from "../../server/conversations/conversation-realtime.server";
import { AgentDetailQuery } from "../../server/agents/agent-detail.server";
import { AgentActivityRepository } from "../../server/db/repositories/agent-activity.repositories.server";
import { workspaceIdForUser } from "../../server/workspaces/enrollment.server";
import { workspaceMemberRole } from "../../server/workspaces/members.server";
import { ComputerRuntimeVisibility } from "../../server/computers/computer-runtime-visibility.server";
import { PrismaComputerRuntimeRepository } from "../../server/db/repositories/computer-runtime.repositories.server";
import { PrismaAgentRuntimeCredentialRepository } from "../../server/db/repositories/agent-runtime-credential.repositories.server";
import {
  AgentRuntimeCredentials,
  readAgentRuntimeCredentialEncryptionKey,
} from "../../server/agents/agent-runtime-credentials.server";
import { ChangeAgentRuntimeCredential } from "../../server/agents/change-agent-runtime-credential.server";
import { getAgentRuntimeLock } from "../../server/agents/agent-runtime-lock.server";
import { agentRuntimeSelectionIsAvailable } from "../../server/agents/agent-runtime-availability.server";
import {
  parseAgentRuntimeConfig,
  publicAgentRuntimeConfig,
} from "../../server/agents/agent-runtime-config.server";
import { getAgentStatusCache } from "../../server/agents/agent-status.server";
import { weeklyReportAssistantAgentName } from "../../server/records/weekly-report-assistant.server";
import { createAgentSessions } from "../../server/db/repositories/agent-session.repositories.server";
import { getAgentDisplay } from "../../server/agents/agent-display.server";
import { AgentEnvironment } from "../../server/agents/agent-environment.server";
import {
  issueAgentActivitySubscriptionToken,
  issueAgentStatusSubscriptionToken,
} from "../../server/auth/browser-realtime-token.server";

type Database = ReturnType<typeof requireDatabaseClient>;

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
      getAgentControlSignal(),
    ),
  );
}

function manageAgents(db: Database) {
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
        const providers = new Set<typeof config.provider>();
        if (await runtimeVisibility.canSelect({ workspaceId, userId }, computerId, config.provider))
          providers.add(config.provider);
        if (
          config.provider === RUNTIME_PROVIDER.COFORGE &&
          (await runtimeVisibility.canSelect(
            { workspaceId, userId },
            computerId,
            RUNTIME_PROVIDER.PI,
          ))
        )
          providers.add(RUNTIME_PROVIDER.PI);
        const models = connection?.computer.modelCatalogs.flatMap((catalog) =>
          Array.isArray(catalog.models) ? catalog.models : [],
        );
        return agentRuntimeSelectionIsAvailable(config, {
          connected: Boolean(connection),
          providers,
          models: models ?? [],
        });
      },
    },
    runtimeLock,
    () => runtimeCredentials(db, true),
  );
  return agentManagement;
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

export const listAgents = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context: { user, db, workspaceId } }) => {
    const agents = await manageAgents(db).list({ userId: user.id, workspaceId });
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

export const getAgentStatusSubscriptionToken = createServerFn({
  method: "GET",
})
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context }) => {
    const { user, workspaceId } = context;
    return issueAgentStatusSubscriptionToken({ userId: user.id, workspaceId });
  });

export const getAgentActivitySubscriptionToken = createServerFn({
  method: "GET",
})
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context }) => {
    const { user, workspaceId } = context;
    return issueAgentActivitySubscriptionToken({ userId: user.id, workspaceId });
  });

export const createAgent = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(createAgentInputSchema)
  .handler(async ({ data, context }) => {
    const user = context.user;
    const db = requireDatabaseClient();
    const workspaceId = await workspaceIdForUser(
      db,
      user,
      getRequest().headers.get("accept-language") ?? "",
    );
    const role = await workspaceMemberRole(db, workspaceId, user.id);
    // An `agent:create` action card (ADR 0027 "Commit and cancel"): guard it is still committable
    // *before* creating the Agent, then mark it `executed` *after* — `ManageAgents.create` below
    // enforces `assertCanCreateAgents` itself, so a plain member fails there and the card stays
    // `pending`; see `ActionCards`'s ordering comment in `action-cards.server.ts`.
    const centrifugo = createCentrifugoServerApi();
    const actionCards = new ActionCards(
      db,
      undefined,
      new CentrifugoConversationRealtime(centrifugo),
    );
    if (data.actionCardMessageId)
      await actionCards.assertAgentCreateCommittable(
        workspaceId,
        user.id,
        data.actionCardMessageId,
        data.computerId,
      );
    const created = await manageAgents(db).create({ userId: user.id, workspaceId, role }, data);
    if (data.actionCardMessageId)
      await actionCards.completeAgentCreate(
        workspaceId,
        user.id,
        data.actionCardMessageId,
        created.agent.id,
      );
    return created;
  });

export const updateAgent = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(updateAgentInputSchema)
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    const assistant = await db.weeklyReportAssistant.findFirst({
      where: { agentId: data.agentId, workspaceId, userId: user.id },
      select: { agentId: true },
    });
    return manageAgents(db).update(
      { userId: user.id, workspaceId },
      assistant ? { ...data, name: weeklyReportAssistantAgentName(user.id) } : data,
    );
  });

/** Lets a Workspace owner/admin grant or revoke an Agent's own management (channel admin)
 * authority; never assigns `"owner"` (see `setAgentRole`). */
export const updateAgentRole = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(updateAgentRoleInputSchema)
  .handler(async ({ data, context: { user, db, workspaceId } }) =>
    setAgentRole(db, {
      workspaceId,
      actorUserId: user.id,
      agentId: data.agentId,
      role: data.role,
    }),
  );

export const getAgentDetail = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(agentIdSchema)
  .handler(async ({ data: agentId, context }) => {
    const { user, db, workspaceId } = context;
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
                role: true,
                createdAt: true,
                computerId: true,
                runtimeConfig: true,
                weeklyReportAssistant: { select: { id: true } },
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
      ? await runtimeCredentials(db).summary({ workspaceId, userId: user.id }, agentId)
      : null;
    const viewerMembership = await db.workspaceMembership.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: user.id } },
      select: { role: true },
    });
    const canManageAgentRole = viewerMembership
      ? isAdminLike(viewerMembership.role as WorkspaceMemberRole)
      : false;
    return {
      ...result,
      runtimeConfig: publicAgentRuntimeConfig(parseAgentRuntimeConfig(result.runtimeConfig)),
      ownedByCurrentUser,
      runtimeCredential,
      canManageAgentRole,
    };
  });

export const saveAgentRuntimeCredential = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(saveAgentRuntimeCredentialInputSchema)
  .handler(async ({ data, context }) => {
    const { user, db, workspaceId } = context;
    return changeRuntimeCredential(db, true).save(
      { workspaceId, userId: user.id },
      data.agentId,
      data.apiKey,
    );
  });

export const deleteAgentRuntimeCredential = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(agentIdSchema)
  .handler(async ({ data: agentId, context }) => {
    const { user, db, workspaceId } = context;
    return changeRuntimeCredential(db).delete({ workspaceId, userId: user.id }, agentId);
  });

export const getAgentEnvironment = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(agentIdSchema)
  .handler(async ({ data: agentId, context }) => {
    const { user, db, workspaceId } = context;
    setResponseHeader("cache-control", "no-store");
    return agentEnvironment(db).get({ workspaceId, userId: user.id }, agentId);
  });

export const saveAgentEnvironment = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(saveAgentEnvironmentInputSchema)
  .handler(async ({ data, context }) => {
    const { user, db, workspaceId } = context;
    return agentEnvironment(db).save({ workspaceId, userId: user.id }, data.agentId, data.envVars);
  });
