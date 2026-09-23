import { createFileRoute, redirect } from "@tanstack/react-router";

import { getInstallOrigin } from "#src/features/install/install.functions";
import { LandingPage } from "#src/features/landing/landing-page";
import { getAuthenticationStatus } from "#src/features/auth/current-user.functions";
import { getLastLocation } from "#src/features/workspaces/last-location.functions";
import { localizeHref } from "#src/paraglide/runtime";

export const Route = createFileRoute("/")({
  beforeLoad: async ({ location }) => {
    const isAuthenticated = await getAuthenticationStatus();
    if (!isAuthenticated) return;
    // Opening the bare app root returns to the page the user had open (24 hours, same
    // Workspace); a root URL carrying a query is a link with its own intent and opens Chat.
    const lastLocation = location.searchStr ? null : await getLastLocation();
    if (lastLocation) throw redirect({ href: localizeHref(lastLocation) });
    throw redirect({ to: "/messages" });
  },
  loader: async () => ({ installOrigin: await getInstallOrigin() }),
  component: Landing,
});

function Landing() {
  const { installOrigin } = Route.useLoaderData();
  return <LandingPage installOrigin={installOrigin} />;
}
