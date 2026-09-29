/**
 * What a conversation window carries about a thread: a summary under its root, never its replies
 * (a thread's replies are read when its pane opens, `conversationThreadQuery`). The summary holds
 * exactly what the stream shows of a thread: the reply count, the newest replies a preview lists,
 * and the unread mark. JSON-compatible values only, so an unchanged summary keeps its object across
 * a re-read (see `features/conversations/AGENTS.md`).
 */

/** The stream's thread preview lists this many of a thread's newest replies. */
export const THREAD_PREVIEW_REPLIES = 3;

/** A preview shows one truncated line, so a longer reply travels cut to this many characters. */
export const THREAD_PREVIEW_BODY_MAX = 280;

/** One reply as the stream's preview lists it: who, when and the one line of what they said. */
export type ThreadPreviewReply = {
  id: string;
  sequence: number;
  senderName: string;
  senderAvatarUrl: string | null;
  /** True when the replying Agent has since been deleted. */
  senderDeleted: boolean;
  body: string;
  createdAt: string;
};

export type ThreadSummary = {
  /** People's replies: a system notice is not a reply. */
  replyCount: number;
  /** The newest reply of any kind this summary reflects. A reply at or below it is already in the
   * summary, so a realtime copy of it changes nothing. */
  lastReplySequence: number;
  lastReplyAt: string;
  /** The Agents' replies the viewer has not read; always 0 for someone who is not a member. */
  unread: number;
  /** The newest non-system replies, oldest first. */
  latestReplies: ThreadPreviewReply[];
};

/**
 * A reply's body as the preview carries it: cut to `THREAD_PREVIEW_BODY_MAX`, never inside a
 * mention or reference token (`<@…>`), which would show as raw text, and marked with an ellipsis.
 */
export function previewBody(body: string): string {
  if (body.length <= THREAD_PREVIEW_BODY_MAX) return body;
  let cut = body.slice(0, THREAD_PREVIEW_BODY_MAX);
  const tokenStart = cut.lastIndexOf("<@");
  if (tokenStart > cut.lastIndexOf(">")) cut = cut.slice(0, tokenStart);
  return `${cut.trimEnd()}…`;
}

/** A reply as a summary folds it in: the fields of a stream message it reads. */
export type ThreadReplyInput = {
  id: string;
  sequence: number;
  senderKind: "user" | "agent" | "system";
  senderName: string;
  senderAvatarUrl?: string | null;
  senderDeleted?: boolean;
  body: string;
  createdAt: Date | string;
};

/**
 * A thread's summary with one more reply in it, as the server's read would have made it. A reply
 * at or below `lastReplySequence` is already reflected (the window was read after it, or its
 * realtime signal came twice), so the summary comes back as it was. `countUnread` is false for
 * someone who is not a member, for whom nothing is unread.
 */
export function withReply(
  summary: ThreadSummary | undefined,
  reply: ThreadReplyInput,
  { countUnread }: { countUnread: boolean },
): ThreadSummary {
  if (summary && reply.sequence <= summary.lastReplySequence) return summary;
  const createdAt = new Date(reply.createdAt).toISOString();
  const isReply = reply.senderKind !== "system";
  const latestReplies = isReply
    ? [
        ...(summary?.latestReplies ?? []),
        {
          id: reply.id,
          sequence: reply.sequence,
          senderName: reply.senderName,
          senderAvatarUrl: reply.senderAvatarUrl ?? null,
          senderDeleted: reply.senderDeleted ?? false,
          body: previewBody(reply.body),
          createdAt,
        },
      ].slice(-THREAD_PREVIEW_REPLIES)
    : (summary?.latestReplies ?? []);
  return {
    replyCount: (summary?.replyCount ?? 0) + (isReply ? 1 : 0),
    lastReplySequence: reply.sequence,
    lastReplyAt: createdAt,
    unread: (summary?.unread ?? 0) + (countUnread && reply.senderKind === "agent" ? 1 : 0),
    latestReplies,
  };
}

/** A thread's summary once the viewer has read through `throughSequence`: nothing unread when that
 * reaches the newest reply, else as it was (which replies are still unread is not known here). */
export function withThreadRead(summary: ThreadSummary, throughSequence: number): ThreadSummary {
  return throughSequence >= summary.lastReplySequence && summary.unread > 0
    ? { ...summary, unread: 0 }
    : summary;
}

/**
 * A thread's read cursor: the stored `thread_reads` row, raised by any mark-read this visit has
 * already performed. `undefined` means the viewer has never read the thread: the thread pane then
 * opens without an unread divider (opening a long thread for the first time should not bury the
 * conversation that was just clicked into), while the root's summary counts every Agent reply as
 * unread.
 */
export function threadReadThrough(
  reads: {
    persistedReads?: Readonly<Record<string, number>>;
    localReads: Readonly<Record<string, number>>;
  },
  rootId: string,
): number | undefined {
  const local = reads.localReads[rootId];
  const persisted = reads.persistedReads?.[rootId];
  if (local === undefined && persisted === undefined) return undefined;
  return Math.max(local ?? 0, persisted ?? 0);
}

/** What one page of a conversation window says about the threads of its roots. */
export type WindowThreadsPage = {
  threads?: Readonly<Record<string, ThreadSummary>>;
  threadReadThrough?: Readonly<Record<string, number>>;
  followedThreadRootIds?: readonly string[];
};

/**
 * The threads of the whole loaded window: each page holds its own roots' summaries, cursors and
 * follows (a root sits on exactly one page), so the window's are their union. A window of one page
 * hands that page's own objects back, so nothing changes identity without a reason.
 */
export function mergeWindowThreads(pages: readonly WindowThreadsPage[]) {
  const only = pages.length === 1 ? pages[0] : undefined;
  if (only)
    return {
      threads: only.threads ?? NO_THREADS,
      threadReadThrough: only.threadReadThrough ?? NO_READS,
      followedThreadRootIds: only.followedThreadRootIds,
    };
  const followed = pages.flatMap((page) => page.followedThreadRootIds ?? []);
  return {
    threads: Object.assign({}, ...pages.map((page) => page.threads)) as Record<
      string,
      ThreadSummary
    >,
    threadReadThrough: Object.assign({}, ...pages.map((page) => page.threadReadThrough)) as Record<
      string,
      number
    >,
    followedThreadRootIds: pages.some((page) => page.followedThreadRootIds) ? followed : undefined,
  };
}

/**
 * The newest sequence a page reflects: its newest top-level message, or the newest thread reply a
 * summary reflects when that is later. Replies up to it need not be read again when the
 * reconciler asks what arrived (`ConversationUpdatesCursor.afterReplySequence`); on a busy channel
 * the newest threads hold hundreds of replies past the newest root.
 */
export function newestReflectedSequence(page: {
  messages: readonly { sequence: number }[];
  threads?: Readonly<Record<string, Pick<ThreadSummary, "lastReplySequence">>>;
}): number {
  let newest = page.messages.at(-1)?.sequence ?? 0;
  for (const summary of Object.values(page.threads ?? {}))
    newest = Math.max(newest, summary.lastReplySequence);
  return newest;
}

/** No threads: one object, so a window without any keeps its identity. */
export const NO_THREADS: Readonly<Record<string, ThreadSummary>> = {};
const NO_READS: Readonly<Record<string, number>> = {};
