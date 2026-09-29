import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { attachmentKeys } from "#src/server/attachments/attachment.server";
import { lockWorkspaceConversations } from "#src/server/conversations/conversation-lock.server";
import { DaemonCredentialRevocations } from "#src/server/db/repositories/daemon-credential-revocation.repositories.server";
import { retryOnWriteConflict } from "#src/server/db/write-conflict.server";
import {
  reconnectDaemon,
  type CentrifugoConnections,
  type CentrifugoServerApi,
} from "#src/server/centrifugo/server-api.server";
import { workspaceConversationChannel } from "#src/features/conversations/conversation-realtime";
import type { WorkspaceDeletedEvent } from "#src/features/workspaces/workspace-realtime";
import { PrismaOpenVikingBindingStore } from "#src/server/db/repositories/openviking-binding.repositories.server";
import { PrismaWorkspaceMemoryCleanupStore } from "#src/server/db/repositories/workspace-memory-cleanup.repositories.server";
import {
  createWorkspaceMemoryCleanup,
  type WorkspaceMemoryCleanup,
} from "#src/server/workspace-memory/cleanup.server";
import {
  WORKSPACE_DELETION_CLEANUP_OWNER,
  createProductionWorkspaceMemoryCleanupRemotes,
} from "#src/server/workspace-memory/cleanup-remotes.server";
import type { WorkspaceFileCleanup } from "./file-cleanup.server";
import { assertCanDeleteWorkspace } from "./member-role.server";
import { workspaceMemberRole } from "./members.server";

/** Who hears that a Workspace is gone, after the delete commits. */
export type WorkspaceDeletionSignals = {
  /** Every open page of the Workspace leaves it. */
  workspaceDeleted(workspaceId: string): Promise<void>;
  /** The Workspace's Computers' daemon connections reconnect at once, so each is refused with
   * `workspace_deleted` and parks the binding now instead of at its next reconnect. */
  reconnectDaemons(workspaceId: string, computerIds: readonly string[]): Promise<void>;
};

/** Removes a deleted Workspace's stored files. */
export type WorkspaceFileRemoval = Pick<WorkspaceFileCleanup, "remove">;

/** Removes the Workspace's memory outside its own rows (its OpenViking account, then the binding
 * naming it), as durable cleanup work the delete can find again. */
export type WorkspaceMemoryRemoval = Pick<
  WorkspaceMemoryCleanup,
  "enqueueWorkspaceDeletion" | "run"
>;

/** The memory removal of production: durable cleanup work over the database, with OpenViking and
 * the binding as its remotes. */
export function workspaceMemoryRemoval(db: PrismaClient): WorkspaceMemoryRemoval {
  return createWorkspaceMemoryCleanup({
    store: new PrismaWorkspaceMemoryCleanupStore(db),
    remotes: createProductionWorkspaceMemoryCleanupRemotes({
      bindings: new PrismaOpenVikingBindingStore(db),
    }),
  });
}

/** The cleanup work of a Workspace's deletion: one operation per Workspace, so pressing Delete
 * again picks up the work where a failed press left it. */
export const WORKSPACE_MEMORY_REMOVAL_OPERATION_ID = "workspace-deletion";

/** Longer than one OpenViking request may take, so a press that died holding the lease blocks the
 * next for seconds, not minutes. */
const MEMORY_REMOVAL_LEASE_MS = 30_000;

/**
 * The signals over Centrifugo. Pages get `workspace.deleted.v1` and are never disconnected; each
 * Computer's daemon connection for the Workspace alone reconnects (`reconnectDaemon`). The API is
 * built only when a signal is sent, after the delete has committed, so a missing Centrifugo
 * configuration is a failed signal, never a failed delete.
 */
export function centrifugoWorkspaceDeletionSignals(
  centrifugo: () => Pick<CentrifugoServerApi, "publishJson"> & CentrifugoConnections,
): WorkspaceDeletionSignals {
  return {
    async workspaceDeleted(workspaceId) {
      const event: WorkspaceDeletedEvent = { type: "workspace.deleted.v1", workspaceId };
      await centrifugo().publishJson(workspaceConversationChannel(workspaceId), event);
    },
    async reconnectDaemons(workspaceId, computerIds) {
      const api = centrifugo();
      await Promise.all(
        computerIds.map((computerId) => reconnectDaemon(api, workspaceId, computerId)),
      );
    },
  };
}

/**
 * The final transaction, after the message batches: the rest of the Workspace's rows go in it,
 * with the Workspace and its conversations locked meanwhile.
 */
const DELETE_TRANSACTION_TIMEOUT_MS = 60_000;

/** Messages deleted per statement before the final transaction. */
const MESSAGE_DELETE_BATCH = 5_000;

/** Attempts at each delete statement or transaction PostgreSQL aborts for a write conflict. */
const DELETE_ATTEMPTS = 3;

