import { Outlet, createFileRoute } from "@tanstack/react-router";

import { AppShell } from "@/components/app-shell";
import { requireCurrentUser } from "@/server/auth/current-user";

export const Route = createFileRoute("/_app")({
  beforeLoad: async () => ({ user: await requireCurrentUser() }),
  component: AppLayout,
});

function AppLayout() {
  const { user } = Route.useRouteContext();
  return (
    <AppShell user={{ name: user.name, email: user.email }}>
      <Outlet />
    </AppShell>
  );
}
