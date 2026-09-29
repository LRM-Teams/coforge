import {
  DAEMON_CONNECT_REJECTION_CODES,
  isRecord,
  type DaemonConnectRejectionReason,
} from "@lrm/coforge-sdk/internal";
import type { PrismaClient } from "#src/generated/prisma/client";
import {
  hashDaemonApiKey,
  isDaemonApiKey,
  verifyDaemonApiKey,
  type DaemonApiKeyClaims,
  type DaemonApiKeyRepository,
} from "#src/server/auth/daemon-api-key.server";
import { PrismaDaemonApiKeyRepository } from "#src/server/db/repositories/daemon-api-key.repositories.server";
import { DaemonCredentialRevocations } from "#src/server/db/repositories/daemon-credential-revocation.repositories.server";

type ConnectRequest = {
  data?: unknown;
};

function connectData(data: unknown): Record<string, unknown> {
  if (typeof data === "string") {
    try {
      const parsed: unknown = JSON.parse(data);
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return isRecord(data) ? data : {};
}

/**
 * A 200 answer carrying a Centrifugo `disconnect` in the terminal 4500-4999 range: the Daemon's
 * client does not reconnect, and the reason is the stable code the Daemon parks its binding on.
 * A non-200 answer would reach the client as Centrifugo's temporary internal error instead.
 */
function refuse(
  reason: DaemonConnectRejectionReason,
  principal?: { workspaceId: string; computerId: string },
): Response {
  // A refusal ends a Computer's connection for good; never silent. A revoked key has no
  // principal left to name.
  console.warn(
    JSON.stringify({
      event: "daemon_connect:refused",
      reason,
      ...(principal
        ? { workspace_id: principal.workspaceId, computer_id: principal.computerId }
        : {}),
    }),
  );
  return Response.json({
    disconnect: { code: DAEMON_CONNECT_REJECTION_CODES[reason], reason },
  });
}

export type CentrifugoConnectDependencies = {
  daemonApiKeys: DaemonApiKeyRepository;
  computerBelongsToWorkspace(workspaceId: string, computerId: string): Promise<boolean>;
  /** Why a formerly valid key stopped being valid, if that was recorded (Workspace deleted,
   * Computer removed). */
  revocationReason(apiKeyHash: string): Promise<DaemonConnectRejectionReason | undefined>;
};

export function centrifugoConnectDependencies(db: PrismaClient): CentrifugoConnectDependencies {
  const revocations = new DaemonCredentialRevocations(db);
  return {
    daemonApiKeys: new PrismaDaemonApiKeyRepository(db),
    computerBelongsToWorkspace: async (workspaceId, computerId) =>
      Boolean(
        await db.workspaceComputer.findUnique({
          where: { workspaceId_computerId: { workspaceId, computerId } },
          select: { id: true },
        }),
      ),
    revocationReason: (apiKeyHash) => revocations.reasonFor(apiKeyHash),
  };
}

export async function authenticateCentrifugoConnect(
  request: Request,
  dependencies: CentrifugoConnectDependencies,
): Promise<Response> {
  try {
    const body = (await request.json()) as ConnectRequest;
    const key = connectData(body.data).daemonApiKey;
    if (typeof key !== "string") throw new Error("Daemon API key missing");
    let principal: DaemonApiKeyClaims;
    try {
      principal = await verifyDaemonApiKey(key, dependencies.daemonApiKeys);
    } catch (error) {
      // Only the holder of a formerly valid key learns why it stopped working; any other key is
      // an ordinary, retryable authentication failure.
      const reason = isDaemonApiKey(key)
        ? await dependencies.revocationReason(hashDaemonApiKey(key))
        : undefined;
      if (reason) return refuse(reason);
      throw error;
    }
    if (
      !(await dependencies.computerBelongsToWorkspace(principal.workspaceId, principal.computerId))
    )
      return refuse("computer_unlinked", principal);
    return Response.json({
      result: {
        user: principal.userId,
        meta: {
          workspace_id: principal.workspaceId,
          computer_id: principal.computerId,
        },
        subs: {
          [`daemon:${principal.workspaceId}:${principal.computerId}`]: {},
        },
      },
    });
  } catch {
    return Response.json(
      { error: { code: 401, message: "connection authentication failed" } },
      { status: 401 },
    );
  }
}
