/**
 * The bounded loading window for a conversation's message stream.
 *
 * The stream is a TanStack infinite query whose pages grow backwards from the live end
 * (`getPreviousPageParam` pages up into history). Left alone the loaded window grows with every
 * page of history read, and since #503 renders every loaded row in normal flow, the DOM grows with
 * it. Two things bound it:
 *
 * - `maxPages` caps how many pages the query retains. `@tanstack/query-core`'s `addToStart` /
 *   `addToEnd` drop the page at the far end from the fetch, so paging up into history discards the
 *   newest retained page and paging back down discards the oldest. See
 *   https://tanstack.com/query/latest/docs/framework/react/guides/infinite-queries.
 * - Every page reports an honest `hasNewer` for the direction it was fetched in, so the retained
 *   newest page can say whether newer content above it is missing (`windowPageFlags`). Without it
 *   the reconciler would fold realtime messages into a page that is no longer the live tail, and
 *   the "back to latest" affordance could not tell there was a tail to fetch.
 *
 * The window is two-way: `getNextPageParam` derives the forward cursor from the retained newest
 * page, so the bottom sentinel can fetch the tail back once history above has pushed it out.
 */

/**
 * Pages the query keeps at once. The server's page size is `CONVERSATION_WINDOW_PAGE_SIZE`, so the
 * loaded window holds at most 100 top-level rows (plus their thread replies) — about eight screenfuls
 * on the staging channel, where a real message row is roughly 130 DOM nodes. That is enough to scroll
 * a conversation for a while without re-fetching, and small enough that the DOM node count stays flat
 * however far back the reader goes. Changing either constant moves the window size; keep the
 * derivation honest if you do.
 */
export const CONVERSATION_WINDOW_MAX_PAGES = 5;

/** Top-level messages a page asks the server for; the server caps a page at 100. */
export const CONVERSATION_WINDOW_PAGE_SIZE = 20;

/** A page's fetch direction: `before` reads history upwards, `after` reads towards the live end.
 * `undefined` is the initial (uncursored) fetch, which lands on the newest page. */
export type ConversationWindowCursor = { before?: number; after?: number } | undefined;

type Sequenced = { sequence: number; threadRootId?: string };

/**
 * The newest **top-level** sequence in a page: the cursor a forward fetch continues from.
 *
 * The server pages by roots (`threadRootId: null`) while a page also carries each root's replies,
 * so the page's last message can be a reply. A reply's sequence is newer than its root's and can be
 * newer than the next root this page did not fetch — a cursor taken from it (the last message,
 * whatever it is) would ask for `sequence > replySequence` and **skip every root in between**,
 * leaving a hole in the stream (old and new messages adjacent, the middle gone). Scan back to the
 * newest root instead. Pages are delivered oldest-first, so the newest root is the last root.
 */
export function newestRootSequence(messages: readonly Sequenced[]): number | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (!message.threadRootId) return message.sequence;
  }
  return undefined;
}

/** The backward page to fetch when paging up into history, or `undefined` at the start of it. */
export function previousPageCursor(
  page: { hasOlder: boolean },
  oldestSequence: number | undefined,
): ConversationWindowCursor {
  return page.hasOlder && oldestSequence !== undefined ? { before: oldestSequence } : undefined;
}

/** The forward page to fetch when paging down towards the live end, or `undefined` at the tail. */
export function nextPageCursor(
  page: { hasNewer?: boolean },
  newest: number | undefined,
): ConversationWindowCursor {
  return page.hasNewer && newest !== undefined ? { after: newest } : undefined;
}

/**
 * The flags a browser page reports, given the direction it was fetched in and whether the server
 * held one more row than the page could take (`overflow`):
 *
 * - `initial`: the newest page, with nothing above it — `hasNewer` false (this is the live tail).
 * - `backward`: read with a `beforeSequence` cursor, so newer content is always above it —
 *   `hasNewer` true even when the fetch itself did not overflow.
 * - `forward`: read with an `afterSequence` cursor, which only happens while older pages are still
 *   held, so `hasOlder` is true; it reaches the tail only when the fetch did not overflow.
 */
export function windowPageFlags(
  direction: "initial" | "backward" | "forward",
  overflow: boolean,
): { hasOlder: boolean; hasNewer: boolean } {
  switch (direction) {
    case "initial":
      return { hasOlder: overflow, hasNewer: false };
    case "backward":
      return { hasOlder: overflow, hasNewer: true };
    case "forward":
      return { hasOlder: true, hasNewer: overflow };
  }
}

type MergeMessages<M> = (base: readonly M[], incoming: readonly M[]) => M[];

/** Where a realtime update lands: folded into the newest page, or buffered until it is the tail. */
export type WindowUpdateFold<M> = { messages: M[] | undefined; pending: M[] };

/**
 * Fold a realtime update into a bounded window's newest page. When that page is not the live tail
 * (`hasNewer`), the update is buffered instead: dropping it would lose a reply to a root that is
 * still retained, because the forward page loader only fetches roots after its cursor and would
 * never fetch that reply. `merge` is the caller's page merge (de-duplicating by id, ordered by
 * sequence), passed in so this stays a pure decision with no dependency of its own.
 */
export function foldWindowUpdates<M extends { id: string; sequence: number }>(
  latestPage: { hasNewer?: boolean; messages: M[] } | undefined,
  pending: readonly M[],
  updates: readonly M[],
  merge: MergeMessages<M>,
): WindowUpdateFold<M> | undefined {
  if (!latestPage) return undefined;
  if (latestPage.hasNewer) return { messages: undefined, pending: merge(pending, updates) };
  return { messages: merge(latestPage.messages, [...pending, ...updates]), pending: [] };
}

/** The buffered updates to merge once the newest page is the tail again, or `undefined` while it is
 * not (more forward pages remain) or there is nothing buffered. */
export function flushWindowUpdates<M extends { id: string; sequence: number }>(
  latestPage: { hasNewer?: boolean; messages: M[] } | undefined,
  pending: readonly M[],
  merge: MergeMessages<M>,
): M[] | undefined {
  if (!latestPage || latestPage.hasNewer || pending.length === 0) return undefined;
  return merge(latestPage.messages, pending);
}
