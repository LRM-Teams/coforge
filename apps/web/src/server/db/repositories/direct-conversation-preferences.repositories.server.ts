import { lockConversation } from "#src/server/conversations/conversation-lock.server";
import {
  lockMemberPins,
  setConversationPin,
} from "#src/server/conversations/conversation-pins.server";
import { HUMAN_UNREAD_MESSAGE_SQL } from "#src/server/conversations/human-unread.server";
import type { PrismaClient } from "#src/generated/prisma/client";
import { viewerDirectConversationWhere } from "#src/server/conversations/viewer-direct-conversations.server";
import { isPeopleDirectKey, peopleDirectKeyPair } from "#src/features/conversations/direct-key";
import { workspaceUserAvatarUrl } from "./user-profile.repositories.server";

/** A direct conversation of the viewer's, by its id, and the viewer's own member row in it. */
export type ViewerDirectMembership = { conversationId: string; memberId: string };

/** Who a listed DM is with: the viewer's Agent, or a member (the viewer themself in their own). */
export type DirectConversationPeer =
  | { kind: "agent"; agentId: string }
  | {
      kind: "people";
      userId: string;
      username: string;
      /** The member's display name, or their username when they have none. */
      displayName: string;
      avatarUrl: string | null;
    };

/**
 * The viewer's own list preferences for their DMs (pinned, marked unread, closed) and the sidebar's
 * read of their DMs: which there are, with whom, and how many unread. A DM with an Agent and one
 * between members are alike here. Writes take a DM the caller has already authorized
 * (`DirectConversations`); only what the viewer's list shows changes, never the conversation.
 */
export class PrismaDirectConversationPreferences {
  constructor(private readonly db: PrismaClient) {}

  /** Pins the viewer's DM above the rest of their list, or unpins it (#121). The conversation lock
   * orders it against concurrent writes the way the channel side does. */
  async setPinned(
    workspaceId: string,
    userId: string,
    { conversationId, memberId }: ViewerDirectMembership,
    pinned: boolean,
  ) {
    await this.db.$transaction(async (tx) => {
      await lockMemberPins(tx, workspaceId, userId);
      await lockConversation(tx, conversationId);
      await setConversationPin(tx, { workspaceId, userId, conversationId, memberId }, pinned);
    });
    return { pinned };
  }

  /** Marks the viewer's DM unread, anchored on its newest top-level message, or clears the marker.
   * A DM with no messages has nothing to mark. */
  async setUnread({ conversationId, memberId }: ViewerDirectMembership, unread: boolean) {
    let marker: number | null = null;
    await this.db.$transaction(async (tx) => {
      await lockConversation(tx, conversationId);
      if (unread) {
        const newest = await tx.message.findFirst({
          where: { conversationId, threadRootId: null },
          orderBy: { sequence: "desc" },
          select: { sequence: true },
        });
        marker = newest?.sequence ?? null;
      }
      await tx.conversationMember.update({
        where: { id: memberId },
        data: { unreadFromSequence: marker },
      });
    });
    return { unread: marker !== null };
  }

  /** Closes the viewer's DM in their list only, or brings it back. */
  async setHidden({ conversationId, memberId }: ViewerDirectMembership, hidden: boolean) {
    await this.db.$transaction(async (tx) => {
      await lockConversation(tx, conversationId);
      await tx.conversationMember.update({
        where: { id: memberId },
        data: { hiddenAt: hidden ? new Date() : null },
      });
    });
    return { hidden };
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
      const { directKey } = conversation;
      if (!directKey || !isPeopleDirectKey(directKey)) continue;
      const [first, second] = peopleDirectKeyPair(directKey);
      peerIds.set(conversation.id, first === userId ? second : first);
    }
    const people = peerIds.size
      ? await this.db.user.findMany({
          where: { id: { in: [...new Set(peerIds.values())] } },
          select: { id: true, username: true, displayName: true, avatarObjectKey: true },
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
      { id: string; username: string; displayName: string | null; avatarObjectKey: string | null }
    >,
  ): DirectConversationPeer | undefined {
    const peerId = peerIds.get(conversation.id);
    if (peerId === undefined) {
      const agentId = conversation.members[0]?.agentId;
      return agentId ? { kind: "agent", agentId } : undefined;
    }
    const person = profiles.get(peerId);
    if (!person) return undefined;
    return {
      kind: "people",
      userId: person.id,
      username: person.username,
      displayName: person.displayName?.trim() || person.username,
      avatarUrl: workspaceUserAvatarUrl(workspaceId, person.id, person.avatarObjectKey),
    };
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
