import { encodeReminderSync } from "@lrm/coforge-sdk/internal";

import {
  authenticateAgentApiKey,
  isAgentApiKeyBoundToComputer,
  type AgentApiKeyRepository,
} from "./agent-api-key.server";
import { verifyDaemonApiKey } from "../auth/daemon-api-key.server";
import { getDatabaseClient } from "../db/client.server";
import { PrismaAgentApiKeyRepository } from "../db/repositories/agent-api-key.repositories.server";
import { PrismaDaemonApiKeyRepository } from "../db/repositories/daemon-api-key.repositories.server";
import { createCentrifugoServerApi } from "../centrifugo/server-api.server";
import { CentrifugoRpcAuthenticationError } from "../centrifugo/rpc-handler.server";
import { PrismaReminderRepository } from "../db/repositories/reminder.repositories.server";
import { Reminders } from "../reminders/reminders.server";
import { getReminderCapabilityLease } from "../reminders/reminder-capability.server";
import { daemonControlChannel } from "../centrifugo/server-api.server";

type DaemonPrincipal = {
  userId: string;
  workspaceId: string;
  computerId: string;
};

export async function authenticateAgentMessageRequest(
  request: Request,
  dependencies: {
    agentApiKeys: AgentApiKeyRepository;
    verifyDaemonApiKey(token: string): Promise<DaemonPrincipal>;
    computerBelongsToWorkspace(workspaceId: string, computerId: string): Promise<boolean>;
  },
) {
  try {
    const daemonAuthorization = request.headers.get("authorization");
    const agentAuthorization = request.headers.get("x-coforge-agent-api-key");
    if (!agentAuthorization?.startsWith("Bearer ") || !daemonAuthorization?.startsWith("Bearer "))
      throw new Error("credentials missing");
    const record = await authenticateAgentApiKey(
      agentAuthorization.slice(7).trim(),
      dependencies.agentApiKeys,
    );
    const daemon = await dependencies.verifyDaemonApiKey(daemonAuthorization.slice(7).trim());
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

export function createAgentReminderService(
  db: NonNullable<ReturnType<typeof getDatabaseClient>>,
  centrifugo = createCentrifugoServerApi(),
) {
  return new Reminders(new PrismaReminderRepository(db), getReminderCapabilityLease(), (sync) =>
    centrifugo.publish(
      daemonControlChannel(sync.workspaceId, sync.computerId),
      encodeReminderSync(sync),
    ),
  );
}

export async function authenticateAgentHttpRequest(request: Request) {
  const db = getDatabaseClient();
  if (!db) throw new CentrifugoRpcAuthenticationError();
  return authenticateAgentMessageRequest(request, {
    agentApiKeys: new PrismaAgentApiKeyRepository(db),
    verifyDaemonApiKey: (token) => verifyDaemonApiKey(token, new PrismaDaemonApiKeyRepository(db)),
    computerBelongsToWorkspace: async (workspaceId, computerId) =>
      Boolean(
        await db.workspaceComputer.findUnique({
          where: { workspaceId_computerId: { workspaceId, computerId } },
          select: { id: true },
        }),
      ),
  });
}
