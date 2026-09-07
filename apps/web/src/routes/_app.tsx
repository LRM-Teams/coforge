import { Outlet, createFileRoute, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";

import { AppShell } from "@/components/app-shell";
import { unsubscribeCurrentBrowserPush } from "@/features/notifications/browser-push";
import { BrowserPushLifecycle } from "@/features/notifications/browser-push-lifecycle";
import {
  getBrowserNotificationSettings,
  unsubscribeBrowserPush,
} from "@/features/notifications/notifications.functions";
import { getUserProfile } from "@/features/profiles/profile.functions";
import {
  createWorkspace,
  loadWorkspaceSwitcher,
  selectWorkspace,
} from "@/features/workspaces/workspaces.functions";

export const Route = createFileRoute("/_app")({
  staleTime: Infinity,
  loader: async () => {
    const [user, switcher, notifications] = await Promise.all([
      getUserProfile(),
      loadWorkspaceSwitcher(),
      getBrowserNotificationSettings(),
    ]);
    return {
      user,
      workspaces: switcher.workspaces,
      currentWorkspace: switcher.current,
      notifications,
    };
  },
  component: AppLayout,
});

function AppLayout() {
  const { user, workspaces, currentWorkspace, notifications } = Route.useLoaderData();
  const router = useRouter();
  const select = useServerFn(selectWorkspace);
  const create = useServerFn(createWorkspace);
  const unsubscribe = useServerFn(unsubscribeBrowserPush);
  return (
    <>
      <BrowserPushLifecycle {...notifications} />
      <AppShell
        user={{ name: user.name, email: user.email, avatarUrl: user.avatarUrl }}
        workspaces={workspaces}
        currentWorkspace={currentWorkspace}
        onSelectWorkspace={async (slug) => {
          await select({ data: { slug } });
          await router.invalidate({ sync: true });
        }}
        onCreateWorkspace={async (input) => {
          await create({ data: input });
          await router.invalidate({ sync: true });
        }}
        onSignOut={async () => {
          try {
            await unsubscribeCurrentBrowserPush((endpoint) => unsubscribe({ data: { endpoint } }));
          } finally {
            window.location.assign("/auth/logout");
          }
        }}
      >
        <Outlet />
      </AppShell>
    </>
  );
}
