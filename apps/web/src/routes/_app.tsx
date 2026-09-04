import { Outlet, createFileRoute, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";

import { AppShell } from "@/components/app-shell";
import { getUserProfile } from "@/features/profiles/profile.functions";
import {
  createWorkspace,
  loadWorkspaceSwitcher,
  selectWorkspace,
} from "@/features/workspaces/workspaces.functions";

export const Route = createFileRoute("/_app")({
  staleTime: Infinity,
  loader: async () => {
    const [user, switcher] = await Promise.all([getUserProfile(), loadWorkspaceSwitcher()]);
    return { user, workspaces: switcher.workspaces, currentWorkspace: switcher.current };
  },
  component: AppLayout,
});

function AppLayout() {
  const { user, workspaces, currentWorkspace } = Route.useLoaderData();
  const router = useRouter();
  const select = useServerFn(selectWorkspace);
  const create = useServerFn(createWorkspace);
  return (
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
    >
      <Outlet />
    </AppShell>
  );
}
