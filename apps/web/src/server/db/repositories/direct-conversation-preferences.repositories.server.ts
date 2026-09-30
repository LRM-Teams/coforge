import { lockConversation } from "#src/server/conversations/conversation-lock.server";
import {
  lockMemberPins,
  setConversationPin,
} from "#src/server/conversations/conversation-pins.server";
import {
  HUMAN_UNREAD_MESSAGE_SQL,
  markUnreadAnchor,
} from "#src/server/conversations/human-unread.server";
import type { PrismaClient } from "#src/generated/prisma/client";
import { viewerDirectConversationWhere } from "#src/server/conversations/viewer-direct-conversations.server";
import { peopleDirectPeerId } from "#src/features/conversations/direct-key";
import {
  peoplePeer,
  peoplePeerUserFields,
  type DirectConversationPeer,
} from "#src/server/conversations/direct-conversation-peer.server";

/** A direct conversation of the viewer's, by its id, and the viewer's own member row in it. */
export type ViewerDirectMembership = { conversationId: string; memberId: string };

/**
 * The viewer's own list preferences for their DMs (pinned, marked unread, closed) and the sidebar's
 * read of their DMs: which there are, with whom, and how many unread. A DM with an Agent and one
 * between members are alike here. Writes take a DM the caller has already authorized
 * (`DirectConversations`); only what the viewer's list shows changes, never the conversation.
 */
export class PrismaDirectConversationPreferences {
  constructor(private readonly db: PrismaClient) {}

  /** Pins the viewer's DM above the rest of their list, or unpins it (#121), and says whether the
   * pin changed. The conversation lock orders it against concurrent writes the way the channel
   * side does. */
  async setPinned(
    workspaceId: string,
    userId: string,
    { conversationId, memberId }: ViewerDirectMembership,
    pinned: boolean,
  ) {
    const changed = await this.db.$transaction(async (tx) => {
      await lockMemberPins(tx, workspaceId, userId);
      await lockConversation(tx, conversationId);
      return setConversationPin(tx, { workspaceId, userId, conversationId, memberId }, pinned);
    });
    return { pinned, changed };
  }

  /** Marks the viewer's DM unread, anchored on the newest top-level message someone else sent, or
   * clears the marker, and says whether the marker changed. A DM where only the viewer has spoken
   * has nothing to mark. */
  async setUnread({ conversationId, memberId }: ViewerDirectMembership, unread: boolean) {
    let marker: number | null = null;
    const changed = await this.db.$transaction(async (tx) => {
      await lockConversation(tx, conversationId);
      if (unread) marker = await markUnreadAnchor(tx, conversationId, memberId);
      const before = await tx.conversationMember.findUniqueOrThrow({
        where: { id: memberId },
        select: { unreadFromSequence: true },
      });
      await tx.conversationMember.update({
        where: { id: memberId },
        data: { unreadFromSequence: marker },
      });
      return before.unreadFromSequence !== marker;
    });
    return { unread: marker !== null, changed };
  }

  /** Closes the viewer's DM in their list only, or brings it back, and says whether that wrote
   * anything (a close always does). */
  async setHidden({ conversationId, memberId }: ViewerDirectMembership, hidden: boolean) {
    const changed = await this.db.$transaction(async (tx) => {
      await lockConversation(tx, conversationId);
      // Closing always stamps the time: a closed DM that the other side's newer message brought
      // back still has an old `hiddenAt`, and closing it again must move it past that message.
      const updated = await tx.conversationMember.updateMany({
        where: hidden ? { id: memberId } : { id: memberId, hiddenAt: { not: null } },
        data: { hiddenAt: hidden ? new Date() : null },
      });
      return updated.count > 0;
    });
    return { hidden, changed };
  }

