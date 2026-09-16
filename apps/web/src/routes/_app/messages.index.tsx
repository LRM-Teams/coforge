import { createFileRoute } from "@tanstack/react-router";
import { EmptyConversation } from "@/features/conversations/conversation-layout";

export const Route = createFileRoute("/_app/messages/")({
  // The parent owns the conversation directory and preserves it while chatting.
  component: EmptyConversation,
});
