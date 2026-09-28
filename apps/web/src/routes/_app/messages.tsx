import { Outlet, createFileRoute } from "@tanstack/react-router";

import { MessagesPending } from "#src/features/conversations/conversation-pending";
import { ConversationNavigation } from "#src/features/conversations/conversation-navigation";
import { PageLoadError } from "#src/features/errors/page-load-error";
import { listChannelNames } from "#src/features/conversations/channels.functions";
import {
  sidebarChannelsQuery,
  sidebarDirectsQuery,
} from "#src/features/conversations/sidebar-collections";
import { listProjects } from "#src/features/projects/projects.functions";
import { savedMessagesQuery } from "#src/features/conversations/conversation-queries";

export const Route = createFileRoute("/_app/messages")({
  loader: async ({ context: { queryClient }, parentMatchPromise, cause }) => {
    // The sidebar's channel and DM lists go into the Query cache, which the server render reads and
    // the client hydrates; after hydration they back the sidebar's collections
    // (`sidebar-collections.ts`). A navigation or an invalidation (joining, leaving, closing a
    // chat) reads them afresh; a hover preload reuses what is cached.
    const workspaceId = parentMatchPromise.then(
      (parent) => parent.loaderData?.currentWorkspace?.id ?? "",
    );
    const sidebarLists = workspaceId.then(async (workspaceId) => {
      const staleTime = cause === "preload" ? ("static" as const) : 0;
      // A first load has no DM rows to keep, so each of its reads falls back on its own; a later
      // one that fails keeps the rows the sidebar has.
      const firstLoad =
        queryClient.getQueryData(sidebarDirectsQuery(workspaceId).queryKey) === undefined;
      const directs = queryClient.query({
        ...sidebarDirectsQuery(workspaceId, { tolerant: firstLoad }),
        staleTime,
      });
      await Promise.all([
        queryClient.query({ ...sidebarChannelsQuery(workspaceId), staleTime }),
        firstLoad ? directs : directs.catch(() => undefined),
      ]);
    });
    // Saved (#127) goes into the Query cache the Saved collection follows, read afresh like the
    // sidebar's lists. A failed read keeps the list the cache has, or starts from an empty one: the
    // chat page stays up and saving still works.
    const saved = workspaceId.then((workspaceId) => {
      const query = savedMessagesQuery(workspaceId);
      return queryClient
        .query({ ...query, staleTime: cause === "preload" ? ("static" as const) : 0 })
        .catch(() => {
          if (queryClient.getQueryData(query.queryKey) === undefined)
            queryClient.setQueryData(query.queryKey, []);
        });
    });
    const [channelNames, projects, , , currentWorkspaceId] = await Promise.all([
      listChannelNames(),
      listProjects(),
      saved,
      sidebarLists,
      workspaceId,
    ]);
    return {
      // Keys the conversation pages' Workspace-scoped reads (a Tasks tab's finished counts).
      workspaceId: currentWorkspaceId,
      // Every channel by id, closed ones included: the authority a body's channel links check.
      channelNames,
      projects,
    };
  },
  pendingComponent: MessagesPending,
  errorComponent: PageLoadError,
  component: MessagesPage,
});

function MessagesPage() {
  return (
    <ConversationNavigation>
      <Outlet />
    </ConversationNavigation>
  );
}
