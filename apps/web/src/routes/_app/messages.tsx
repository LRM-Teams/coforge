import { Outlet, createFileRoute } from "@tanstack/react-router";

import { MessagesPending } from "#src/features/conversations/conversation-pending";
import { ConversationNavigation } from "#src/features/conversations/conversation-navigation";
import { PageLoadError } from "#src/features/errors/page-load-error";
import { listChannelNames } from "#src/features/conversations/channels.functions";
import {
  sidebarChannelsQuery,
  sidebarDirectsQuery,
} from "#src/features/conversations/sidebar-lists";
import { listProjects } from "#src/features/projects/projects.functions";
import { listSavedMessages } from "#src/features/conversations/saved-messages.functions";

export const Route = createFileRoute("/_app/messages")({
  loader: async ({ context: { queryClient }, parentMatchPromise }) => {
    const workspaceId = (await parentMatchPromise).loaderData?.currentWorkspace?.id ?? "";
    const [channelNames, projects, saved] = await Promise.all([
      listChannelNames(),
      listProjects(),
      // Saved (#127) tolerates a failed read: the chat page stays up and simply starts from an
      // empty saved list.
      listSavedMessages().catch(() => []),
      // The sidebar's channel and DM lists go into the Query cache, which the server render reads
      // and the client hydrates; after hydration they back the sidebar's collections
      // (`sidebar-lists.ts`). Read afresh on every load, as the rest of this loader is, so an
      // invalidation after joining, leaving or closing a chat still refreshes them.
      queryClient.fetchQuery({ ...sidebarChannelsQuery(workspaceId), staleTime: 0 }),
      queryClient.fetchQuery({ ...sidebarDirectsQuery(workspaceId), staleTime: 0 }),
    ]);
    return {
      // Every channel by id, closed ones included: the authority a body's channel links check.
      channelNames,
      projects,
      saved,
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
