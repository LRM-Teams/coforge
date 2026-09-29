import {
  isDaemonConnectRejectionReason,
  type DaemonConnectRejectionReason,
} from "@lrm/coforge-sdk/internal";
import type { Prisma, PrismaClient } from "#src/generated/prisma/client";

/** How long a revocation answers its former key holder. A Computer offline longer than this gets
 * the ordinary, retryable authentication failure instead of a reason. */
export const DAEMON_CREDENTIAL_REVOCATION_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Remembers why daemon credentials stopped being valid, keyed by the credential's hash, so the
 * connect proxy can tell the holder of that exact key, and nobody else, that its Workspace is
 * gone. A revocation outlives the Workspace, Computer, and key rows it was recorded from.
 * Deleting a Computer row or its owner cascades the keys without a record; those Computers get
 * the ordinary retryable failure until such a delete path records one too.
 */
export class DaemonCredentialRevocations {
  constructor(
    private readonly db: PrismaClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * `workspace_deleted` for every live key of the Workspace. Call inside the transaction that
   * deletes the Workspace, before the delete cascades its keys away and before anything in that
   * transaction revokes them: only live keys are recorded. Resolves with how many were recorded,
   * for the caller's own log line.
   */
  static recordForWorkspace(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    now: Date = new Date(),
  ): Promise<number> {
    return record(tx, { workspaceId }, "workspace_deleted", now);
  }

  /** `computer_unlinked` for the Computer's live keys in the Workspace, on the same terms, inside
   * the transaction that removes the Computer from the Workspace. */
  static recordForComputer(
    tx: Prisma.TransactionClient,
    scope: { workspaceId: string; computerId: string },
    now: Date = new Date(),
  ): Promise<number> {
    return record(tx, scope, "computer_unlinked", now);
  }

  /** The reason recorded for this key hash, while it is still retained. */
  async reasonFor(apiKeyHash: string): Promise<DaemonConnectRejectionReason | undefined> {
    const revocation = await this.db.daemonCredentialRevocation.findFirst({
      where: { apiKeyHash, revokedAt: { gt: retentionCutoff(this.now()) } },
      select: { reason: true },
    });
    return revocation && isDaemonConnectRejectionReason(revocation.reason)
      ? revocation.reason
      : undefined;
  }
}

/** Only live keys: a key already revoked because the Computer registered again stays an ordinary
 * authentication failure. Expired revocations are pruned in the same write. */
async function record(
  tx: Prisma.TransactionClient,
  scope: { workspaceId: string; computerId?: string },
  reason: DaemonConnectRejectionReason,
  now: Date,
): Promise<number> {
  const keys = await tx.daemonApiKey.findMany({
    where: { ...scope, revokedAt: null },
    select: { apiKeyHash: true },
  });
  await tx.daemonCredentialRevocation.deleteMany({
    where: { revokedAt: { lte: retentionCutoff(now) } },
  });
  if (!keys.length) return 0;
  const { count } = await tx.daemonCredentialRevocation.createMany({
    data: keys.map(({ apiKeyHash }) => ({ apiKeyHash, reason, revokedAt: now })),
    skipDuplicates: true,
  });
  return count;
}

/** Revocations recorded at or before this instant are past retention. */
function retentionCutoff(now: Date): Date {
  return new Date(now.getTime() - DAEMON_CREDENTIAL_REVOCATION_RETENTION_MS);
}
