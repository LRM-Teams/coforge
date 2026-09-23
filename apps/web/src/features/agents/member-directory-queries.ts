import { infiniteQueryOptions } from "@tanstack/react-query";

import { MEMBER_PAGE_SIZE } from "@/features/workspaces/member-directory";
import {
  loadMemberAgentPage,
  loadMemberPeoplePage,
} from "@/features/workspaces/workspaces.functions";

export type MemberAgentFilters = {
  owner: "all" | "mine";
  /** A Computer id, `NO_COMPUTER`, or undefined for every Computer. */
  computer?: string;
  query: string;
};

/** Every Members page query; invalidate this after creating, deleting or inviting. */
export const MEMBER_DIRECTORY_KEY = ["member-directory"] as const;

/** The Agent tab: one page per scroll step, restarted whenever a filter or the search changes. */
export const memberAgentsQuery = (filters: MemberAgentFilters) =>
  infiniteQueryOptions({
    queryKey: [...MEMBER_DIRECTORY_KEY, "agents", filters],
    queryFn: ({ pageParam }) =>
      loadMemberAgentPage({ data: { ...filters, cursor: pageParam, limit: MEMBER_PAGE_SIZE } }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });

/** The Collaborators tab, paged the same way. */
export const memberPeopleQuery = (query: string) =>
  infiniteQueryOptions({
    queryKey: [...MEMBER_DIRECTORY_KEY, "people", query],
    queryFn: ({ pageParam }) =>
      loadMemberPeoplePage({ data: { query, cursor: pageParam, limit: MEMBER_PAGE_SIZE } }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
