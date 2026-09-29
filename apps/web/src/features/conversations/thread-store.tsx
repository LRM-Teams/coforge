import { useMemo, type ReactNode } from "react";
import { createStoreContext, useSelector, type Store } from "@tanstack/react-store";

import { useSyncedStore } from "#src/hooks/use-synced-store";

import type { ThreadSummary } from "./thread-summary-model";

/**
 * What a conversation knows about its threads, for the summary under each root: each thread's
 * summary (`thread-summary-model.ts`, from the window's pages) and how a reply's body reads in a
 * one-line preview. A root's summary reads its own slice by root id, so a change to one thread
 * re-renders that root's summary and no other row.
 */
export type ThreadState = {
  summaries: Readonly<Record<string, ThreadSummary>>;
  formatBody: (body: string) => string;
};

const { StoreProvider, useStoreContext } = createStoreContext<{ threads: Store<ThreadState> }>();

/** The conversation's thread store, following what its owner knows (`useSyncedStore`). */
export function useConversationThreadStore(state: ThreadState): Store<ThreadState> {
  return useSyncedStore(state);
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

/** A root's thread summary, re-rendering only when that root's summary changes; `undefined` for a
 * root with no replies. */
export function useThreadSummary(rootId: string) {
  const { threads } = useStoreContext();
  return useSelector(threads, (state) => state.summaries[rootId]);
}

/** A root's unread Agent replies, re-rendering only when that count changes. */
export function useThreadUnread(rootId: string) {
  const { threads } = useStoreContext();
  return useSelector(threads, (state) => state.summaries[rootId]?.unread ?? 0);
}

/** How a reply's body reads in a one-line preview. */
export function useThreadBodyFormat() {
  const { threads } = useStoreContext();
  return useSelector(threads, (state) => state.formatBody);
}
