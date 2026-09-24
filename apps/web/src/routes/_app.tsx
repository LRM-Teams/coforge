import { useCallback } from "react";
import { Outlet, createFileRoute, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";

import { AppShell } from "#src/components/app-shell";
import { TimeFormatProvider } from "#src/lib/time-format-context";
import { getUserProfile } from "#src/features/profiles/profile.functions";
import {
  createWorkspace,
  loadWorkspaceSwitcher,
  selectWorkspace,
} from "#src/features/workspaces/workspaces.functions";
import { loadRecordsNavAttention } from "#src/features/records/records.functions";
import { BrowserRealtimeProvider } from "#src/features/realtime/browser-realtime";
import { getBrowserRealtimeConnectionToken } from "#src/features/realtime/realtime.functions";
import { BrowserPushLifecycle } from "#src/features/notifications/browser-push-lifecycle";
import { InPageNotifications } from "#src/features/notifications/in-page-notifications";
import { getBrowserNotificationSettings } from "#src/features/notifications/notifications.functions";
import { listAgents } from "#src/features/agents/agents.functions";
import { WorkspaceAgentsProvider } from "#src/features/agents/workspace-agents-realtime";
import { getUserPreferences } from "#src/features/settings/settings.functions";
import { getPanelTabOrders } from "#src/features/panel-tabs/panel-tabs.functions";
import { PanelTabOrderProvider } from "#src/features/panel-tabs/panel-tab-order-context";
import { useLastLocationMemory } from "#src/features/workspaces/use-last-location-memory";
import { useSearchShortcut } from "#src/features/search/search-shortcut";

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
  useLastLocationMemory(currentWorkspace?.slug);
  useSearchShortcut(currentWorkspace?.id, user.id);
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
              user={{ id: user.id, name: user.name, email: user.email, avatarUrl: user.avatarUrl }}
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
