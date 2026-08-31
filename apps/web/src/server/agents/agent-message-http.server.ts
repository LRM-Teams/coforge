import { AGENT_MESSAGE_READ_METHOD, AGENT_MESSAGE_SEND_METHOD } from "@coforge/protocol";

import {
  authenticateAgentApiKey,
  isAgentApiKeyBoundToComputer,
  type AgentApiKeyRepository,
} from "./agent-api-key.server";
import { verifyDaemonToken } from "../auth/daemon-token.server";
import { getDatabaseClient } from "../db/client.server";
import { PrismaAgentApiKeyRepository } from "../db/repositories/agent-api-key.repositories.server";
import {
  PrismaAgentRepository,
  RepositoryAgentAuthorization,
} from "../db/repositories/agent.repositories.server";
import { PrismaDirectConversationRepository } from "../db/repositories/direct-conversation.repositories.server";
import { createCentrifugoServerApi } from "../centrifugo/server-api.server";
import {
  CentrifugoRpcAuthenticationError,
  CentrifugoRpcHandler,
  createAgentMessageMethod,
} from "../centrifugo/rpc-handler.server";

type DaemonPrincipal = { userId: string; workspaceId: string; computerId: string };

export async function authenticateAgentMessageRequest(
  request: Request,
  dependencies: {
    agentApiKeys: AgentApiKeyRepository;
    verifyDaemonToken(token: string): Promise<DaemonPrincipal>;
    computerBelongsToWorkspace(workspaceId: string, computerId: string): Promise<boolean>;
  },
) {
  try {
    const agentAuthorization = request.headers.get("authorization");
    const daemonAuthorization = request.headers.get("x-coforge-daemon-authorization");
    if (!agentAuthorization?.startsWith("Bearer ") || !daemonAuthorization?.startsWith("Bearer "))
      throw new Error("credentials missing");
    const record = await authenticateAgentApiKey(
      agentAuthorization.slice(7).trim(),
      dependencies.agentApiKeys,
    );
    const daemon = await dependencies.verifyDaemonToken(daemonAuthorization.slice(7).trim());
    if (
      !isAgentApiKeyBoundToComputer(record, daemon) ||
      !(await dependencies.computerBelongsToWorkspace(daemon.workspaceId, daemon.computerId))
    )
      throw new Error("credential scope mismatch");
    return {
      userId: record.ownerId,
      workspaceId: record.workspaceId,
      computerId: daemon.computerId,
      agentId: record.agentId,
    };
  } catch {
    throw new CentrifugoRpcAuthenticationError();
  }
}

/** Compose the dedicated Daemon Agent-message HTTPS boundary. */
export function createAgentMessageHttpHandler() {
  const db = getDatabaseClient();
  if (!db) return new CentrifugoRpcHandler({ methods: {} });
  const conversations = new PrismaDirectConversationRepository(db);
  const authorization = new RepositoryAgentAuthorization(new PrismaAgentRepository(db));
  const centrifugo = createCentrifugoServerApi();
  const agentApiKeys = new PrismaAgentApiKeyRepository(db);
  return new CentrifugoRpcHandler({
    methods: {
      [AGENT_MESSAGE_READ_METHOD]: createAgentMessageMethod(
        conversations,
        centrifugo,
        "read",
        authorization,
      ),
      [AGENT_MESSAGE_SEND_METHOD]: createAgentMessageMethod(
        conversations,
        centrifugo,
        "send",
        authorization,
      ),
    },
    authenticateEnvelope: (_envelope, request) =>
      authenticateAgentMessageRequest(request, {
        agentApiKeys,
        verifyDaemonToken: (token) => verifyDaemonToken(token),
        computerBelongsToWorkspace: async (workspaceId, computerId) =>
          Boolean(
            await db.workspaceComputer.findUnique({
              where: { workspaceId_computerId: { workspaceId, computerId } },
              select: { id: true },
            }),
          ),
      }),
  });
}

export async function authenticateAgentHttpRequest(request: Request) {
  const db = getDatabaseClient();
  if (!db) throw new CentrifugoRpcAuthenticationError();
  return authenticateAgentMessageRequest(request, {
    agentApiKeys: new PrismaAgentApiKeyRepository(db),
    verifyDaemonToken: (token) => verifyDaemonToken(token),
    computerBelongsToWorkspace: async (workspaceId, computerId) =>
      Boolean(
        await db.workspaceComputer.findUnique({
          where: { workspaceId_computerId: { workspaceId, computerId } },
          select: { id: true },
        }),
      ),
  });
}
