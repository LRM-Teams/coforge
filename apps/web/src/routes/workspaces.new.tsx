import { createFileRoute, redirect } from "@tanstack/react-router";

import { getSignedInAccount } from "#src/features/auth/current-user.functions";
import { FirstWorkspacePage } from "#src/features/workspaces/first-workspace-page";
import { getStartPage } from "#src/features/workspaces/last-location.functions";
import { forgetShownWorkspace } from "#src/features/workspaces/shown-workspace";
import { localizeHref } from "#src/paraglide/runtime";

export const Route = createFileRoute("/workspaces/new")({
  beforeLoad: async ({ context, preload }) => {
    const viewerAccount = await getSignedInAccount();
    if (viewerAccount === null)
      throw redirect({ to: "/login", search: { returnTo: "/workspaces/new" } });
    // Only for a person in no Workspace; anyone else goes on to theirs.
    const start = await getStartPage({ data: { resume: false } });
    if (start) throw redirect({ href: localizeHref(start) });
    // This page shows no Workspace (none left after leaving or deleting one). A preload runs while
    // a Workspace is still on screen, so it keeps that Workspace's cache.
    if (!preload) forgetShownWorkspace(context.queryClient);
    return { viewerAccount };
  },
  component: FirstWorkspace,
});

function FirstWorkspace() {
  const { viewerAccount } = Route.useRouteContext();
  return <FirstWorkspacePage viewerAccount={viewerAccount} />;
}
