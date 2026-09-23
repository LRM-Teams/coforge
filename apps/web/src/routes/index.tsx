import { createFileRoute, redirect } from "@tanstack/react-router";

import { getInstallOrigin } from "#src/features/install/install.functions";
import { LandingPage } from "#src/features/landing/landing-page";
import { getAuthenticationStatus } from "#src/features/auth/current-user.functions";

export const Route = createFileRoute("/")({
  beforeLoad: async () => {
    const isAuthenticated = await getAuthenticationStatus();
    if (isAuthenticated) throw redirect({ to: "/messages" });
  },
  loader: async () => ({ installOrigin: await getInstallOrigin() }),
  component: Landing,
});

function Landing() {
  const { installOrigin } = Route.useLoaderData();
  return <LandingPage installOrigin={installOrigin} />;
}
