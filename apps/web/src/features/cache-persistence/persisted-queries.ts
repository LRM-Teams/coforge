import type { QueryKey } from "@tanstack/react-query";

import { CONVERSATION_WINDOW_PAGE_SIZE } from "#src/lib/conversation-window";

/**
 * Which queries the browser keeps between page loads, and how much of each. An allow-list: a query
 * nobody has reviewed for sitting in the browser's storage is not kept, however it is keyed, and
 * every kept query's key names the Workspace or conversation it belongs to (a key that is not
 * scoped by one would let a person's other Workspace show through).
 *
 * What is deliberately not here: Agent Activity, status and presence (volatile), an Agent's
 * environment (secrets), search results, Task and project data, upload sessions, and a message
 * "around" a target (transient). Add a query only after checking its data holds none of those.
 */

type StoredKind =
  | "conversation-window"
  | "sidebar-directs"
  | "sidebar-channels"
  | "channel-names"
  | "saved-messages";

/** How many of the newest saved messages are kept: the list has no bound, and the read that
 * follows a restore brings the rest. */
const SAVED_MESSAGES_KEPT = 100;

/** A Saved list as a read of it holds it (`SavedList`): its entries beside the stream positions
 * it was read at. */
function isSavedList(data: unknown): data is { entries: unknown[] } {
  return (
    typeof data === "object" && data !== null && "entries" in data && Array.isArray(data.entries)
  );
}

/** The kept kind of a Query key (`features/conversations/conversation-query-keys.ts`,
 * `conversation-queries.ts`), or `undefined` for a query that is not kept. */
function storedKindOf(queryKey: QueryKey): StoredKind | undefined {
  const [root, scope, id, list, ...rest] = queryKey;
  if (root === "saved-messages" && typeof scope === "string" && queryKey.length === 2)
    return "saved-messages";
  if (root !== "conversation" || typeof id !== "string" || rest.length > 0) return undefined;
  if ((scope === "channel" || scope === "direct") && list === undefined)
    return "conversation-window";
  if (scope === "channel-names" && list === undefined) return "channel-names";
  if (scope === "sidebar" && list === "directs") return "sidebar-directs";
  if (scope === "sidebar" && list === "channels") return "sidebar-channels";
  return undefined;
}

export function persistsQuery(queryKey: QueryKey): boolean {
  return storedKindOf(queryKey) !== undefined;
}

type ConversationWindow = {
  pages: Array<{
    hasNewer?: boolean;
    hasOlder?: boolean;
    readThroughSequence?: number;
    messages?: unknown[];
    threads?: Readonly<Record<string, unknown>>;
    threadReadThrough?: Readonly<Record<string, number>>;
    followedThreadRootIds?: readonly string[];
  }>;
  pageParams: unknown[];
};

/**
 * The newest page as a first read returns it: its newest `CONVERSATION_WINDOW_PAGE_SIZE` messages,
 * the rest being history to page back into. Realtime merges into the newest page without bound,
 * and a first paint needs one page (Slack's first read of a channel is one page, "enough to fill the
 * view on a large monitor": https://slack.engineering/making-slack-faster-by-being-lazy/).
 */
function asFirstRead<P extends ConversationWindow["pages"][number]>(newest: P): P {
  const { messages } = newest;
  if (!messages || messages.length <= CONVERSATION_WINDOW_PAGE_SIZE) return newest;
  const kept = messages.slice(-CONVERSATION_WINDOW_PAGE_SIZE);
  // A read carries thread state only for the roots on its page; the roots cut here go with theirs,
  // or it would shadow the fresh state of the older page that brings them back.
  const keptIds = new Set(kept.map((message) => (message as { id?: unknown }).id));
  const onlyKept = <V>(byRoot: Readonly<Record<string, V>> | undefined) =>
    byRoot && Object.fromEntries(Object.entries(byRoot).filter(([rootId]) => keptIds.has(rootId)));
  return {
    ...newest,
    messages: kept,
    hasOlder: true,
    ...(newest.threads && { threads: onlyKept(newest.threads) }),
    ...(newest.threadReadThrough && { threadReadThrough: onlyKept(newest.threadReadThrough) }),
    ...(newest.followedThreadRootIds && {
      followedThreadRootIds: newest.followedThreadRootIds.filter((rootId) => keptIds.has(rootId)),
    }),
  };
}

