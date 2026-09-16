import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/messages/")({
  // The parent owns the conversation directory and preserves it while chatting.
  component: () => null,
});
