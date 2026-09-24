import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { searchTerms } from "#src/lib/search-terms";
import {
  findMessageSearchIds,
  type MessageSearchSort,
} from "#src/server/db/repositories/message-search.repositories.server";
import { browserMessageFields, mapBrowserMessage } from "./conversation-history.server";

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
      // A direct conversation's other side is its one Agent member.
      members: {
        where: { agentId: { not: null } },
        select: { agent: { select: { id: true, name: true, displayName: true } } },
        take: 1,
      },
    },
  },
} as const;

export type MessageSearchHit = {
  /** Where the message was posted; a direct conversation names its Agent. */
  conversation: {
    id: string;
    channelName: string | null;
    directKey: string | null;
    archived: boolean;
    directAgent: { id: string; name: string; displayName: string } | null;
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
  const results = pageIds.flatMap((id) => {
    const row = byId.get(id);
    if (!row) return [];
    const { conversation, ...message } = row;
    return [
      {
        conversation: {
          id: conversation.id,
          channelName: conversation.channelName,
          directKey: conversation.directKey,
          archived: conversation.archivedAt !== null,
          directAgent:
            conversation.channelName === null ? (conversation.members[0]?.agent ?? null) : null,
        },
        message: mapBrowserMessage(message, input.workspaceId),
      },
    ];
  });
  return { results, hasMore: ids.length > input.limit, searchedAt };
}
