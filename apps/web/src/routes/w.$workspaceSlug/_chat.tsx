import { Outlet, createFileRoute } from "@tanstack/react-router";

import { MessagesPending } from "#src/features/conversations/conversation-pending";
import { ConversationNavigation } from "#src/features/conversations/conversation-navigation";
import { PageLoadError } from "#src/features/errors/page-load-error";
import {
  channelNamesBehind,
  chatListStaleTime,
  loadSidebarLists,
  sidebarChannelsQuery,
} from "#src/features/conversations/sidebar-collections";
import {
  channelNamesQuery,
  savedMessagesQuery,
} from "#src/features/conversations/conversation-queries";

export const Route = createFileRoute("/w/$workspaceSlug/_chat")({
  loader: async ({ context: { queryClient }, parentMatchPromise, cause }) => {
    // The sidebar's channel and DM lists go into the Query cache, which the server render reads and
    // the client hydrates; after hydration they back the sidebar's collections
    // (`sidebar-collections.ts`). Realtime keeps them live, so a navigation inside Chat reads only
    // a list not cached or marked stale (`chatListStaleTime`).
    const workspaceId = parentMatchPromise.then(
      (parent) => parent.loaderData?.currentWorkspace?.id ?? "",
    );
    const sidebarLists = workspaceId.then((workspaceId) =>
      loadSidebarLists(queryClient, workspaceId, cause),
    );
    // Saved (#127) goes into the Query cache the Saved collection follows, read like the sidebar's
    // lists. A failed read keeps the list the cache has, or starts from an empty one: the chat page
    // stays up and saving still works.
    const saved = workspaceId.then((workspaceId) => {
      const query = savedMessagesQuery(workspaceId);
      return queryClient.query({ ...query, staleTime: chatListStaleTime(cause) }).catch(() => {
        if (queryClient.getQueryData(query.queryKey) !== undefined) return;
        // Stale at once, so the next navigation reads it rather than keep the stand-in.
        queryClient.setQueryData(query.queryKey, []);
        return queryClient.invalidateQueries({ queryKey: query.queryKey, refetchType: "none" });
      });
    });
    // Every channel by id, closed ones included: the authority a body's channel links check. The
    // Query cache keeps it across navigations; `channel.created.v1` and `channel.updated.v1`
    // are written into it (`useApplyChannelSignal`). A page that was away from Chat heard neither, so
    // names behind the channel list just read are read again.
    const channelNames = workspaceId.then(async (workspaceId) => {
      const query = channelNamesQuery(workspaceId);
      const [names] = await Promise.all([queryClient.ensureQueryData(query), sidebarLists]);
      const channels = queryClient.getQueryData(sidebarChannelsQuery(workspaceId).queryKey);
      if (channels && channelNamesBehind(names, channels.rows))
        await queryClient.fetchQuery({ ...query, staleTime: 0 });
    });
    const [, , , currentWorkspaceId] = await Promise.all([
      channelNames,
      saved,
      sidebarLists,
      workspaceId,
    ]);
    // Keys the conversation pages' Workspace-scoped reads (a Tasks tab's finished counts).
    return { workspaceId: currentWorkspaceId };
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
