import { createServerFn } from "@tanstack/react-start";
import { getRequest, setResponseHeader } from "@tanstack/react-start/server";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import {
  agentIdInputSchema,
  agentIdSchema,
  createAgentInputSchema,
  deleteAgentInputSchema,
  saveAgentRuntimeCredentialInputSchema,
  saveAgentEnvironmentInputSchema,
  updateAgentInputSchema,
  updateAgentRoleInputSchema,
} from "./agent.schemas";
import { setAgentRole } from "../../server/agents/agent-role.server";
import { AppError } from "../../lib/app-error";
import { ACTIVE_AGENT_WHERE } from "../../server/agents/active-agent.server";
import { isAdminLike, type WorkspaceMemberRole } from "../../server/workspaces/member-role.server";
import { requireDatabaseClient } from "../../server/db/client.server";
import {
  PrismaAgentRepository,
  RepositoryAgentAuthorization,
} from "../../server/db/repositories/agent.repositories.server";
import { ManageAgents } from "../../server/agents/manage-agents.server";
import { AgentDeletion } from "../../server/agents/agent-deletion.server";
import { PrismaAgentDeletionStore } from "../../server/db/repositories/agent-deletion.repositories.server";
import { PublishAgentRuntimeControl } from "../../server/agents/agent-runtime-control.server";
import { AgentControl } from "../../server/agents/agent-control.server";
import { getAgentControlSignal } from "../../server/agents/agent-control-signal.server";
import { PrismaAgentControlStore } from "../../server/db/repositories/agent-control.repositories.server";
import { createCentrifugoServerApi } from "../../server/centrifugo/server-api.server";
import {
  authMiddleware,
  workspaceUserMiddleware,
  type WorkspaceUserContext,
} from "../../server/auth/function-auth";
import { ActionCards } from "../../server/conversations/action-cards.server";
import { CentrifugoConversationRealtime } from "../../server/conversations/conversation-realtime.server";
import { AgentDetailQuery } from "../../server/agents/agent-detail.server";
import {
  agentVisibilityViewerForUser,
  assertAgentVisible,
  visiblePrivateAgentWhere,
  type AgentVisibilityViewer,
} from "../../server/agents/agent-visibility.server";
import { AgentActivityRepository } from "../../server/db/repositories/agent-activity.repositories.server";
import { workspaceIdForUser } from "../../server/workspaces/enrollment.server";
import { workspaceMemberRole } from "../../server/workspaces/members.server";
import { workspaceUserAvatarUrl } from "../../server/db/repositories/user-profile.repositories.server";
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
import { ensureWeeklyReportAssistant } from "../../server/records/weekly-report-assistant.server";
import {
  parseAgentRuntimeConfig,
  publicAgentRuntimeConfig,
} from "../../server/agents/agent-runtime-config.server";
import { getAgentStatusCache } from "../../server/agents/agent-status.server";
import { getComputerStatusCache } from "../../server/centrifugo/computer-status.server";
import { createAgentSessions } from "../../server/db/repositories/agent-session.repositories.server";
import { getAgentDisplay } from "../../server/agents/agent-display.server";
import { AgentEnvironment } from "../../server/agents/agent-environment.server";
import {
  issueAgentActivitySubscriptionToken,
  issueAgentActivitySubscriptionTokenForAgent,
  issueAgentStatusSubscriptionToken,
  issueAgentStatusSubscriptionTokenForAgent,
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

function agentDeletion(db: Database) {
  const agents = new PrismaAgentRepository(db);
  return new AgentDeletion(
    agents,
    new PrismaAgentDeletionStore(db),
    runtimeControl(db, agents),
    getAgentRuntimeLock(),
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
          stopped: Boolean(agent.stoppedAt),
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

/** Ensures the User's weekly-report assistant Agent exists for Members setup. */
export const ensureWeeklyReportAssistantMember = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context: { user, db, workspaceId } }) => {
    const row = await ensureWeeklyReportAssistant(db, {
      workspaceId,
      userId: user.id,
    });
    return { agentId: row.agentId };
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

/** The minimal row `assertAgentVisible` (ADR 0059) needs for the per-Agent subscription-token
 * endpoints below — never the full `AgentRecord`, and never cached. */
async function agentVisibilityRow(db: Database, agentId: string) {
  return db.agent.findUnique({
    where: { id: agentId },
    select: { workspaceId: true, ownerId: true, visibility: true },
  });
}

/**
 * ADR 0059: a per-Agent realtime subscription token is only ever issued to a viewer who can
 * currently see that Agent — an unrecognized/missing Agent and an invisible one answer the same
 * `AGENT_NOT_VISIBLE`, so neither leaks which case applies.
 */
export const getAgentActivitySubscriptionTokenForAgent = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(agentIdInputSchema)
  .handler(async ({ data, context }) => {
    const { user, workspaceId, db } = context;
    const agent = await agentVisibilityRow(db, data.agentId);
    if (!agent || agent.workspaceId !== workspaceId) throw new AppError("AGENT_NOT_VISIBLE");
    const viewer = await agentVisibilityViewerForUser(db, workspaceId, user.id);
    assertAgentVisible(viewer, agent);
    return issueAgentActivitySubscriptionTokenForAgent({
      userId: user.id,
      workspaceId,
      agentId: data.agentId,
    });
  });

/** The per-Agent status-channel sibling of `getAgentActivitySubscriptionTokenForAgent`. */
export const getAgentStatusSubscriptionTokenForAgent = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(agentIdInputSchema)
  .handler(async ({ data, context }) => {
    const { user, workspaceId, db } = context;
    const agent = await agentVisibilityRow(db, data.agentId);
    if (!agent || agent.workspaceId !== workspaceId) throw new AppError("AGENT_NOT_VISIBLE");
    const viewer = await agentVisibilityViewerForUser(db, workspaceId, user.id);
    assertAgentVisible(viewer, agent);
    return issueAgentStatusSubscriptionTokenForAgent({
      userId: user.id,
      workspaceId,
      agentId: data.agentId,
    });
  });

/**
 * ADR 0059 realtime gap: the viewer's own `listAgents` roster (their owned Agents) is narrower
 * than what they are authorized to see — an owner/admin, or a private Agent's creator viewing it
 * from outside their own roster, can still see other private Agents. This returns exactly the
 * ids the browser needs to subscribe the matching per-Agent realtime channels for, never a full
 * row (the profile panel's own authorized fetch supplies details for any id it is given).
 */
export const listVisiblePrivateAgentIds = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context: { user, workspaceId, db } }) => {
    const viewer = await agentVisibilityViewerForUser(db, workspaceId, user.id);
    const rows = await db.agent.findMany({
      where: { workspaceId, ...ACTIVE_AGENT_WHERE, ...visiblePrivateAgentWhere(viewer) },
      select: { id: true },
    });
    return rows.map((row) => row.id);
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
      // The weekly-report assistant's display label (周报助手) is server-owned; drop any
      // client-supplied value so `ManageAgents.update` falls back to the existing displayName.
      // Its username (`name`) is fixed at creation and is never part of an update.
      assistant ? { ...data, displayName: undefined } : data,
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

/**
 * Backs `getAgentProfile`, the one seam the Members page and every conversation panel share:
 * identity, permissions, live display, runtime config summary and Activity. Does not run
 * `listComputers`/`getUserPreferences` — those stay owned by the route loaders that actually need
 * a Computer picker or a User's time zone preference.
 */
async function loadAgentProfileDetail(context: WorkspaceUserContext, agentId: string) {
  const { user, db, workspaceId } = context;
  const activity = new AgentActivityRepository(db);
  // Fetched once, ahead of `AgentDetailQuery` so `findAuthorized`'s visibility gate (ADR 0059)
  // and `canManageAgentRole` below share this single membership lookup.
  const viewerMembership = await db.workspaceMembership.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: user.id } },
    select: { role: true },
  });
  const viewer: AgentVisibilityViewer = {
    kind: "user",
    userId: user.id,
    role: viewerMembership?.role,
  };
  const query = new AgentDetailQuery(
    {
      findAuthorized: async (workspaceId, id, userId) => {
        const agent = await db.agent.findFirst({
          where: {
            id,
            workspaceId,
            workspace: { members: { some: { userId } } },
            // ADR 0044: a deleted Agent has no profile to open; its history stays readable
            // through the conversation views instead.
            ...ACTIVE_AGENT_WHERE,
          },
          select: {
            id: true,
            workspaceId: true,
            name: true,
            displayName: true,
            description: true,
            role: true,
            visibility: true,
            createdAt: true,
            computerId: true,
            computer: {
              select: {
                id: true,
                name: true,
                displayName: true,
                kind: true,
                computerVersion: true,
              },
            },
            runtimeConfig: true,
            stoppedAt: true,
            weeklyReportAssistant: { select: { id: true } },
            owner: {
              select: { id: true, username: true, displayName: true, avatarObjectKey: true },
            },
          },
        });
        if (!agent) return undefined;
        // ADR 0059: an existing-but-invisible Agent answers a stable "not visible" result, never
        // its details — distinct from the plain absence above so the profile panel can render
        // the specific "not visible" copy instead of a generic "not found".
        assertAgentVisible(viewer, { visibility: agent.visibility, ownerId: agent.owner.id });
        return agent;
      },
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
  if (!result) return undefined;
  const ownedByCurrentUser = result.owner.id === user.id;
  const runtimeCredential = ownedByCurrentUser
    ? await runtimeCredentials(db).summary({ workspaceId, userId: user.id }, agentId)
    : null;
  const canManageAgentRole = viewerMembership
    ? isAdminLike(viewerMembership.role as WorkspaceMemberRole)
    : false;
  // `findAuthorized` above already required current Workspace membership, so every viewer who
  // reaches this point holds Raft's `controlAgentRuntime` capability (Restart/Reset session);
  // `resetAgentWorkspace` (Full reset) is owner/admin only, same role check as agent-role
  // management. Server-side authorization lives in AgentControl.execute(); this is UI gating.
  const canFullResetAgent = canManageAgentRole;
  // ADR 0044: Raft's `deleteAgents` is owner/admin only, the same gate as `createAgents`. The
  // weekly-report assistant is provisioned by Records on demand, so it is never a delete target
  // even for an owner/admin viewer. Server-side authorization lives in `AgentDeletion.delete()`.
  const canDeleteAgent = canManageAgentRole && !result.isWeeklyReportAssistant;
  // Best-effort: the Agent profile panel's Computer meta line ("Connected · v0.1.0-dev.35"). Redis
  // unavailability degrades to "unknown" (`undefined`), never a false "offline".
  const computerOnline = result.computer
    ? await getComputerStatusCache()
        .get({ workspaceId, computerId: result.computer.id })
        .catch(() => undefined)
    : undefined;
  const runtimeConfig = parseAgentRuntimeConfig(result.runtimeConfig);
  // Same rule `scanUsage`/`readUsage` enforce (`computers.functions.ts`): the Runtime badge only
  // offers the usage popover when a scan against this Computer's runtime would actually be
  // honoured, so the Profile tab never renders a control the server would refuse. One lookup
  // (`ownedRuntime`) answers both that gate and the CLI `version` its popover header shows.
  const ownedRuntime = result.computer
    ? await new ComputerRuntimeVisibility(new PrismaComputerRuntimeRepository(db)).ownedRuntime(
        { workspaceId, userId: user.id },
        result.computer.id,
        runtimeConfig.runtime,
      )
    : undefined;
  return {
    ...result,
    // The Creator row renders the same identity the rest of the product does (avatar image +
    // display name), so the owner's avatar URL is resolved here like every other person surface.
    owner: {
      ...result.owner,
      avatarUrl: workspaceUserAvatarUrl(
        workspaceId,
        result.owner.id,
        result.owner.avatarObjectKey ?? null,
      ),
    },
    runtimeConfig: publicAgentRuntimeConfig(runtimeConfig),
    ownedByCurrentUser,
    runtimeCredential,
    canManageAgentRole,
    canFullResetAgent,
    canDeleteAgent,
    runtimeUsageVisible: Boolean(ownedRuntime),
    runtimeVersion: ownedRuntime?.version,
    // Always the same shape (`online` present, possibly `undefined`) whether or not a Computer is
    // assigned, so callers never have to narrow a union between "has computer without online" and
    // "has computer with online".
    computer: result.computer ? { ...result.computer, online: computerOnline } : undefined,
  };
}

/** The Agent profile panel's data seam (see `features/agents/profile-panel/`): the Members
 * directory and every conversation panel share this one query. */
export const getAgentProfile = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(agentIdSchema)
  .handler(async ({ data: agentId, context }) => {
    const result = await loadAgentProfileDetail(context, agentId);
    if (!result) throw new Error("Agent not found");
    setResponseHeader("cache-control", "no-store");
    return result;
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

/**
 * Deletes an Agent (ADR 0044): Raft's `deleteAgents` capability, Workspace owner/admin only. The
 * typed name is re-checked against the Agent's current `name` here, inside the same call that
 * performs the delete, so a concurrent rename cannot bypass confirmation — the same guard
 * `ProjectSettings.delete` uses. Deleting the Agent's own runtime credential is a separate
 * concern; `AgentDeletion` revokes Agent API keys and cancels Reminders itself.
 */
export const deleteAgent = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(deleteAgentInputSchema)
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    const agent = await db.agent.findFirst({
      where: { id: data.agentId, workspaceId },
      select: { name: true },
    });
    if (!agent || agent.name !== data.confirmation) throw new AppError("INVALID_INPUT");
    const role = await workspaceMemberRole(db, workspaceId, user.id);
    const result = await agentDeletion(db).delete(
      { userId: user.id, workspaceId, role },
      data.agentId,
    );
    // A protected Agent is not a delete target at all; the dialog shows its own message for this
    // rather than the generic failure, so surface it as a distinguishable error.
    if (result.outcome === "protected")
      throw new AppError("CONFLICT", { errorId: "agent-delete-protected" });
    return result;
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
