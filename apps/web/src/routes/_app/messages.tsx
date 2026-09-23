import { Outlet, createFileRoute } from "@tanstack/react-router";

import { MessagesPending } from "#src/features/conversations/conversation-pending";
import { ConversationNavigation } from "#src/features/conversations/conversation-navigation";
import { PageLoadError } from "#src/features/errors/page-load-error";
import { listPublicChannels } from "#src/features/conversations/channels.functions";
import {
  loadDirectConversationBadges,
  loadDirectConversationPreferences,
  type DirectConversationBadges,
} from "#src/features/conversations/conversations.functions";
import { listProjects } from "#src/features/projects/projects.functions";
import { listSavedMessages } from "#src/features/conversations/saved-messages.functions";

const EMPTY_DIRECT_BADGES: DirectConversationBadges = { viewerId: "", unread: {} };

/** The sidebar's DM preferences, absent when their read failed: the DM rows then render as plain
 * Agent rows (no menu, no pin order) rather than the page failing to load. */
type DirectConversationPreferences = Awaited<ReturnType<typeof loadDirectConversationPreferences>>;
const EMPTY_DIRECT_PREFERENCES: DirectConversationPreferences = {
  conversations: [],
  pinned: [],
  hidden: [],
};

export const Route = createFileRoute("/_app/messages")({
  loader: async () => {
    const [channels, projects, badges, saved, directPreferences] = await Promise.all([
      listPublicChannels(),
      listProjects(),
      loadDirectConversationBadges().catch(() => EMPTY_DIRECT_BADGES),
      // Saved (#127) tolerates a failed read the way the badges do: the chat page stays up and
      // simply starts from an empty saved list.
      listSavedMessages().catch(() => []),
      loadDirectConversationPreferences().catch(() => EMPTY_DIRECT_PREFERENCES),
    ]);
    return {
      channels,
      projects,
      directUnread: badges.unread,
      directPreferences,
      // Absent when the badge read failed: the sidebar then holds no personal signal channel
      // rather than subscribing to one keyed by an empty id.
      viewerId: badges.viewerId || undefined,
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
