import { Outlet, createFileRoute, getRouteApi, useParams } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";

import { getAgentStatusConnectionToken, listAgents } from "@/features/agents/agents.functions";
import { useAgentStatuses } from "@/features/agents/agent-status-realtime";
import { ConversationLayout } from "@/features/conversations/conversation-layout";
import { PageLoadError } from "@/features/errors/page-load-error";

const appRoute = getRouteApi("/_app");

export const Route = createFileRoute("/_app/messages")({
  loader: () => listAgents(),
  errorComponent: PageLoadError,
  component: MessagesPage,
});

function MessagesPage() {
  const agents = Route.useLoaderData();
  const { currentWorkspace } = appRoute.useLoaderData();
  const refreshAgents = useServerFn(listAgents);
  const getConnectionToken = useServerFn(getAgentStatusConnectionToken);
  const visibleAgents = useAgentStatuses({
    agents,
    workspaceId: currentWorkspace?.id,
    refresh: refreshAgents,
    getConnectionToken,
  });
  const params = useParams({ from: "/_app/messages/$agentId", shouldThrow: false });
  return (
    <ConversationLayout agents={visibleAgents} selectedAgentId={params?.agentId}>
      <Outlet />
    </ConversationLayout>
  );
}
