import { createFileRoute, redirect } from "@tanstack/react-router";

import { EmptyConversation } from "@/features/conversations/conversation-layout";

export const Route = createFileRoute("/_app/messages/")({
  loader: async ({ parentMatchPromise }) => {
    const { loaderData: agents } = await parentMatchPromise;
    if (!agents) return;
    if (agents[0]) {
      throw redirect({ to: "/messages/$agentId", params: { agentId: agents[0].id } });
    }
  },
  component: MessagesIndexPage,
});

function MessagesIndexPage() {
  return <EmptyConversation />;
}
