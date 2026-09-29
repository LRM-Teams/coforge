import { createFileRoute, redirect } from "@tanstack/react-router";

import { getInstallOrigin } from "#src/features/install/install.functions";
import { LandingPage } from "#src/features/landing/landing-page";
import { getAuthenticationStatus } from "#src/features/auth/current-user.functions";
import { getStartPage } from "#src/features/workspaces/last-location.functions";
import { localizeHref } from "#src/paraglide/runtime";
import { forgetShownWorkspace } from "#src/features/workspaces/shown-workspace";

export const Route = createFileRoute("/")({
  beforeLoad: async ({ location, context, preload }) => {
    const isAuthenticated = await getAuthenticationStatus();
    if (isAuthenticated) {
      // Opening the bare app root returns to the page the user had open (24 hours), else to the
      // Workspace they last opened; a root URL carrying a query is a link with its own intent and
      // opens the Workspace.
      const start = await getStartPage({ data: { resume: !location.searchStr } });
      if (start) throw redirect({ href: localizeHref(start) });
    }
    // The start page shows no Workspace (none left after leaving or deleting one). A preload runs
    // while a Workspace is still on screen, so it keeps that Workspace's cache.
    if (!preload) forgetShownWorkspace(context.queryClient);
  },
  loader: async () => ({ installOrigin: await getInstallOrigin() }),
  component: Landing,
});

function Landing() {
  const { installOrigin } = Route.useLoaderData();
  return <LandingPage installOrigin={installOrigin} />;
}