/**
 * Deleting a Workspace for good; its owner only, confirming with its slug. Its memory goes first,
 * before any row: the OpenViking account, then the binding naming it, and a memory that cannot be
 * removed keeps the Workspace whole for another try. Its messages go in batches next; everything
 * else goes in one transaction: the daemon keys it held are recorded as revoked, so its Computers
 * park the binding when they next connect; what members wrote goes before the Workspace, since
 * messages and Tasks name their sender, owner and creator member with `Restrict`. Afterwards the
 * open pages and the Computers hear of it, and its stored files are removed in the background,
 * best effort.
 */
export class WorkspaceDeletion {
  constructor(
    private readonly db: PrismaClient,
    private readonly effects: {
      files: WorkspaceFileRemoval;
      signals: WorkspaceDeletionSignals;
      memory: WorkspaceMemoryRemoval;
    },
  ) {}

  async delete(input: { workspaceId: string; userId: string; confirmSlug: string }) {
    const { workspaceId } = input;
    const workspace = await this.db.workspace.findUnique({
      where: { id: workspaceId },
      select: { slug: true },
    });
    // Deleted already, from another tab.
    if (!workspace) throw new AppError("NOT_FOUND");
    assertCanDeleteWorkspace(await workspaceMemberRole(this.db, workspaceId, input.userId));
    // The slug never changes, so one check against the typed confirmation is enough.
    if (input.confirmSlug !== workspace.slug) throw new AppError("INVALID_INPUT");

    // Nothing of the Workspace's memory may outlive it, so it goes before any row does: a memory
    // that cannot be removed leaves the Workspace as it was.
    await this.#removeMemory(workspaceId);
    await this.#deleteMessagesInBatches(workspaceId);
    const { computerIds, fileKeys } = await this.#retrying(workspaceId, () =>
      this.db.$transaction((tx) => this.#deleteRowsIn(tx, workspaceId), {
        timeout: DELETE_TRANSACTION_TIMEOUT_MS,
      }),
    );
    console.info(
      JSON.stringify({ event: "workspace_deletion:deleted", workspace_id: workspaceId }),
    );

    // The delete has committed; nothing below may undo or fail it. Files go in the background:
    // a Workspace with thousands of them must not hold up the owner's answer.
    void this.effects.files
      .remove(workspaceId, fileKeys)
      .catch((error: unknown) => logEffectFailure("file_removal", workspaceId, error));
    await this.#announce(workspaceId, computerIds);
  }

  /**
   * Removes the OpenViking account and the binding, when the Workspace has either, or cleanup an
   * earlier press left unfinished. The press that finds another holding the work, or OpenViking
   * failing, is refused with a retryable error; the work stays and the next press resumes it.
   */
  async #removeMemory(workspaceId: string) {
    const [binding, unfinished] = await Promise.all([
      this.db.openVikingBinding.findUnique({
        where: { workspaceId },
        select: { workspaceId: true },
      }),
      this.db.workspaceMemoryCleanupWork.findFirst({
        where: { workspaceId, state: { not: "settled" } },
        select: { id: true },
      }),
    ]);
    if (!binding && !unfinished) return;
    const operationId = WORKSPACE_MEMORY_REMOVAL_OPERATION_ID;
    // A binding found after our own work was marked done appeared since (memory provisioned again
    // meanwhile): that work is stale, and would otherwise finish at once and leave it standing.
    if (binding)
      await this.db.workspaceMemoryCleanupWork.deleteMany({
        where: {
          workspaceId,
          operationId,
          state: "settled",
        },
      });
    const { memory } = this.effects;
    await memory.enqueueWorkspaceDeletion({ workspaceId, operationId });
    const run = await memory.run({
      workspaceId,
      operationId,
      owner: WORKSPACE_DELETION_CLEANUP_OWNER,
      now: new Date(),
      ttlMs: MEMORY_REMOVAL_LEASE_MS,
    });
    if (run.status === "completed") return;
    console.warn(
      JSON.stringify({
        event: "workspace_deletion:memory_removal_failed",
        workspace_id: workspaceId,
        status: run.status,
        ...(run.status === "retryable_failure" && {
          target: run.failedTarget,
          error: run.work.sanitizedError,
        }),
        ...(run.status === "not_leased" && { target: run.target }),
      }),
    );
    throw memoryRemovalRefused();
  }

  /**
   * Messages go first, a batch per statement: their cascade (Tasks, attachments, reactions,
   * mentions, reads…) is one trigger per row per table, about 30 s per million messages, which
   * one transaction would hold every conversation lock for. Members may see messages vanish
   * before the Workspace does; the transaction below deletes whatever arrives meanwhile.
   */
  async #deleteMessagesInBatches(workspaceId: string) {
    for (;;) {
      const deleted = await this.#retrying(
        workspaceId,
        () => this.db.$executeRaw`
          DELETE FROM "messages" WHERE "id" IN (
            SELECT "id" FROM "messages" WHERE "workspaceId" = ${workspaceId}::uuid
            LIMIT ${MESSAGE_DELETE_BATCH})`,
      );
      if (deleted < MESSAGE_DELETE_BATCH) return;
    }
  }

  #retrying<T>(workspaceId: string, run: () => Promise<T>): Promise<T> {
    return retryOnWriteConflict(run, {
      attempts: DELETE_ATTEMPTS,
      onRetry: (attempt) =>
        console.warn(
          JSON.stringify({
            event: "workspace_deletion:retried",
            workspace_id: workspaceId,
            attempt,
          }),
        ),
    });
  }

  async #deleteRowsIn(tx: Prisma.TransactionClient, workspaceId: string) {
    // Locks in the order every writer takes them: a Task or message write locks its conversation
    // first and only then names the Workspace (its key takes a share lock on that row). The
    // Workspace row lock then holds off anything new naming the Workspace, a conversation among
    // them, so the second pass locks any conversation created in between. Nothing can then land
    // between the deletes below and fail the cascade on its `Restrict`.
    await lockWorkspaceConversations(tx, workspaceId);
    const [locked] = await tx.$queryRaw<{ iconObjectKey: string | null }[]>`
      SELECT "iconObjectKey" FROM "workspaces" WHERE "id" = ${workspaceId}::uuid FOR UPDATE`;
    if (!locked) throw new AppError("NOT_FOUND");
    await lockWorkspaceConversations(tx, workspaceId);
    // Memory bound meanwhile (provisioned again after its removal) is still there to remove.
    if (await tx.openVikingBinding.findUnique({ where: { workspaceId } }))
      throw memoryRemovalRefused();
    // Cleanup work is bookkeeping for a Workspace about to go; its rows name the Workspace with
    // `Restrict`.
    await tx.workspaceMemoryCleanupWork.deleteMany({ where: { workspaceId } });
    // Read under the locks, so no file uploaded meanwhile is left out.
    const fileKeys = {
      files: await attachmentKeys(tx, { workspaceId }),
      images: await this.#imageKeys(tx, workspaceId, locked.iconObjectKey),
    };
    const computers = await tx.workspaceComputer.findMany({
      where: { workspaceId },
      select: { computerId: true },
    });
    const revocations = await DaemonCredentialRevocations.recordForWorkspace(tx, workspaceId);
    console.info(
      JSON.stringify({
        event: "workspace_deletion:revocations",
        workspace_id: workspaceId,
        revocations,
      }),
    );
    // Everything else cascades from the Workspace, except these, which name rows that go in the
    // same cascade with `Restrict`: messages (with their Tasks and Action cards) their
    // conversation members, and Memory Offer citations the memory records they cite.
    await tx.memoryOfferCitation.deleteMany({ where: { workspaceId } });
    await tx.message.deleteMany({ where: { workspaceId } });
    await tx.workspace.delete({ where: { id: workspaceId } });
    return { computerIds: computers.map(({ computerId }) => computerId), fileKeys };
  }

  /** Pages and daemons hear independently: no page is disconnected. */
  async #announce(workspaceId: string, computerIds: readonly string[]) {
    await Promise.all([
      this.#signal("workspace_deleted", workspaceId, () =>
        this.effects.signals.workspaceDeleted(workspaceId),
      ),
      computerIds.length
        ? this.#signal("daemon_reconnect", workspaceId, () =>
            this.effects.signals.reconnectDaemons(workspaceId, computerIds),
          )
        : undefined,
    ]);
  }

  /** The Workspace icon, its Project icons and its Agents' avatars, deleted Agents included. */
  async #imageKeys(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    workspaceIconKey: string | null,
  ) {
    const projects = await tx.project.findMany({
      where: { workspaceId, iconObjectKey: { not: null } },
      select: { iconObjectKey: true },
    });
    const agents = await tx.agent.findMany({
      where: { workspaceId, avatarObjectKey: { not: null } },
      select: { avatarObjectKey: true },
    });
    return [
      workspaceIconKey,
      ...projects.map(({ iconObjectKey }) => iconObjectKey),
      ...agents.map(({ avatarObjectKey }) => avatarObjectKey),
    ].filter((key): key is string => key !== null);
  }

  async #signal(signal: string, workspaceId: string, send: () => Promise<void>) {
    try {
      await send();
    } catch (error) {
      logEffectFailure(signal, workspaceId, error);
    }
  }
}

/** The delete could not remove the Workspace's memory: try again in a moment. */
function memoryRemovalRefused() {
  return new AppError("TEMPORARILY_UNAVAILABLE", { errorId: "workspace-memory-removal-failed" });
}

function logEffectFailure(effect: string, workspaceId: string, error: unknown) {
  console.warn(
    JSON.stringify({
      event: "workspace_deletion:effect_failed",
      effect,
      workspace_id: workspaceId,
      error_type: error instanceof Error ? error.name : typeof error,
    }),
  );
}
