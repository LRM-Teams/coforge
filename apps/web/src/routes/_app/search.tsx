import { useCallback, useEffect, useMemo } from "react";
import { createFileRoute, getRouteApi, useNavigate } from "@tanstack/react-router";

import { ConversationViewerProvider } from "#src/features/conversations/conversation-navigation";
import {
  directConversationQuery,
  ensureConversationWindow,
  publicChannelQuery,
} from "#src/features/conversations/conversation-queries";
import { savedMessagesQueryKey } from "#src/features/conversations/saved-messages-collection";
import { listSavedMessages } from "#src/features/conversations/saved-messages.functions";
import { parseScope, type SearchFilters } from "#src/features/search/search-filters";
import { writeLastSearch } from "#src/features/search/search-memory";
import { SearchPage } from "#src/features/search/search-page";
import type { SearchPreviewTarget } from "#src/features/search/search-preview";
import { searchPageSearchSchema } from "#src/features/search/search.schemas";

const appRoute = getRouteApi("/_app");

export const Route = createFileRoute("/_app/search")({
  validateSearch: searchPageSearchSchema,
  loaderDeps: ({ search }) => ({ open: search.open, msg: search.msg }),
  loader: async ({ context: { queryClient }, parentMatchPromise, deps }) => {
    // The previewed conversation opens as a Chat route opens it: its window around the result is
    // read first. A failed read is left to the preview, which says so; search stays up.
    const [kind, id] = deps.open?.split(":") ?? [];
    const window = !id
      ? undefined
      : kind === "channel"
        ? ensureConversationWindow(queryClient, publicChannelQuery(id).query, deps.msg)
        : kind === "agent"
          ? ensureConversationWindow(queryClient, directConversationQuery(id).query, deps.msg)
          : undefined;
    // The previewed conversation shows the viewer's Saved stars as Chat does; the list Chat
    // already read is reused. A failed read leaves an empty Saved list, as in Chat.
    const saved = parentMatchPromise
      .then((parent) =>
        queryClient.ensureQueryData({
          queryKey: savedMessagesQueryKey(parent.loaderData?.currentWorkspace?.id ?? ""),
          queryFn: () => listSavedMessages(),
        }),
      )
      .catch(() => []);
    const [savedList] = await Promise.all([saved, window?.catch(() => undefined)]);
    return savedList;
  },
  component: SearchRoute,
});

function SearchRoute() {
  const { q, senderId, scope, channelId, range, sort, defer, open, msg } = Route.useSearch();
  const { currentWorkspace, timeZone, user } = appRoute.useLoaderData();
  const workspaceId = currentWorkspace?.id;
  // The search as the URL holds it becomes the last search, for Cmd/Ctrl+K to reopen.
  useEffect(() => {
    if (workspaceId)
      writeLastSearch(workspaceId, user.id, { q, senderId, scope, channelId, range, sort });
  }, [workspaceId, user.id, q, senderId, scope, channelId, range, sort]);
  const navigate = useNavigate({ from: Route.fullPath });
  const filters = useMemo<SearchFilters>(
    () => ({ senderId, scope: parseScope(scope), channelId, range, sort }),
    [senderId, scope, channelId, range, sort],
  );
  // Typing replaces the entry instead of stacking one history step per pause.
  const onQueryChange = useCallback(
    (next: string) =>
      void navigate({
        search: (previous) => ({ ...previous, q: next.trim() ? next : undefined }),
        replace: true,
      }),
    [navigate],
  );
  // A filter change is a step Back can undo.
  const onFiltersChange = useCallback(
    (next: SearchFilters) =>
      void navigate({
        search: (previous) => ({
          q: previous.q,
          senderId: next.senderId,
          scope: next.scope?.join(","),
          channelId: next.channelId,
          range: next.range,
          sort: next.sort,
        }),
      }),
    [navigate],
  );
  // The preview lives in the URL, so a reload or a shared link reopens it; switching it replaces
  // the entry rather than stacking history. Only the search's own fields carry over: the previous
  // conversation's tab, board view, thread, Task popup and Agent profile close with it, and a
  // thread reply opens its thread, as Chat opens one.
  const preview = useMemo<SearchPreviewTarget | undefined>(() => {
    const [kind, id] = open?.split(":") ?? [];
    return (kind === "channel" || kind === "agent") && id
      ? { kind, id, messageId: msg }
      : undefined;
  }, [open, msg]);
  const onPreviewChange = useCallback(
    (next: SearchPreviewTarget | undefined) =>
      void navigate({
        search: ({ q, senderId, scope, channelId, range, sort, defer }) => ({
          q,
          senderId,
          scope,
          channelId,
          range,
          sort,
          defer,
          open: next ? `${next.kind}:${next.id}` : undefined,
          msg: next?.messageId,
          threadRootId: next?.threadRootId,
        }),
        replace: true,
      }),
    [navigate],
  );
  const saved = Route.useLoaderData();
  if (!currentWorkspace) return null;
  return (
    <ConversationViewerProvider saved={saved}>
      <SearchPage
        workspaceId={currentWorkspace.id}
        viewerId={user.id}
        deferred={defer === "1"}
        timeZone={timeZone}
        query={q ?? ""}
        filters={filters}
        onQueryChange={onQueryChange}
        onFiltersChange={onFiltersChange}
        preview={preview}
        onPreviewChange={onPreviewChange}
      />
    </ConversationViewerProvider>
  );
}
