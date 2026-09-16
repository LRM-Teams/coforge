import { useCallback } from "react";
import { Outlet, createFileRoute, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";

import { AppShell } from "@/components/app-shell";
import { getUserProfile } from "@/features/profiles/profile.functions";
import {
  createWorkspace,
  loadWorkspaceSwitcher,
  selectWorkspace,
} from "@/features/workspaces/workspaces.functions";
import { loadRecordsNavAttention } from "@/features/records/records.functions";
import { BrowserRealtimeProvider } from "@/features/realtime/browser-realtime";
import { getBrowserRealtimeConnectionToken } from "@/features/realtime/realtime.functions";
import { getBrowserNotificationSettings } from "@/features/notifications/notifications.functions";
import {
  listAgents,
  getAgentActivitySubscriptionToken,
  getAgentStatusSubscriptionToken,
} from "@/features/agents/agents.functions";
import { getWorkspaceActivity } from "@/features/agents/agent-activity.functions";
import { listProjects } from "@/features/projects/projects.functions";
import { useWorkspaceActivity } from "@/features/agents/workspace-activity-realtime";
import { useAgentStatuses } from "@/features/agents/agent-status-realtime";
import { ConversationRealtimeProvider } from "@/features/conversations/conversation-layout";
import { getUserPreferences } from "@/features/settings/settings.functions";
import {
  listPublicChannels,
  createPublicChannel,
} from "@/features/conversations/channels.functions";

export const Route = createFileRoute("/_app")({
  staleTime: Infinity,
  loader: async () => {
    const [user, switcher, notifications, agents, channels, preferences, recordsNav, projects] =
      await Promise.all([
        getUserProfile(),
        loadWorkspaceSwitcher(),
        getBrowserNotificationSettings(),
        listAgents(),
        listPublicChannels(),
        getUserPreferences(),
        loadRecordsNavAttention().catch(() => ({ preview: false })),
        listProjects(),
      ]);
    return {
      user,
      workspaces: switcher.workspaces,
      currentWorkspace: switcher.current,
      notifications,
      agents,
      channels,
      timeZone: preferences.timeZone,
      recordsPreview: recordsNav.preview,
      projects: projects
        .map((project) => ({
          id: project.id,
          name: project.name,
          slug: project.slug,
          developmentConversationId: project.developmentConversation?.id ?? "",
        }))
        .filter((project) => project.developmentConversationId),
    };
  },
  component: AppLayout,
});

function AppLayout() {
  const {
    user,
    workspaces,
    currentWorkspace,
    agents,
    channels,
    timeZone,
    recordsPreview,
    projects,
  } = Route.useLoaderData();
  const router = useRouter();
  const select = useServerFn(selectWorkspace);
  const create = useServerFn(createWorkspace);
  const createChannel = useServerFn(createPublicChannel);
  const getRealtimeToken = useServerFn(getBrowserRealtimeConnectionToken);
  const getConnectionToken = useCallback(() => getRealtimeToken(), [getRealtimeToken]);
  const refreshAgents = useServerFn(listAgents);
  const refreshActivity = useServerFn(getWorkspaceActivity);
  const getActivityToken = useServerFn(getAgentActivitySubscriptionToken);
  const getStatusToken = useServerFn(getAgentStatusSubscriptionToken);
  const activityView = useWorkspaceActivity({
    workspaceId: currentWorkspace?.id,
    refresh: refreshActivity,
    getConnectionToken: getActivityToken,
  });
  const visibleAgents = useAgentStatuses({
    agents,
    workspaceId: currentWorkspace?.id,
    refresh: refreshAgents,
    getConnectionToken: getStatusToken,
  });
  return (
    <BrowserRealtimeProvider
      workspaceId={currentWorkspace?.id}
      getConnectionToken={getConnectionToken}
    >
      <ConversationRealtimeProvider
        agents={visibleAgents}
        activityView={activityView}
        timeZone={timeZone ?? undefined}
      >
        <AppShell
          user={{ name: user.name, email: user.email, avatarUrl: user.avatarUrl }}
          workspaces={workspaces}
          currentWorkspace={currentWorkspace}
          channels={channels}
          agents={visibleAgents}
          recordsPreview={recordsPreview}
          projects={projects}
          onSelectWorkspace={async (slug) => {
            await select({ data: { slug } });
            await router.invalidate({ sync: true });
          }}
          onCreateWorkspace={async (input) => {
            await create({ data: input });
            await router.invalidate({ sync: true });
          }}
          onCreateChannel={async (name, projectId) => {
            const channel = await createChannel({ data: { name, projectId } });
            await router.invalidate({ sync: true });
            await router.navigate({
              to: "/messages/channels/$channelId",
              params: { channelId: channel.id },
            });
          }}
        >
          <Outlet />
        </AppShell>
      </ConversationRealtimeProvider>
    </BrowserRealtimeProvider>
  );
}
