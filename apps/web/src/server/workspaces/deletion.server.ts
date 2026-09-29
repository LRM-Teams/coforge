import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { attachmentKeys, removeAttachmentFiles } from "#src/server/attachments/attachment.server";
import { lockWorkspaceConversations } from "#src/server/conversations/conversation-lock.server";
import { DaemonCredentialRevocations } from "#src/server/db/repositories/daemon-credential-revocation.repositories.server";
import type { FileStorage } from "#src/server/files/file-storage.server";
import type {
  CentrifugoConnections,
  CentrifugoServerApi,
} from "#src/server/centrifugo/server-api.server";
import { workspaceConversationChannel } from "#src/features/conversations/conversation-realtime";
import type { WorkspaceDeletedEvent } from "#src/features/workspaces/workspace-realtime";
import { assertCanDeleteWorkspace } from "./member-role.server";
import { workspaceMemberRole } from "./members.server";

/** Who hears that a Workspace is gone, after the delete commits. */
export type WorkspaceDeletionSignals = {
  /** Every open page of the Workspace leaves it. */
  workspaceDeleted(workspaceId: string): Promise<void>;
  /** The connections of the people whose daemon keys the Workspace held reconnect at once, so
   * each of their Computers is refused with `workspace_deleted` and parks the binding now. */
  reconnectDaemons(userIds: readonly string[]): Promise<void>;
};

/**
 * The signals over Centrifugo. A daemon's connection is its key owner's (the connect proxy's
 * `user`), and nothing records which of that person's connections is which, so all of them are
 * disconnected: their pages and their daemons for other Workspaces reconnect at once; only this
 * Workspace's daemons are then refused. The code is in centrifuge-js's reconnecting 4000-4499 range.
 * The API is built only when a signal is sent, after the delete has committed, so a missing
 * Centrifugo configuration is a failed signal, never a failed delete.
 */
export function centrifugoWorkspaceDeletionSignals(
  centrifugo: () => Pick<CentrifugoServerApi, "publishJson"> & CentrifugoConnections,
): WorkspaceDeletionSignals {
  return {
    async workspaceDeleted(workspaceId) {
      const event: WorkspaceDeletedEvent = { type: "workspace.deleted.v1", workspaceId };
      await centrifugo().publishJson(workspaceConversationChannel(workspaceId), event);
    },
    async reconnectDaemons(userIds) {
      const api = centrifugo();
      await Promise.all(
        userIds.map((user) => api.disconnect(user, { code: 4000, reason: "workspace deleted" })),
      );
    },
  };
}

/**
 * Long enough for a Workspace with years of history: every row in it goes in this one
 * transaction, which holds the Workspace and its conversations locked meanwhile.
 */
const DELETE_TRANSACTION_TIMEOUT_MS = 60_000;

/**
 * Deleting a Workspace for good; its owner only, confirming with its slug. Everything in it goes
 * in one transaction: the daemon keys it held are recorded as revoked first, so its Computers park
 * the binding when they next connect; what members wrote goes before the Workspace, since messages
 * and Tasks name their sender, owner and creator member with `Restrict`. Afterwards the open pages
 * and the Computers hear of it, and its stored files are removed, best effort.
 */
export class WorkspaceDeletion {
  constructor(
    private readonly db: PrismaClient,
    private readonly effects: {
      /** Private attachment storage. */
      files: () => Promise<FileStorage>;
      /** Public image storage: the Workspace icon, Project icons, Agent avatars. */
      images: () => Promise<FileStorage>;
      signals: WorkspaceDeletionSignals;
    },
  ) {}

  async delete(input: { workspaceId: string; userId: string; confirmSlug: string }) {
    const { workspaceId } = input;
    assertCanDeleteWorkspace(await workspaceMemberRole(this.db, workspaceId, input.userId));
    const { slug } = await this.db.workspace.findUniqueOrThrow({
      where: { id: workspaceId },
      select: { slug: true },
    });
    // The slug never changes, so one check against the typed confirmation is enough.
    if (input.confirmSlug !== slug) throw new AppError("INVALID_INPUT");

    const { daemonOwnerIds, fileKeys, imageKeys } = await this.db.$transaction(
      async (tx) => {
        // The Workspace row lock holds off new rows naming the Workspace (memory state among them);
        // the conversation locks hold off new messages, Tasks and memberships, which name only
        // their conversation. None can then land between the deletes below and fail the cascade on
        // its `Restrict`.
        const [locked] = await tx.$queryRaw<{ iconObjectKey: string | null }[]>`
          SELECT "iconObjectKey" FROM "workspaces" WHERE "id" = ${workspaceId}::uuid FOR UPDATE`;
        // Deleted meanwhile, from another tab.
        if (!locked) throw new AppError("NOT_FOUND");
        // Workspace memory keeps state in OpenViking that only its own cleanup removes; until that
        // runs, the Workspace stays (its cleanup rows name the Workspace with `Restrict`).
        if (
          (await tx.workspaceMemoryCleanupWork.findFirst({ where: { workspaceId } })) ||
          (await tx.openVikingBinding.findUnique({ where: { workspaceId } }))
        )
          throw new AppError("CONFLICT");
        await lockWorkspaceConversations(tx, workspaceId);
        // Read under the locks, so no file uploaded meanwhile is left behind.
        const fileKeys = await attachmentKeys(tx, { workspaceId });
        const imageKeys = await this.#imageKeys(tx, workspaceId, locked.iconObjectKey);
        const owners = await tx.daemonApiKey.findMany({
          where: { workspaceId, revokedAt: null },
          select: { ownerId: true },
          distinct: ["ownerId"],
        });
        const revocations = await DaemonCredentialRevocations.recordForWorkspace(tx, workspaceId);
        console.info(
          JSON.stringify({
            event: "workspace_deletion:revocations",
            workspace_id: workspaceId,
            revocations,
          }),
        );
        // Everything else cascades from the Workspace, except these, which name rows that go in
        // the same cascade with `Restrict`: messages (with their Tasks and Action cards) their
        // conversation members, and Memory Offer citations the memory records they cite.
        await tx.memoryOfferCitation.deleteMany({ where: { workspaceId } });
        await tx.message.deleteMany({ where: { workspaceId } });
        await tx.workspace.delete({ where: { id: workspaceId } });
        return { daemonOwnerIds: owners.map(({ ownerId }) => ownerId), fileKeys, imageKeys };
      },
      { timeout: DELETE_TRANSACTION_TIMEOUT_MS },
    );
    console.info(
      JSON.stringify({ event: "workspace_deletion:deleted", workspace_id: workspaceId }),
    );

    // The delete has committed; nothing below may undo or fail it.
    await Promise.all([
      this.#announce(workspaceId, daemonOwnerIds),
      removeAttachmentFiles(fileKeys, this.effects.files),
      removeAttachmentFiles(imageKeys, this.effects.images),
    ]);
  }

  /** Open pages hear first: a page of a disconnected person could no longer subscribe to the
   * Workspace's channel once it reconnects, and would miss the news. */
  async #announce(workspaceId: string, daemonOwnerIds: readonly string[]) {
    await this.#signal("workspace_deleted", workspaceId, () =>
      this.effects.signals.workspaceDeleted(workspaceId),
    );
    if (daemonOwnerIds.length)
      await this.#signal("daemon_reconnect", workspaceId, () =>
        this.effects.signals.reconnectDaemons(daemonOwnerIds),
      );
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
      console.warn(
        JSON.stringify({
          event: "workspace_deletion:signal_failed",
          signal,
          workspace_id: workspaceId,
          error_type: error instanceof Error ? error.name : typeof error,
        }),
      );
    }
  }
}
