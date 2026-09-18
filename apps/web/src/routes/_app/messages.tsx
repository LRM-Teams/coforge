import { Outlet, createFileRoute } from "@tanstack/react-router";

import { MessagesPending } from "@/features/conversations/conversation-pending";
import { ConversationNavigation } from "@/features/conversations/conversation-navigation";
import { PageLoadError } from "@/features/errors/page-load-error";
import { listPublicChannels } from "@/features/conversations/channels.functions";
import {
  loadDirectConversationBadges,
  type DirectConversationBadges,
} from "@/features/conversations/conversations.functions";
import { listProjects } from "@/features/projects/projects.functions";

const EMPTY_DIRECT_BADGES: DirectConversationBadges = { viewerId: "", unread: {} };

export const Route = createFileRoute("/_app/messages")({
  loader: async () => {
    const [channels, projects, badges] = await Promise.all([
      listPublicChannels(),
      listProjects(),
      loadDirectConversationBadges().catch(() => EMPTY_DIRECT_BADGES),
    ]);
    return {
      channels,
      projects,
      directUnread: badges.unread,
      // Absent when the badge read failed: the sidebar then holds no personal signal channel
      // rather than subscribing to one keyed by an empty id.
      viewerId: badges.viewerId || undefined,
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
