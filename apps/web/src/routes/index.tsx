import { createFileRoute, redirect } from "@tanstack/react-router";

import { getInstallOrigin } from "@/features/install/install.functions";
import { LandingPage } from "@/features/landing/landing-page";
import { getAuthenticationStatus } from "@/features/auth/current-user.functions";

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
