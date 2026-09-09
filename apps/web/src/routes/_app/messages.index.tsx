import { useEffect } from "react";
import { createFileRoute, getRouteApi } from "@tanstack/react-router";

import { EmptyConversation } from "@/features/conversations/conversation-layout";

const messagesRoute = getRouteApi("/_app/messages");

export const Route = createFileRoute("/_app/messages/")({
  component: MessagesIndexPage,
});

function MessagesIndexPage() {
  const { agents, channels } = messagesRoute.useLoaderData();
  const navigate = Route.useNavigate();
  const agentId = agents[0]?.id;
  const channelId = channels[0]?.id;
  useEffect(() => {
    // Mobile starts with the list. Desktop retains its initial selection.
    const desktop = window.matchMedia("(min-width: 768px)");
    const selectFirst = () => {
      if (!desktop.matches) return;
      if (agentId) {
        void navigate({ to: "/messages/$agentId", params: { agentId }, replace: true });
      } else if (channelId) {
        void navigate({
          to: "/messages/channels/$channelId",
          params: { channelId },
          replace: true,
        });
      }
    };
    selectFirst();
    desktop.addEventListener("change", selectFirst);
    return () => desktop.removeEventListener("change", selectFirst);
  }, [agentId, channelId, navigate]);
  return <EmptyConversation />;
}
