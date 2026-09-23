import { createFileRoute } from "@tanstack/react-router";

import { SavedMessagesView } from "@/features/conversations/saved-messages-view";

// The Saved view lives in the Chat detail pane; the parent layout owns the directory around it.
export const Route = createFileRoute("/_app/messages/saved")({
  component: SavedMessagesView,
});
