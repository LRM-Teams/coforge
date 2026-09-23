import { useCallback } from "react";
import { Outlet, createFileRoute, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";

import { AppShell } from "@/components/app-shell";
import { TimeFormatProvider } from "@/lib/time-format-context";
import { getUserProfile } from "@/features/profiles/profile.functions";
import {
  createWorkspace,
  loadWorkspaceSwitcher,
  selectWorkspace,
} from "@/features/workspaces/workspaces.functions";
import { loadRecordsNavAttention } from "@/features/records/records.functions";
import { BrowserRealtimeProvider } from "@/features/realtime/browser-realtime";
import { getBrowserRealtimeConnectionToken } from "@/features/realtime/realtime.functions";
import { BrowserPushLifecycle } from "@/features/notifications/browser-push-lifecycle";
import { InPageNotifications } from "@/features/notifications/in-page-notifications";
import { getBrowserNotificationSettings } from "@/features/notifications/notifications.functions";
import { listAgents } from "@/features/agents/agents.functions";
import { WorkspaceAgentsProvider } from "@/features/agents/workspace-agents-realtime";
import { getUserPreferences } from "@/features/settings/settings.functions";
import { getPanelTabOrders } from "@/features/panel-tabs/panel-tabs.functions";
import { PanelTabOrderProvider } from "@/features/panel-tabs/panel-tab-order-context";

export const Route = createFileRoute("/_app")({
  staleTime: Infinity,
  loader: async () => {
    const [user, switcher, notifications, agents, preferences, tabOrders, recordsNav] =
      await Promise.all([
        getUserProfile(),
        loadWorkspaceSwitcher(),
        getBrowserNotificationSettings(),
        listAgents(),
        getUserPreferences(),
        getPanelTabOrders(),
        loadRecordsNavAttention().catch(() => ({ preview: false })),
      ]);
    return {
      user,
      workspaces: switcher.workspaces,
      currentWorkspace: switcher.current,
      notifications,
      agents,
      timeZone: preferences.timeZone,
      timeFormat: preferences.timeFormat,
      conversationOpenMode: preferences.conversationOpenMode,
      tabOrders,
      recordsPreview: recordsNav.preview,
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
    recordsPreview,
    notifications,
    timeFormat,
    tabOrders,
  } = Route.useLoaderData();
  const getRealtimeToken = useServerFn(getBrowserRealtimeConnectionToken);
  const getConnectionToken = useCallback(() => getRealtimeToken(), [getRealtimeToken]);
  const router = useRouter();
  const select = useServerFn(selectWorkspace);
  const create = useServerFn(createWorkspace);
  return (
    <TimeFormatProvider timeFormat={timeFormat}>
      <BrowserRealtimeProvider
        workspaceId={currentWorkspace?.id}
        getConnectionToken={getConnectionToken}
      >
        <WorkspaceAgentsProvider workspaceId={currentWorkspace?.id} agents={agents}>
          <PanelTabOrderProvider workspaceId={currentWorkspace?.id} orders={tabOrders}>
            {/* The server prunes dead web-push subscriptions (404/410), and nothing else ever
            re-registers them — without this the phone stays silent until a manual toggle. */}
            <BrowserPushLifecycle
              enabled={notifications.enabled}
              publicKey={notifications.publicKey}
            />
            {/* While a tab is open, show the OS notification here instead of relying on
                Web Push, which mainland-China staging/clients cannot reach for Chrome. */}
            <InPageNotifications
              enabled={notifications.enabled}
              viewerId={user.id}
              workspaceId={currentWorkspace?.id}
            />
            <AppShell
              user={{ name: user.name, email: user.email, avatarUrl: user.avatarUrl }}
              workspaces={workspaces}
              currentWorkspace={currentWorkspace}
              recordsPreview={recordsPreview}
              onSelectWorkspace={async (slug) => {
                await select({ data: { slug } });
                await router.invalidate({ sync: true });
              }}
              onCreateWorkspace={async (input) => {
                await create({ data: input });
                await router.invalidate({ sync: true });
              }}
            >
              <Outlet />
            </AppShell>
          </PanelTabOrderProvider>
        </WorkspaceAgentsProvider>
      </BrowserRealtimeProvider>
    </TimeFormatProvider>
  );
}
