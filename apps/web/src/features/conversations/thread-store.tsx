import { useLayoutEffect, useMemo, type ReactNode } from "react";
import { createStoreContext, useCreateStore, useSelector, type Store } from "@tanstack/react-store";

import type { DirectConversationView } from "./conversation-types";

export type ThreadMessage = DirectConversationView["messages"][number];

/**
 * What a conversation knows about its threads, for the summary under each root: the replies by
 * root (a root whose replies did not change keeps its list), the read cursors, and how a reply's
 * body reads in a one-line preview. A root's summary reads its own slice by root id, so a change
 * to one thread re-renders that root's summary and no other row.
 */
export type ThreadState = {
  replies: ReadonlyMap<string, readonly ThreadMessage[]>;
  /** The stored `thread_reads` cursors, by root. */
  persistedReads?: Readonly<Record<string, number>>;
  /** What this visit has marked read since, by root. */
  localReads: Readonly<Record<string, number>>;
  formatBody: (body: string) => string;
};

const NO_REPLIES: readonly ThreadMessage[] = [];

/** A root's replies, or one shared empty list, so a selection of a root with none never changes. */
export function threadReplies(state: ThreadState, rootId: string): readonly ThreadMessage[] {
  return state.replies.get(rootId) ?? NO_REPLIES;
}

/**
 * A thread's read cursor: the stored `thread_reads` row, raised by any mark-read this visit has
 * already performed. `undefined` means the viewer has never read the thread: the thread pane then
 * opens without an unread divider (opening a long thread for the first time should not bury the
 * conversation that was just clicked into), while the root's summary counts every Agent reply as
 * unread (`unreadAgentReplies`).
 */
export function threadReadThrough(
  reads: Pick<ThreadState, "persistedReads" | "localReads">,
  rootId: string,
): number | undefined {
  const local = reads.localReads[rootId];
  const persisted = reads.persistedReads?.[rootId];
  if (local === undefined && persisted === undefined) return undefined;
  return Math.max(local ?? 0, persisted ?? 0);
}

/** The Agents' replies past the cursor; for a thread never read, every one of them. */
export function unreadAgentReplies(
  replies: readonly ThreadMessage[],
  readThrough: number | undefined,
): number {
  const boundary = readThrough ?? 0;
  return replies.filter((reply) => reply.senderKind === "agent" && reply.sequence > boundary)
    .length;
}

const { StoreProvider, useStoreContext } = createStoreContext<{ threads: Store<ThreadState> }>();

/**
 * The conversation's thread store, created from what its owner knows on the first render (so no
 * summary ever renders from an empty store) and kept in step with it before paint.
 */
export function useConversationThreadStore(state: ThreadState): Store<ThreadState> {
  const threads = useCreateStore(state);
  useLayoutEffect(() => {
    threads.setState(() => state);
  }, [threads, state]);
  return threads;
}

/** Gives the thread summaries below it their conversation's thread store. */
export function ThreadStoreProvider({
  store,
  children,
}: {
  store: Store<ThreadState>;
  children: ReactNode;
}) {
  const value = useMemo(() => ({ threads: store }), [store]);
  return <StoreProvider value={value}>{children}</StoreProvider>;
}

/** A root's replies, re-rendering only when that root's replies change. */
export function useThreadReplies(rootId: string) {
  const { threads } = useStoreContext();
  return useSelector(threads, (state) => threadReplies(state, rootId));
}

/** A root's unread Agent replies, re-rendering only when that count changes. */
export function useThreadUnread(rootId: string) {
  const { threads } = useStoreContext();
  return useSelector(threads, (state) =>
    unreadAgentReplies(threadReplies(state, rootId), threadReadThrough(state, rootId)),
  );
}

/** How a reply's body reads in a one-line preview. */
export function useThreadBodyFormat() {
  const { threads } = useStoreContext();
  return useSelector(threads, (state) => state.formatBody);
}
