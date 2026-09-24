import { startOfDay } from "#src/lib/dates";
import type { MessageSearchParams } from "./search.schemas";

export const SEARCH_SCOPES = ["mentioned", "humans", "agents"] as const;
export type SearchScope = (typeof SEARCH_SCOPES)[number];

export const SEARCH_RANGES = ["today", "7d", "30d"] as const;
export type SearchRange = (typeof SEARCH_RANGES)[number];

/** The filters the search page keeps in its URL, next to the query. */
export type SearchFilters = {
  senderId?: string;
  scope?: SearchScope[];
  channelId?: string;
  range?: SearchRange;
  sort?: "recent";
};

export type SenderKind = "user" | "agent";

/** Whether any filter narrows the search; the sort order does not. */
export function hasActiveFilter(filters: SearchFilters): boolean {
  return Boolean(filters.senderId || filters.scope?.length || filters.channelId || filters.range);
}

/** The filters with every narrowing filter removed; the sort order stays. */
export function clearedFilters(filters: SearchFilters): SearchFilters {
  return { sort: filters.sort };
}

export function isSearchScope(value: unknown): value is SearchScope {
  return (SEARCH_SCOPES as readonly unknown[]).includes(value);
}

export function isSearchRange(value: unknown): value is SearchRange {
  return (SEARCH_RANGES as readonly unknown[]).includes(value);
}

/** Scope kept in one order, so the same choice always produces the same URL. */
function orderedScope(scope: Iterable<unknown>): SearchScope[] | undefined {
  const chosen = new Set(scope);
  const ordered = SEARCH_SCOPES.filter((value) => chosen.has(value));
  return ordered.length ? ordered : undefined;
}

/** The scope a URL's comma-separated `scope` names; unknown entries are ignored. */
export function parseScope(value: string | undefined): SearchScope[] | undefined {
  return orderedScope(value?.split(",") ?? []);
}

/** The sender kind a Humans-only or Agents-only scope allows, or undefined when it allows both. */
function scopeSenderKind(scope: readonly SearchScope[] | undefined): SenderKind | undefined {
  const humans = scope?.includes("humans");
  const agents = scope?.includes("agents");
  if (humans === agents) return undefined;
  return humans ? "user" : "agent";
}

/**
 * Chooses a sender (or none). A Humans-only or Agents-only scope that the sender contradicts is
 * dropped, so the two filters never exclude every message together.
 */
export function withSender(
  filters: SearchFilters,
  sender: { id: string; kind: SenderKind } | undefined,
): SearchFilters {
  if (!sender) return { ...filters, senderId: undefined };
  const allowed = scopeSenderKind(filters.scope);
  const scope =
    allowed && allowed !== sender.kind
      ? orderedScope(filters.scope!.filter((value) => value !== "humans" && value !== "agents"))
      : filters.scope;
  return { ...filters, senderId: sender.id, scope };
}

/**
 * Chooses the scope. A chosen sender that the new Humans-only or Agents-only scope contradicts is
 * dropped, for the same reason as in `withSender`. So is a sender whose kind is unknown (one no
 * longer in the Workspace, or not loaded yet): keeping it could leave a search that matches
 * nothing.
 */
export function withScope(
  filters: SearchFilters,
  scope: Iterable<unknown>,
  senderKind: SenderKind | undefined,
): SearchFilters {
  const next = orderedScope(scope);
  const allowed = scopeSenderKind(next);
  const dropSender = Boolean(filters.senderId && allowed && allowed !== senderKind);
  return { ...filters, scope: next, senderId: dropSender ? undefined : filters.senderId };
}

const DAY_MS = 86_400_000;

/**
 * The server request for a query and filters, as of `now`. `now` is fixed for all of one search's
 * pages (see `messageSearchQuery`): it is the `before` bound, so messages posted while paging never
 * shift the offsets, and the start of a time range. "Today" starts at midnight in the viewer's time
 * zone; the 7- and 30-day ranges are rolling.
 */
export function messageSearchParams(
  query: string,
  filters: SearchFilters,
  now: Date,
  timeZone: string | null | undefined,
): Omit<MessageSearchParams, "offset" | "limit"> {
  const after =
    filters.range === "today"
      ? startOfDay(now, timeZone)
      : filters.range === "7d"
        ? new Date(now.getTime() - 7 * DAY_MS)
        : filters.range === "30d"
          ? new Date(now.getTime() - 30 * DAY_MS)
          : undefined;
  return {
    query: query || undefined,
    senderId: filters.senderId,
    senderKind: scopeSenderKind(filters.scope),
    mentionsViewer: filters.scope?.includes("mentioned") || undefined,
    conversationId: filters.channelId,
    after: after?.toISOString(),
    before: now.toISOString(),
    sort: query && filters.sort === "recent" ? "recent" : "relevance",
  };
}
