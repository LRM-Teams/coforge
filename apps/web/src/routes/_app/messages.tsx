import { Outlet, createFileRoute, getRouteApi, useParams, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";

import { getAgentActivityConnectionToken, listAgents } from "@/features/agents/agents.functions";
import { getWorkspaceActivity } from "@/features/agents/agent-activity.functions";
import { useWorkspaceActivity } from "@/features/agents/workspace-activity-realtime";
import { useAgentStatuses } from "@/features/agents/agent-status-realtime";
import { ConversationLayout } from "@/features/conversations/conversation-layout";
import { PageLoadError } from "@/features/errors/page-load-error";
import { getUserPreferences } from "@/features/settings/settings.functions";
import {
  listPublicChannels,
  createPublicChannel,
} from "@/features/conversations/channels.functions";

const appRoute = getRouteApi("/_app");

export const Route = createFileRoute("/_app/messages")({
  loader: async () => {
    const [agents, channels, preferences] = await Promise.all([
      listAgents(),
      listPublicChannels(),
      getUserPreferences(),
    ]);
    return { agents, channels, timeZone: preferences.timeZone };
  },
  errorComponent: PageLoadError,
  component: MessagesPage,
});

function MessagesPage() {
  const { agents, channels, timeZone } = Route.useLoaderData();
  const router = useRouter();
  const createChannel = useServerFn(createPublicChannel);
  const { currentWorkspace } = appRoute.useLoaderData();
  const refreshAgents = useServerFn(listAgents);
  const refreshActivity = useServerFn(getWorkspaceActivity);
  const getActivityToken = useServerFn(getAgentActivityConnectionToken);
  const activityView = useWorkspaceActivity({
    workspaceId: currentWorkspace?.id,
    refresh: refreshActivity,
    getConnectionToken: getActivityToken,
  });
  const visibleAgents = useAgentStatuses({
    agents,
    workspaceId: currentWorkspace?.id,
    refresh: refreshAgents,
  });
  const params = useParams({
    from: "/_app/messages/$agentId",
    shouldThrow: false,
  });
  const channelParams = useParams({
    from: "/_app/messages/channels/$channelId",
    shouldThrow: false,
  });
  return (
    <ConversationLayout
      key={currentWorkspace?.id}
      agents={visibleAgents}
      activityView={activityView}
      timeZone={timeZone ?? undefined}
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
