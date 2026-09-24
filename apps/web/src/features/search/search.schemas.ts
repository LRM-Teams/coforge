import { z } from "zod";

import { SEARCH_RANGES } from "./search-filters";

/** Longest query the search box sends; longer text is cut, never rejected. */
export const SEARCH_QUERY_MAX_LENGTH = 200;

/** Results per page; "Load more" asks for the next page at the current offset. */
export const SEARCH_PAGE_SIZE = 20;

/**
 * One page of Workspace message search. Every filter is optional and applies with or without a
 * query; `relevance` falls back to newest first when there is no query to rank against.
 */
export const messageSearchInputSchema = z.object({
  query: z.string().max(SEARCH_QUERY_MAX_LENGTH).optional(),
  senderId: z.uuid().optional(),
  senderKind: z.enum(["user", "agent"]).optional(),
  mentionsViewer: z.boolean().optional(),
  conversationId: z.uuid().optional(),
  after: z.iso.datetime().optional(),
  before: z.iso.datetime().optional(),
  sort: z.enum(["relevance", "recent"]).default("relevance"),
  offset: z.number().int().min(0).max(10_000).default(0),
  limit: z.number().int().min(1).max(50).default(SEARCH_PAGE_SIZE),
});

export type MessageSearchParams = z.input<typeof messageSearchInputSchema>;

/**
 * The search page's URL fields. Each one falls back to absent when malformed, so a stale or
 * hand-edited address never breaks the page.
 */
export const searchPageSearchSchema = z.object({
  q: z
    .string()
    .transform((value) => value.slice(0, SEARCH_QUERY_MAX_LENGTH))
    .optional()
    .catch(undefined),
  senderId: z.uuid().optional().catch(undefined),
  // Comma-separated (`scope=mentioned,humans`), so the address stays readable.
  scope: z.string().optional().catch(undefined),
  channelId: z.uuid().optional().catch(undefined),
  range: z.enum(SEARCH_RANGES).optional().catch(undefined),
  sort: z.literal("recent").optional().catch(undefined),
  // Set by "Search this channel": the filters wait for a query before searching.
  defer: z.literal("1").optional().catch(undefined),
});

/** The search Cmd/Ctrl+K reopens: the page's fields without the one-off `defer`. */
export const lastSearchSchema = searchPageSearchSchema.omit({ defer: true });
export type LastSearch = z.output<typeof lastSearchSchema>;
