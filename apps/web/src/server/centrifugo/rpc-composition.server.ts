import {
  AGENT_SESSION_METHOD,
  COMPUTER_REGISTER_METHOD,
  WORKSPACE_GET_METHOD,
  WORKSPACE_LIST_METHOD,
  AGENT_SKILLS_LIST_RESULT_METHOD,
  AGENT_CONTROL_RESULT_METHOD,
  REMINDER_FIRE_METHOD,
  REMINDER_SNAPSHOT_METHOD,
} from "@coforge/protocol";
import { createAgentSkillsListResultMethod } from "./agent-skills-cache.server";

import {
  CentrifugoRpcHandler,
  CentrifugoRpcAuthenticationError,
  type CentrifugoRpcError,
  type CentrifugoRpcMethod,
} from "./rpc-handler.server";
import { getDatabaseClient } from "../db/client.server";
import type { PrismaClient } from "../../../generated/client";
import {
  PrismaComputerRegistrationRepository,
  PrismaWorkspaceAccess,
} from "../db/repositories/setup.repositories.server";
import {
  createAgentSessionMethod,
  createComputerRegistrationMethod,
  createDaemonRuntimeCodeAgentsUpdateMethod,
  createWorkspaceGetMethod,
  createWorkspaceListMethod,
  createDaemonRuntimeReadyMethod,
  createDaemonRuntimeUsageScanResultMethod,
  createDaemonConnectionStatusMethod,
  createAgentStatusMethod,
  createReminderFireMethod,
  createReminderSnapshotMethod,
} from "./rpc-handler.server";
import {
  DAEMON_RUNTIME_CODE_AGENTS_UPDATE_METHOD,
  DAEMON_RUNTIME_READY_METHOD,
  DAEMON_RUNTIME_USAGE_SCAN_RESULT_METHOD,
  DAEMON_CONNECTION_STATUS_METHOD,
  AGENT_STATUS_METHOD,
} from "@coforge/protocol";
import { WorkspaceQueryUseCase } from "../workspaces/query.server";
import { ComputerRegistrar } from "../computers/registration.server";
import { getComputerRestartStore } from "../computers/computer-restart-store.server";
import { recordComputerObservation } from "../computers/computer-metadata.server";
import {
  PrismaAgentRepository,
  RepositoryAgentAuthorization,
} from "../db/repositories/agent.repositories.server";
import {
  createAgentStartMethod,
  createAgentDeliveryAckMethod,
  createAgentMessageMethod,
} from "./rpc-handler.server";
import {
  PublishAgentRuntimeControl,
  WorkspaceAgentRecovery,
} from "../agents/agent-runtime-control.server";
import { getAgentRuntimeLock } from "../agents/agent-runtime-lock.server";
import { AgentControl } from "../agents/agent-control.server";
import { PrismaAgentControlStore } from "../db/repositories/agent-control.repositories.server";
import { createCentrifugoServerApi } from "./server-api.server";
import {
  AGENT_START_METHOD,
  AGENT_MESSAGE_ACK_METHOD,
  AGENT_MESSAGE_READ_METHOD,
  AGENT_MESSAGE_SEND_METHOD,
} from "@coforge/protocol";
import { PrismaDirectConversationRepository } from "../db/repositories/direct-conversation.repositories.server";
import { verifyDaemonApiKey } from "../auth/daemon-api-key.server";
import {
  authenticateAgentApiKey,
  isAgentApiKeyBoundToComputer,
} from "../agents/agent-api-key.server";
import { PrismaAgentApiKeyRepository } from "../db/repositories/agent-api-key.repositories.server";
import { PrismaComputerRuntimeRepository } from "../db/repositories/computer-runtime.repositories.server";
import { PrismaDaemonApiKeyRepository } from "../db/repositories/daemon-api-key.repositories.server";
import { bestEffortMessageNotifier } from "../notifications/web-push-composition.server";
import { createAgentSessions } from "../db/repositories/agent-session.repositories.server";
import { AgentSessionReceiver } from "../agents/agent-session.server";
import { createAgentControlResultMethod } from "./agent-control-receiver.server";
import { PrismaReminderRepository } from "../db/repositories/reminder.repositories.server";
import { Reminders } from "../reminders/reminders.server";
import { getReminderCapabilityLease } from "../reminders/reminder-capability.server";
import { daemonControlChannel } from "./server-api.server";
import { encodeReminderSync } from "@coforge/protocol";
import { getAgentDisplay } from "../agents/agent-display.server";

const unavailable: CentrifugoRpcError = {
  code: 503,
  message: "protocol method dependencies are unavailable",
};

const unavailableMethod: CentrifugoRpcMethod = () => unavailable;