  /**
   * What the sidebar needs about the viewer's DMs, by conversation id: each DM they can open (in
   * the order they started) and who it is with, the pinned ones with their order, and the closed
   * ones it leaves out.
   */
  async preferencesForUser(workspaceId: string, userId: string) {
    const [memberships, pins, hidden] = await Promise.all([
      // Only DMs the viewer can open: a member row in someone else's DM, or a DM with an Agent
      // they did not create (from before only a creator could start one), lists nothing.
      this.db.conversationMember.findMany({
        where: {
          workspaceId,
          userId,
          leftAt: null,
          conversation: viewerDirectConversationWhere(userId),
        },
        orderBy: [{ conversation: { createdAt: "asc" } }, { conversationId: "asc" }],
        select: {
          conversation: {
            select: {
              id: true,
              directKey: true,
              members: { where: { agentId: { not: null } }, select: { agentId: true } },
            },
          },
        },
      }),
      this.db.conversationPin.findMany({
        where: {
          workspaceId,
          member: { userId, leftAt: null },
          conversation: { directKey: { not: null } },
        },
        orderBy: { sortOrder: "asc" },
        select: { conversationId: true, sortOrder: true },
      }),
      // DMs the viewer closed that stay closed: a top-level message someone else posted after the
      // close brings one back. `NOT EXISTS` stops at the first such message on the
      // `messages(conversationId, createdAt)` index instead of loading the DM's history.
      this.db.$queryRaw<{ conversationId: string }[]>`
        SELECT cm."conversationId" AS "conversationId"
        FROM "conversation_members" cm
        JOIN "conversations" c
          ON c."id" = cm."conversationId"
         AND c."workspaceId" = ${workspaceId}::uuid
         AND c."directKey" IS NOT NULL
        WHERE cm."userId" = ${userId}::uuid
          AND cm."workspaceId" = ${workspaceId}::uuid
          AND cm."leftAt" IS NULL
          AND cm."hiddenAt" IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM "messages" m
            WHERE m."conversationId" = cm."conversationId"
              AND m."threadRootId" IS NULL
              AND m."senderMemberId" IS NOT NULL
              AND m."senderMemberId" <> cm."id"
              AND m."createdAt" > cm."hiddenAt"
          )
      `,
    ]);
    // The member on the other side comes from the key, so it survives their leaving the Workspace.
    const peerIds = new Map<string, string>();
    for (const { conversation } of memberships) {
      const peerId = peopleDirectPeerId(conversation.directKey, userId);
      if (peerId) peerIds.set(conversation.id, peerId);
    }
    const people = peerIds.size
      ? await this.db.user.findMany({
          where: { id: { in: [...new Set(peerIds.values())] } },
          select: peoplePeerUserFields,
        })
      : [];
    const profiles = new Map(people.map((person) => [person.id, person]));
    return {
      conversations: memberships.flatMap(({ conversation }) => {
        const peer = this.peerOf(workspaceId, conversation, peerIds, profiles);
        return peer ? [{ conversationId: conversation.id, peer }] : [];
      }),
      pinned: pins,
      // Closed DMs, pinned or not: the sidebar keeps a pinned one listed (in Pinned).
      hidden: hidden.map((row) => row.conversationId),
    };
  }

  private peerOf(
    workspaceId: string,
    conversation: { id: string; members: { agentId: string | null }[] },
    peerIds: ReadonlyMap<string, string>,
    profiles: ReadonlyMap<
      string,
      {
        id: string;
        username: string;
        displayName: string | null;
        fullName: string | null;
        avatarObjectKey: string | null;
      }
    >,
  ): DirectConversationPeer | undefined {
    const peerId = peerIds.get(conversation.id);
    if (peerId === undefined) {
      const agentId = conversation.members[0]?.agentId;
      return agentId ? { kind: "agent", agentId } : undefined;
    }
    const person = profiles.get(peerId);
    return person ? peoplePeer(workspaceId, person) : undefined;
  }

  /**
   * Unread per DM for the sidebar badges, by conversation id: other-authored top-level messages
   * past the viewer's cursor, or from their mark-as-unread marker when that is lower. A fully read
   * DM still has a row, so a later event can bump it live. The count is a LATERAL per membership
   * with a single lower bound, so it is an index range on `messages(conversationId, sequence)`
   * covering only the unread tail; a plain join (or an OR of the two bounds) lets the planner
   * hash-join every message of every DM instead.
   */
  async unreadCountsForUser(workspaceId: string, userId: string) {
    return this.db.$queryRaw<{ conversationId: string; unread: number }[]>`
      SELECT cm."conversationId" AS "conversationId", unread."count"::int AS "unread"
      FROM "conversation_members" cm
      JOIN "conversations" c
        ON c."id" = cm."conversationId" AND c."directKey" IS NOT NULL
      CROSS JOIN LATERAL (
        SELECT COUNT(*) AS "count"
        FROM "messages" m
        WHERE m."conversationId" = cm."conversationId"
          AND m."threadRootId" IS NULL
          AND ${HUMAN_UNREAD_MESSAGE_SQL}
      ) unread
      WHERE cm."userId" = ${userId}::uuid
        AND cm."leftAt" IS NULL
        AND cm."workspaceId" = ${workspaceId}::uuid
        AND c."workspaceId" = ${workspaceId}::uuid
    `;
  }
}
