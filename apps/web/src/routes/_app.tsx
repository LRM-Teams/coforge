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
import { BrowserPushLifecycle } from "@/features/notifications/browser-push-lifecycle";
import { listAgents } from "@/features/agents/agents.functions";
import { WorkspaceAgentsProvider } from "@/features/agents/workspace-agents-realtime";
import { getUserPreferences } from "@/features/settings/settings.functions";

export const Route = createFileRoute("/_app")({
  staleTime: Infinity,
  loader: async () => {
    const [user, switcher, notifications, agents, preferences, recordsNav] = await Promise.all([
      getUserProfile(),
      loadWorkspaceSwitcher(),
      getBrowserNotificationSettings(),
      listAgents(),
      getUserPreferences(),
      loadRecordsNavAttention().catch(() => ({ preview: false })),
    ]);
    return {
      user,
      workspaces: switcher.workspaces,
      currentWorkspace: switcher.current,
      notifications,
      agents,
      timeZone: preferences.timeZone,
      conversationOpenMode: preferences.conversationOpenMode,
      recordsPreview: recordsNav.preview,
    };
  },
  component: AppLayout,
});

function AppLayout() {
  const { user, workspaces, currentWorkspace, notifications, agents, recordsPreview } =
    Route.useLoaderData();
  const getRealtimeToken = useServerFn(getBrowserRealtimeConnectionToken);
  const getConnectionToken = useCallback(() => getRealtimeToken(), [getRealtimeToken]);
  const router = useRouter();
  const select = useServerFn(selectWorkspace);
  const create = useServerFn(createWorkspace);
  return (
    <BrowserRealtimeProvider
      workspaceId={currentWorkspace?.id}
      getConnectionToken={getConnectionToken}
    >
      {/* Re-registers this browser's Push subscription whenever the app loads and the member has
          browser notifications on. Without it a subscription the server ever pruned (a 404/410
          from the push service removes the row by design) never came back: notifications stopped
          for that device and nothing healed until someone toggled the setting by hand. The settings
          this needs are already loaded above. */}
      <BrowserPushLifecycle enabled={notifications.enabled} publicKey={notifications.publicKey} />
      <WorkspaceAgentsProvider workspaceId={currentWorkspace?.id} agents={agents}>
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
      </WorkspaceAgentsProvider>
    </BrowserRealtimeProvider>
  );
}
