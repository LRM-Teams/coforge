import type { PrismaClient } from "#src/generated/prisma/client";
import { peopleDirectPeerId } from "#src/features/conversations/direct-key";
import { AppError } from "#src/lib/app-error";
import { searchTerms } from "#src/lib/search-terms";
import {
  findMessageSearchIds,
  type MessageSearchSort,
} from "#src/server/db/repositories/message-search.repositories.server";
import { browserMessageFields, mapBrowserMessage } from "./conversation-history.server";
import { browserSenderName } from "./sender-display.server";

export type MessageSearchInput = {
  workspaceId: string;
  userId: string;
  /** Free text; each whitespace-separated term must appear in the message. */
  query?: string;
  /** Only messages sent by this user or Agent. */
  senderId?: string;
  /** Only messages sent by humans, or only by Agents. */
  senderKind?: "user" | "agent";
  /** Only messages that mention the viewer. */
  mentionsViewer?: boolean;
  /** Only messages in this channel or direct conversation. */
  conversationId?: string;
  after?: Date;
  before?: Date;
  sort: MessageSearchSort;
  limit: number;
  offset: number;
};

const searchHitSelect = {
  ...browserMessageFields,
  conversation: {
    select: {
      id: true,
      channelName: true,
      directKey: true,
      archivedAt: true,
      // A direct conversation with an Agent names its one Agent member; one between members
      // names the other member from its key (`peerOf`).
      members: {
        where: { agentId: { not: null } },
        select: { agent: { select: { id: true, name: true, displayName: true } } },
        take: 1,
      },
    },
  },
} as const;

export type MessageSearchHit = {
  /** Where the message was posted. */
  conversation: {
    id: string;
    channelName: string | null;
    directKey: string | null;
    archived: boolean;
    /** Who a direct conversation is with, from the viewer's seat: its Agent, or the member on the
     * other side (the viewer themself in their conversation with themself). Null for a channel. */
    direct:
      | { kind: "agent"; agent: { id: string; name: string; displayName: string } }
      | { kind: "people"; peer: { id: string; username: string; displayName: string } }
      | null;
  };
  message: ReturnType<typeof mapBrowserMessage>;
};

export type MessageSearchPage = {
  results: MessageSearchHit[];
  hasMore: boolean;
  /** The moment this page searched up to: the `before` given, else the server's clock. A later
   * page passes it back as `before`, so messages posted while paging never shift the offsets. */
  searchedAt: Date;
};

/**
 * One page of the messages a Workspace member may read that match a search, rendered with the
 * message stream's own projection so a result shows sender, attachments and mentions the same
 * way. With no query the filters alone select messages, newest first.
 */
export async function searchMessages(
  db: PrismaClient,
  input: MessageSearchInput,
): Promise<MessageSearchPage> {
  const membership = await db.workspaceMembership.findUnique({
    where: { workspaceId_userId: { workspaceId: input.workspaceId, userId: input.userId } },
    select: { userId: true },
  });
  if (!membership) throw new AppError("ACCESS_DENIED");

  const query = input.query?.trim() ?? "";
  const searchedAt = input.before ?? new Date();
  const ids = await findMessageSearchIds(db, {
    workspaceId: input.workspaceId,
    viewerUserId: input.userId,
    terms: searchTerms(query),
    query,
    senderId: input.senderId,
    senderKind: input.senderKind,
    mentionsViewer: input.mentionsViewer,
    conversationId: input.conversationId,
    after: input.after,
    before: searchedAt,
    sort: input.sort,
    limit: input.limit,
    offset: input.offset,
  });
  const pageIds = ids.slice(0, input.limit);
  const rows = await db.message.findMany({
    where: { id: { in: pageIds }, workspaceId: input.workspaceId },
    select: searchHitSelect,
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  const peerOf = (directKey: string | null) => peopleDirectPeerId(directKey, input.userId);
  const peerIds = [...new Set(rows.flatMap((row) => peerOf(row.conversation.directKey) ?? []))];
  const peers = new Map(
    peerIds.length
      ? (
          await db.user.findMany({
            where: { id: { in: peerIds } },
            select: { id: true, username: true, displayName: true },
          })
        ).map((user) => [
          user.id,
          { id: user.id, username: user.username, displayName: browserSenderName({ user }) },
        ])
      : [],
  );
  const results = pageIds.flatMap((id): MessageSearchHit[] => {
    const row = byId.get(id);
    if (!row) return [];
    const { conversation, ...message } = row;
    const agent = conversation.channelName === null ? conversation.members[0]?.agent : undefined;
    const peerId = peerOf(conversation.directKey);
    const peer = peerId ? peers.get(peerId) : undefined;
    return [
      {
        conversation: {
          id: conversation.id,
          channelName: conversation.channelName,
          directKey: conversation.directKey,
          archived: conversation.archivedAt !== null,
          direct: agent ? { kind: "agent", agent } : peer ? { kind: "people", peer } : null,
        },
        message: mapBrowserMessage(message, input.workspaceId),
      },
    ];
  });
  return { results, hasMore: ids.length > input.limit, searchedAt };
}