async function requireAuthenticatedCentrifugoUser(
  request: { user?: string; meta?: Record<string, unknown> },
  context: Request,
  daemonApiKeys: import("../auth/daemon-api-key.server").DaemonApiKeyRepository,
) {
  const daemonHeader = context.headers.get("authorization");
  if (daemonHeader?.startsWith("Bearer ")) {
    try {
      return await verifyDaemonApiKey(daemonHeader.slice("Bearer ".length).trim(), daemonApiKeys);
    } catch {
      const db = getDatabaseClient();
      if (db) {
        try {
          const agentHeader = context.headers.get("x-coforge-agent-api-key");
          if (!agentHeader?.startsWith("Bearer ")) throw new Error("Agent API key missing");
          const record = await authenticateAgentApiKey(
            agentHeader.slice("Bearer ".length).trim(),
            new PrismaAgentApiKeyRepository(db),
          );
          const daemon = await verifyDaemonApiKey(
            daemonHeader.slice("Bearer ".length).trim(),
            daemonApiKeys,
          );
          if (
            !isAgentApiKeyBoundToComputer(record, daemon) ||
            !(await db.workspaceComputer.findUnique({
              where: {
                workspaceId_computerId: {
                  workspaceId: daemon.workspaceId,
                  computerId: daemon.computerId,
                },
              },
              select: { id: true },
            }))
          )
            throw new Error("daemon credential scope mismatch");
          return {
            userId: record.ownerId,
            workspaceId: record.workspaceId,
            computerId: daemon.computerId,
            agentId: record.agentId,
          };
        } catch {
          // Keep malformed and revoked credentials indistinguishable.
        }
      }
      throw new CentrifugoRpcAuthenticationError();
    }
  }
  const workspaceId = request.meta?.workspace_id;
  const computerId = request.meta?.computer_id;
  if (
    request.user &&
    typeof workspaceId === "string" &&
    typeof computerId === "string" &&
    workspaceId &&
    computerId
  )
    return { userId: request.user, workspaceId, computerId };
  // User-facing calls use Centrifugo's verified user subject. Daemon-scoped
  // methods still fail closed because their required claims are empty.
  if (!request.user) throw new CentrifugoRpcAuthenticationError();
  return { userId: request.user, workspaceId: "", computerId: "" };
}

function authorizeCentrifugoProxy(request: Request): void {
  const secret = process.env.COFORGE_CENTRIFUGO_PROXY_SECRET;
  if (!secret || request.headers.get("x-coforge-centrifugo-proxy-secret") !== secret)
    throw new Error("proxy authorization failed");
}

/**
 * Compose the server-owned Centrifugo boundary without inventing persistence.
 *
 * `db` is a parameter so tests can compose the unwired handler by passing
 * `null`, rather than depending on DATABASE_URL being absent from the
 * environment.
 */
