import { createFileRoute, redirect } from "@tanstack/react-router";

import { EmptyConversation } from "@/features/conversations/conversation-layout";
import { listPublicChannels } from "@/features/conversations/channels.functions";

export const Route = createFileRoute("/_app/messages/")({
  // There's no standalone "Messages" nav destination any more (channels and
  // DMs live in the sidebar), so landing here — e.g. a bookmarked /messages
  // link — sends the viewer straight into their first joined channel instead
  // of an empty page they'd have to click out of.
  beforeLoad: async () => {
    const channels = await listPublicChannels();
    const joined = channels.find((channel) => channel.joined);
    if (joined) {
      throw redirect({
        to: "/messages/channels/$channelId",
        params: { channelId: joined.id },
      });
    }
  },
  component: MessagesIndexPage,
});

function MessagesIndexPage() {
  return <EmptyConversation />;
}
