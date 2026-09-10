import { createFileRoute } from "@tanstack/react-router";

import { EmptyConversation } from "@/features/conversations/conversation-layout";

export const Route = createFileRoute("/_app/messages/")({
  component: MessagesIndexPage,
});

function MessagesIndexPage() {
  return <EmptyConversation />;
}
