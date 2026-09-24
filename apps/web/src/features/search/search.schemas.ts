import { z } from "zod";

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
