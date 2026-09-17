import { Outlet, createFileRoute } from "@tanstack/react-router";

import { MessagesPending } from "@/features/conversations/conversation-pending";
import { ConversationNavigation } from "@/features/conversations/conversation-navigation";
import { PageLoadError } from "@/features/errors/page-load-error";
import {
  listPublicChannels,
  loadChannelManagementRole,
} from "@/features/conversations/channels.functions";
import { listProjects } from "@/features/projects/projects.functions";

export const Route = createFileRoute("/_app/messages")({
  loader: async () => {
    const [channels, projects, role] = await Promise.all([
      listPublicChannels(),
      listProjects(),
      loadChannelManagementRole(),
    ]);
    return {
      channels,
      projects,
      canManageChannels: role.canManageChannels,
    };
  },
  pendingMs: 300,
  pendingMinMs: 0,
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