export function createCentrifugoRpcHandler(db: PrismaClient | null = getDatabaseClient() ?? null) {
  if (db) {
    const access = new PrismaWorkspaceAccess(db);
    const query = new WorkspaceQueryUseCase(access);
    const registration = new ComputerRegistrar({
      workspaceAccess: access,
      registrations: new PrismaComputerRegistrationRepository(db),
    });
    const agentRepository = new PrismaAgentRepository(db);
    const agentAuthorization = new RepositoryAgentAuthorization(agentRepository);
    const centrifugo = createCentrifugoServerApi();
    const sessions = createAgentSessions(db);
    const controlStore = new PrismaAgentControlStore(db);
    const control = new AgentControl(
      controlStore,
      centrifugo,
      getAgentRuntimeLock(),
      undefined,
      sessions,
    );
    const sessionReceiver = new AgentSessionReceiver(controlStore);
    const reminderRepository = new PrismaReminderRepository(db);
    const reminderLease = getReminderCapabilityLease();
    const reminders = new Reminders(reminderRepository, reminderLease, (sync) =>
      centrifugo.publish(
        daemonControlChannel(sync.workspaceId, sync.computerId),
        encodeReminderSync(sync),
      ),
    );
    return new CentrifugoRpcHandler({
      methods: {
        [AGENT_SESSION_METHOD]: createAgentSessionMethod(sessions, sessionReceiver),
        [COMPUTER_REGISTER_METHOD]: createComputerRegistrationMethod(registration),
        [WORKSPACE_LIST_METHOD]: createWorkspaceListMethod(query),
        [WORKSPACE_GET_METHOD]: createWorkspaceGetMethod(query),
        [DAEMON_RUNTIME_READY_METHOD]: createDaemonRuntimeReadyMethod(
          new WorkspaceAgentRecovery(
            agentRepository,
            new PrismaDirectConversationRepository(db),
            centrifugo,
            getAgentRuntimeLock(),
            sessions,
            control,
          ),
          getComputerRestartStore(),
          reminderLease,
          {
            snapshotAssigned: async (workspaceId, computerId) => {
              const agents = await db.agent.findMany({
                where: { workspaceId, computerId },
                select: { id: true, ownerId: true },
              });
              for (const agent of agents) {
                const bytes = await reminders.snapshot({
                  protocolMajor: 1,
                  requestId: crypto.randomUUID(),
                  workspaceId,
                  computerId,
                  agentId: agent.id,
                  userId: agent.ownerId,
                });
                await centrifugo.publish(daemonControlChannel(workspaceId, computerId), bytes);
              }
            },
          },
          (scope, observation) => recordComputerObservation(db, scope, observation),
        ),
        [REMINDER_FIRE_METHOD]: createReminderFireMethod(reminders),
        [REMINDER_SNAPSHOT_METHOD]: createReminderSnapshotMethod(reminders),
        [DAEMON_CONNECTION_STATUS_METHOD]: createDaemonConnectionStatusMethod(
          undefined,
          reminderLease,
        ),
        [DAEMON_RUNTIME_CODE_AGENTS_UPDATE_METHOD]: createDaemonRuntimeCodeAgentsUpdateMethod(
          new PrismaComputerRuntimeRepository(db),
        ),
        [DAEMON_RUNTIME_USAGE_SCAN_RESULT_METHOD]: createDaemonRuntimeUsageScanResultMethod(),
        [AGENT_SKILLS_LIST_RESULT_METHOD]: createAgentSkillsListResultMethod(),
        [AGENT_CONTROL_RESULT_METHOD]: createAgentControlResultMethod(control),
        [AGENT_START_METHOD]: createAgentStartMethod(
          new PublishAgentRuntimeControl(
            agentAuthorization,
            centrifugo,
            async () => {},
            sessions,
            control,
          ),
        ),
        [AGENT_STATUS_METHOD]: createAgentStatusMethod(
          agentRepository,
          undefined,
          centrifugo,
          Date.now,
          getAgentDisplay(),
          centrifugo,
        ),
        [AGENT_MESSAGE_ACK_METHOD]: createAgentDeliveryAckMethod(
          new PrismaDirectConversationRepository(db),
        ),
        [AGENT_MESSAGE_READ_METHOD]: createAgentMessageMethod(
          new PrismaDirectConversationRepository(db),
          centrifugo,
          "read",
          agentAuthorization,
        ),
        [AGENT_MESSAGE_SEND_METHOD]: createAgentMessageMethod(
          new PrismaDirectConversationRepository(db),
          centrifugo,
          "send",
          agentAuthorization,
          undefined,
          undefined,
          bestEffortMessageNotifier(db),
        ),
      },
      authenticateEnvelope: (request, context) =>
        requireAuthenticatedCentrifugoUser(request, context, new PrismaDaemonApiKeyRepository(db)),
      authorizeProxyRequest: authorizeCentrifugoProxy,
    });
  }
  return new CentrifugoRpcHandler({
    methods: {
      [COMPUTER_REGISTER_METHOD]: unavailableMethod,
      [WORKSPACE_LIST_METHOD]: unavailableMethod,
      [WORKSPACE_GET_METHOD]: unavailableMethod,
      [DAEMON_RUNTIME_READY_METHOD]: createDaemonRuntimeReadyMethod(),
      [DAEMON_CONNECTION_STATUS_METHOD]: createDaemonConnectionStatusMethod(),
      [DAEMON_RUNTIME_CODE_AGENTS_UPDATE_METHOD]: unavailableMethod,
      [DAEMON_RUNTIME_USAGE_SCAN_RESULT_METHOD]: createDaemonRuntimeUsageScanResultMethod(),
      [AGENT_SKILLS_LIST_RESULT_METHOD]: unavailableMethod,
      [AGENT_CONTROL_RESULT_METHOD]: unavailableMethod,
      [AGENT_SESSION_METHOD]: unavailableMethod,
      [AGENT_START_METHOD]: unavailableMethod,
      [AGENT_STATUS_METHOD]: unavailableMethod,
      [AGENT_MESSAGE_ACK_METHOD]: unavailableMethod,
      [AGENT_MESSAGE_READ_METHOD]: unavailableMethod,
      [AGENT_MESSAGE_SEND_METHOD]: unavailableMethod,
      [REMINDER_FIRE_METHOD]: unavailableMethod,
      [REMINDER_SNAPSHOT_METHOD]: unavailableMethod,
    },
    authenticateEnvelope: (request, context) =>
      requireAuthenticatedCentrifugoUser(request, context, {
        replaceActive: async () => {},
        findByHash: async () => undefined,
        markUsed: async () => {},
      }),
    authorizeProxyRequest: authorizeCentrifugoProxy,
  });
}
