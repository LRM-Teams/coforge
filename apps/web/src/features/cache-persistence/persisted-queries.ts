import type { QueryKey } from "@tanstack/react-query";

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
  pages: Array<{ hasNewer?: boolean }>;
  pageParams: unknown[];
};

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
      return { pages: [newest], pageParams: [undefined] };
    }
    case "sidebar-directs":
      // A read that fell back per call holds rows without their pins or badges and no viewer id:
      // the page re-reads it, and so must not open from it.
      return typeof data === "object" && data !== null && "partial" in data && data.partial
        ? undefined
        : data;
    case "saved-messages":
      return Array.isArray(data) ? data.slice(0, SAVED_MESSAGES_KEPT) : undefined;
    case "sidebar-channels":
    case "channel-names":
      return data;
    case undefined:
      return undefined;
  }
}
