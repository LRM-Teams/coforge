import { encodeReminderSync } from "@lrm/coforge-sdk/internal";

import {
  authenticateAgentApiKey,
  isAgentApiKeyBoundToComputer,
  type AgentApiKeyRepository,
} from "./agent-api-key.server";
import { verifyDaemonApiKey } from "#src/server/auth/daemon-api-key.server";
import type { PrismaClient } from "#src/generated/prisma/client";
import { getDatabaseClient } from "#src/server/db/client.server";
import { PrismaAgentApiKeyRepository } from "#src/server/db/repositories/agent-api-key.repositories.server";
import { PrismaDaemonApiKeyRepository } from "#src/server/db/repositories/daemon-api-key.repositories.server";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { CentrifugoRpcAuthenticationError } from "#src/server/centrifugo/rpc-handler.server";
import { ACTIVE_AGENT_WHERE } from "./active-agent.server";
import { PrismaReminderRepository } from "#src/server/db/repositories/reminder.repositories.server";
import { Reminders } from "#src/server/reminders/reminders.server";
import { getReminderCapabilityLease } from "#src/server/reminders/reminder-capability.server";
import { daemonControlChannel } from "#src/server/centrifugo/server-api.server";

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

export async function authenticateAgentHttpRequest(request: Request, db: PrismaClient) {
  const principal = await authenticateAgentMessageRequest(request, {
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
  // Deleting an Agent revokes its keys, but a key minted before the delete could still
  // be in flight; check the Agent itself so a deleted Agent can never act through the HTTP API.
  const agent = await db.agent.findFirst({
    where: {
      id: principal.agentId,
      workspaceId: principal.workspaceId,
      ...ACTIVE_AGENT_WHERE,
    },
    select: { id: true },
  });
  if (!agent) throw new CentrifugoRpcAuthenticationError();
  return principal;
}