function isConversationWindow(data: unknown): data is ConversationWindow {
  return (
    typeof data === "object" &&
    data !== null &&
    "pages" in data &&
    Array.isArray(data.pages) &&
    "pageParams" in data &&
    Array.isArray(data.pageParams)
  );
}

/**
 * What of a kept query's data goes to storage: the data itself, or `undefined` when this read
 * should not be kept (and an older copy goes with it).
 *
 * A conversation keeps only its newest page, the first paint of opening it. History pages come
 * back when the person scrolls, and a window that is not the live end (a jump to an older message,
 * a window that slid up into history) is not a place to open a conversation at.
 */
export function storedQueryData(queryKey: QueryKey, data: unknown): unknown {
  const kept = firstPaintOf(queryKey, data);
  return kept === undefined ? undefined : withoutExpiringUrls(kept);
}

/**
 * Keys whose value is a signed URL that expires long before a kept copy does: an attachment's CDN
 * preview lives 30 minutes (`FILE_DELIVERY_TTL_SECONDS`). Kept, a restore would paint it dead and
 * the row would stay on its fallback; dropped, the row shows the attachment through the
 * authenticated route until the read that follows the restore brings a fresh one.
 */
const EXPIRING_URL_KEYS = new Set(["previewUrl"]);

function withoutExpiringUrls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutExpiringUrls);
  if (typeof value !== "object" || value === null) return value;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !EXPIRING_URL_KEYS.has(key))
      .map(([key, field]) => [key, withoutExpiringUrls(field)]),
  );
}

function firstPaintOf(queryKey: QueryKey, data: unknown): unknown {
  switch (storedKindOf(queryKey)) {
    case "conversation-window": {
      if (!isConversationWindow(data)) return undefined;
      const newest = data.pages.at(-1);
      // The newest page of a window is the live end only when it was read as the first page.
      if (!newest || newest.hasNewer || data.pageParams.at(-1) !== undefined) return undefined;
      return { pages: [asFirstRead(newest)], pageParams: [undefined] };
    }
    case "sidebar-directs":
      // A read that fell back per call holds rows without their pins or badges and no viewer id:
      // the page re-reads it, and so must not open from it.
      return typeof data === "object" && data !== null && "partial" in data && data.partial
        ? undefined
        : data;
    case "saved-messages":
      // Cut to the newest entries, so it is not the whole list and keeps no position claiming it.
      return isSavedList(data)
        ? { streamPositions: {}, entries: data.entries.slice(0, SAVED_MESSAGES_KEPT) }
        : undefined;
    case "sidebar-channels":
    case "channel-names":
      return data;
    case undefined:
      return undefined;
  }
}

/**
 * A kept conversation window with its read cursor moved to `throughSequence`: the server's cursor
 * moved there while the page kept the window's own (the pane freezes its unread divider for the
 * visit). It never moves back, and a window without a cursor (a non-member's) keeps none.
 */
export function withReadThrough(queryKey: QueryKey, data: unknown, throughSequence: number) {
  if (storedKindOf(queryKey) !== "conversation-window" || !isConversationWindow(data)) return data;
  const behind = (page: ConversationWindow["pages"][number]) =>
    page.readThroughSequence !== undefined && page.readThroughSequence < throughSequence;
  if (!data.pages.some(behind)) return data;
  return {
    ...data,
    pages: data.pages.map((page) =>
      behind(page) ? { ...page, readThroughSequence: throughSequence } : page,
    ),
  };
}
