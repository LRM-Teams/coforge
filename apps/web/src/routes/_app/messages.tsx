import { Outlet, createFileRoute, useParams } from "@tanstack/react-router";

import { listAgents } from "@/features/agents/agents.functions";
import { ConversationLayout } from "@/features/conversations/conversation-layout";

export const Route = createFileRoute("/_app/messages")({
  loader: () => listAgents(),
  component: MessagesPage,
});

function MessagesPage() {
  const agents = Route.useLoaderData();
  const params = useParams({ from: "/_app/messages/$agentId", shouldThrow: false });
  return (
    <ConversationLayout agents={agents} selectedAgentId={params?.agentId}>
      <Outlet />
    </ConversationLayout>
  );
}
