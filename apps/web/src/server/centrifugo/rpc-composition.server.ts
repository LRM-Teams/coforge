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
import { PrismaWorkspaceAccess } from "../db/repositories/setup.repositories.server";
import {
  createComputerRegistrationMethod,
  createWorkspaceGetMethod,
  createWorkspaceListMethod,
  createWorkspaceWorkerReadyMethod,
} from "./rpc-handler.server";
import { WORKSPACE_WORKER_READY_METHOD } from "@coforge/protocol";
import { WorkspaceQueryUseCase } from "../workspaces/query.server";
import { ComputerRegistrar } from "../computers/registration.server";
import { PrismaComputerConnectionRepository } from "../db/repositories/setup.repositories.server";
import {
  PrismaAgentRepository,
  RepositoryAgentAuthorization,
} from "../db/repositories/agent.repositories.server";
import { createWorkspaceWorkerTokenIssuer } from "../auth/workspace-worker-token.server";
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
import { verifyWorkspaceWorkerToken } from "../auth/workspace-worker-token.server";
import {
  authenticateAgentApiKey,
  isAgentApiKeyBoundToComputer,
} from "../agents/agent-api-key.server";
import { PrismaAgentApiKeyRepository } from "../db/repositories/agent-api-key.repositories.server";

const unavailable: CentrifugoRpcError = {
  code: 503,
  message: "protocol method dependencies are unavailable",
};

const unavailableMethod: CentrifugoRpcMethod = () => unavailable;

async function requireAuthenticatedCentrifugoUser(request: { user?: string }, context: Request) {
  const header = context.headers.get("authorization");
  if (header?.startsWith("Bearer ")) {
    try {
      return await verifyWorkspaceWorkerToken(header.slice("Bearer ".length).trim());
    } catch {
      const db = getDatabaseClient();
      if (db) {
        try {
          const record = await authenticateAgentApiKey(
            header.slice("Bearer ".length).trim(),
            new PrismaAgentApiKeyRepository(db),
          );
          const daemonHeader = context.headers.get("x-coforge-daemon-authorization");
          if (!daemonHeader?.startsWith("Bearer ")) throw new Error("daemon credential missing");
          const daemon = await verifyWorkspaceWorkerToken(
            daemonHeader.slice("Bearer ".length).trim(),
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

/** Compose the server-owned Centrifugo boundary without inventing persistence. */
export function createCentrifugoRpcHandler() {
  const db = getDatabaseClient();
  if (db) {
    const access = new PrismaWorkspaceAccess(db);
    const query = new WorkspaceQueryUseCase(access);
    const registration = new ComputerRegistrar({
      workspaceAccess: access,
      computers: new PrismaComputerConnectionRepository(db),
      tokenIssuer: createWorkspaceWorkerTokenIssuer(),
    });
    const agentRepository = new PrismaAgentRepository(db);
    const agentAuthorization = new RepositoryAgentAuthorization(agentRepository);
    const centrifugo = createCentrifugoServerApi();
    return new CentrifugoRpcHandler({
      methods: {
        [COMPUTER_REGISTER_METHOD]: createComputerRegistrationMethod(registration),
        [WORKSPACE_LIST_METHOD]: createWorkspaceListMethod(query),
        [WORKSPACE_GET_METHOD]: createWorkspaceGetMethod(query),
        [WORKSPACE_WORKER_READY_METHOD]: createWorkspaceWorkerReadyMethod(
          new WorkspaceAgentRecovery(agentRepository, centrifugo),
        ),
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
      authenticateEnvelope: requireAuthenticatedCentrifugoUser,
      authorizeProxyRequest: authorizeCentrifugoProxy,
    });
  }
  return new CentrifugoRpcHandler({
    methods: {
      [COMPUTER_REGISTER_METHOD]: unavailableMethod,
      [WORKSPACE_LIST_METHOD]: unavailableMethod,
      [WORKSPACE_GET_METHOD]: unavailableMethod,
      [WORKSPACE_WORKER_READY_METHOD]: createWorkspaceWorkerReadyMethod(),
      [AGENT_START_METHOD]: unavailableMethod,
      [AGENT_MESSAGE_ACK_METHOD]: unavailableMethod,
      [AGENT_MESSAGE_READ_METHOD]: unavailableMethod,
      [AGENT_MESSAGE_SEND_METHOD]: unavailableMethod,
    },
    authenticateEnvelope: requireAuthenticatedCentrifugoUser,
    authorizeProxyRequest: authorizeCentrifugoProxy,
  });
}
