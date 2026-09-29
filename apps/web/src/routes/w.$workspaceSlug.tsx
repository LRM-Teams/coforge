import { useCallback, useEffect } from "react";
import { Outlet, createFileRoute, notFound, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import type { QueryClient } from "@tanstack/react-query";

import { AppShell } from "#src/components/app-shell";
import { TimeFormatProvider } from "#src/lib/time-format-context";
import { getUserProfile } from "#src/features/profiles/profile.functions";
import {
  createWorkspace,
  loadWorkspaceSwitcher,
  openWorkspace,
} from "#src/features/workspaces/workspaces.functions";
import { isAppError } from "#src/lib/app-error";
import { isValidWorkspaceSlug } from "#src/features/workspaces/workspace-slug";
import { loadRecordsNavAttention } from "#src/features/records/records.functions";
import { BrowserRealtimeProvider } from "#src/features/realtime/browser-realtime";
import { getBrowserRealtimeConnectionToken } from "#src/features/realtime/realtime.functions";
import { BrowserPushLifecycle } from "#src/features/notifications/browser-push-lifecycle";
import { InPageNotifications } from "#src/features/notifications/in-page-notifications";
import { getBrowserNotificationSettings } from "#src/features/notifications/notifications.functions";
import { listAgents } from "#src/features/agents/agents.functions";
import { WorkspaceAgentsProvider } from "#src/features/agents/workspace-agents-realtime";
import { WorkspacePresenceProvider } from "#src/features/workspaces/member-presence";
import { getUserPreferences } from "#src/features/settings/settings.functions";
import { getPanelTabOrders } from "#src/features/panel-tabs/panel-tabs.functions";
import { PanelTabOrderProvider } from "#src/features/panel-tabs/panel-tab-order-context";
import { useLastLocationMemory } from "#src/features/workspaces/use-last-location-memory";
import { useSearchShortcut } from "#src/features/search/search-shortcut";

/** The Workspace each QueryClient (one per browser app, one per server request) last showed. */
const shownWorkspace = new WeakMap<QueryClient, string>();

export const Route = createFileRoute("/w/$workspaceSlug")({
  staleTime: Infinity,
  beforeLoad: async ({ params, context, preload }) => {
    // A malformed slug names no Workspace; server calls would fall back to the remembered one.
    if (!isValidWorkspaceSlug(params.workspaceSlug)) throw notFound();
    // A preload runs while the browser URL still names the Workspace on screen: it must neither
    // check the target Workspace against that one nor clear what is on screen.
    if (preload) return;
    const shown = shownWorkspace.get(context.queryClient);
    if (shown === params.workspaceSlug) return;
    // Runs before any page loader: a Workspace the User is not in is a page that does not exist
    // for them. Checked once per Workspace entered; every server call re-checks it anyway.
    await openWorkspace().catch((error: unknown) => {
      if (isAppError(error) && error.code === "NOT_FOUND") throw notFound();
      throw error;
    });
    // Query keys are not scoped by Workspace, so moving to another one starts from an empty cache.
    if (shown) context.queryClient.clear();
    shownWorkspace.set(context.queryClient, params.workspaceSlug);
  },
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
  const { queryClient } = Route.useRouteContext();
  // Hydration does not re-run `beforeLoad`, so the browser learns here which Workspace the server
  // rendered; otherwise the first switch away would keep this Workspace's cache.
  useEffect(() => {
    shownWorkspace.set(queryClient, currentWorkspace.slug);
  }, [queryClient, currentWorkspace.slug]);
  useLastLocationMemory();
  useSearchShortcut(currentWorkspace.id, user.id);
  const getRealtimeToken = useServerFn(getBrowserRealtimeConnectionToken);
  const getConnectionToken = useCallback(() => getRealtimeToken(), [getRealtimeToken]);
  const navigate = useNavigate();
  const create = useServerFn(createWorkspace);
  return (
    <TimeFormatProvider timeFormat={timeFormat}>
      <BrowserRealtimeProvider
        workspaceId={currentWorkspace.id}
        getConnectionToken={getConnectionToken}
      >
        <WorkspacePresenceProvider workspaceId={currentWorkspace.id}>
          <WorkspaceAgentsProvider workspaceId={currentWorkspace.id} agents={agents}>
            <PanelTabOrderProvider workspaceId={currentWorkspace.id} orders={tabOrders}>
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
                workspaceId={currentWorkspace.id}
              />
              <AppShell
                user={{
                  id: user.id,
                  name: user.name,
                  email: user.email,
                  avatarUrl: user.avatarUrl,
                }}
                workspaces={workspaces}
                currentWorkspace={currentWorkspace}
                recordsPreview={recordsPreview}
                onSelectWorkspace={async (slug) => {
                  await navigate({ to: "/w/$workspaceSlug", params: { workspaceSlug: slug } });
                }}
                onCreateWorkspace={async (input) => {
                  const workspace = await create({ data: input });
                  await navigate({
                    to: "/w/$workspaceSlug",
                    params: { workspaceSlug: workspace.slug },
                  });
                }}
              >
                <Outlet />
              </AppShell>
            </PanelTabOrderProvider>
          </WorkspaceAgentsProvider>
        </WorkspacePresenceProvider>
      </BrowserRealtimeProvider>
    </TimeFormatProvider>
  );
}
