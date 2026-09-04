import { createFileRoute, redirect } from "@tanstack/react-router";

import { getInstallOrigin } from "@/features/install/install.functions";
import { LandingPage } from "@/features/landing/landing-page";
import { peekCurrentUser } from "@/server/auth/current-user";

export const Route = createFileRoute("/")({
  beforeLoad: async () => {
    const user = await peekCurrentUser();
    if (user) throw redirect({ to: "/agents" });
  },
  loader: async () => ({ installOrigin: await getInstallOrigin() }),
  component: Landing,
});

function Landing() {
  const { installOrigin } = Route.useLoaderData();
  return <LandingPage installOrigin={installOrigin} />;
}
