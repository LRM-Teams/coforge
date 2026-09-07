import { Outlet, createFileRoute, getRouteApi, useParams, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";

import { getAgentStatusConnectionToken, listAgents } from "@/features/agents/agents.functions";
import { useAgentStatuses } from "@/features/agents/agent-status-realtime";
import { ConversationLayout } from "@/features/conversations/conversation-layout";
import { PageLoadError } from "@/features/errors/page-load-error";
import {
  listPublicChannels,
  createPublicChannel,
} from "@/features/conversations/channels.functions";

const appRoute = getRouteApi("/_app");

export const Route = createFileRoute("/_app/messages")({
  loader: async () => {
    const [agents, channels] = await Promise.all([listAgents(), listPublicChannels()]);
    return { agents, channels };
  },
  errorComponent: PageLoadError,
  component: MessagesPage,
});

function MessagesPage() {
  const { agents, channels } = Route.useLoaderData();
  const router = useRouter();
  const createChannel = useServerFn(createPublicChannel);
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
  const channelParams = useParams({
    from: "/_app/messages/channels/$channelId",
    shouldThrow: false,
  });
  return (
    <ConversationLayout
      key={currentWorkspace?.id}
      agents={visibleAgents}
      selectedAgentId={params?.agentId}
      channels={channels}
      selectedChannelId={channelParams?.channelId}
      onCreateChannel={async (name) => {
        const channel = await createChannel({ data: { name } });
        await router.invalidate({ sync: true });
        await router.navigate({
          to: "/messages/channels/$channelId",
          params: { channelId: channel.id },
        });
      }}
    >
      <Outlet />
    </ConversationLayout>
  );
}
