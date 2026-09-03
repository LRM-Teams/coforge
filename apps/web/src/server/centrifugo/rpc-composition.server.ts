import {
  COMPUTER_REGISTER_METHOD,
  WORKSPACE_GET_METHOD,
  WORKSPACE_LIST_METHOD,
} from "@coforge/protocol";

import {
  CentrifugoRpcHandler,
  CentrifugoRpcAuthenticationError,
  type CentrifugoRpcError,
  type CentrifugoRpcMethod,
} from "./rpc-handler.server";
import { getDatabaseClient } from "../db/client.server";
import type { PrismaClient } from "../../../generated/client";
import { PrismaWorkspaceAccess } from "../db/repositories/setup.repositories.server";
import {
  createComputerRegistrationMethod,
  createDaemonRuntimeCodeAgentsUpdateMethod,
  createWorkspaceGetMethod,
  createWorkspaceListMethod,
  createDaemonRuntimeReadyMethod,
  createDaemonRuntimeUsageScanResultMethod,
  createDaemonConnectionStatusMethod,
} from "./rpc-handler.server";
import {
  DAEMON_RUNTIME_CODE_AGENTS_UPDATE_METHOD,
  DAEMON_RUNTIME_READY_METHOD,
  DAEMON_RUNTIME_USAGE_SCAN_RESULT_METHOD,
  DAEMON_CONNECTION_STATUS_METHOD,
} from "@coforge/protocol";
import { WorkspaceQueryUseCase } from "../workspaces/query.server";
import { ComputerRegistrar } from "../computers/registration.server";
import { PrismaComputerConnectionRepository } from "../db/repositories/setup.repositories.server";
import {
  PrismaAgentRepository,
  RepositoryAgentAuthorization,
} from "../db/repositories/agent.repositories.server";
import { createDaemonApiKeyFactory } from "../auth/daemon-api-key.server";
import {
  createAgentStartMethod,
  createAgentDeliveryAckMethod,
  createAgentMessageMethod,
} from "./rpc-handler.server";
import { CloudAgentUseCase, WorkspaceAgentRecovery } from "../agents/cloud-agent.server";
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
      computers: new PrismaComputerConnectionRepository(db),
      daemonApiKeyFactory: createDaemonApiKeyFactory(new PrismaDaemonApiKeyRepository(db)),
    });
    const agentRepository = new PrismaAgentRepository(db);
    const agentAuthorization = new RepositoryAgentAuthorization(agentRepository);
    const centrifugo = createCentrifugoServerApi();
    return new CentrifugoRpcHandler({
      methods: {
        [COMPUTER_REGISTER_METHOD]: createComputerRegistrationMethod(registration),
        [WORKSPACE_LIST_METHOD]: createWorkspaceListMethod(query),
        [WORKSPACE_GET_METHOD]: createWorkspaceGetMethod(query),
        [DAEMON_RUNTIME_READY_METHOD]: createDaemonRuntimeReadyMethod(
          new WorkspaceAgentRecovery(agentRepository, centrifugo),
        ),
        [DAEMON_CONNECTION_STATUS_METHOD]: createDaemonConnectionStatusMethod(),
        [DAEMON_RUNTIME_CODE_AGENTS_UPDATE_METHOD]: createDaemonRuntimeCodeAgentsUpdateMethod(
          new PrismaComputerRuntimeRepository(db),
        ),
        [DAEMON_RUNTIME_USAGE_SCAN_RESULT_METHOD]: createDaemonRuntimeUsageScanResultMethod(),
        [AGENT_START_METHOD]: createAgentStartMethod(
          new CloudAgentUseCase(agentAuthorization, centrifugo, async () => {}),
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
      [AGENT_START_METHOD]: unavailableMethod,
      [AGENT_MESSAGE_ACK_METHOD]: unavailableMethod,
      [AGENT_MESSAGE_READ_METHOD]: unavailableMethod,
      [AGENT_MESSAGE_SEND_METHOD]: unavailableMethod,
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
