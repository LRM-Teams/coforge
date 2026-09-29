import { createFileRoute } from "@tanstack/react-router";
import { EmptyConversation } from "#src/features/conversations/conversation-layout";

export const Route = createFileRoute("/w/$workspaceSlug/_chat/")({
  // The parent owns the conversation directory and preserves it while chatting.
  component: EmptyConversation,
});
