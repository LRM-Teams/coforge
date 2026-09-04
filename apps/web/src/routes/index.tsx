import { createFileRoute, redirect } from "@tanstack/react-router";

import { getInstallScriptUrl } from "@/features/landing/landing.functions";
import { LandingPage } from "@/features/landing/landing-page";
import { peekCurrentUser } from "@/server/auth/current-user";

export const Route = createFileRoute("/")({
  beforeLoad: async () => {
    const user = await peekCurrentUser();
    if (user) throw redirect({ to: "/agents" });
  },
  loader: async () => ({ installScriptUrl: await getInstallScriptUrl() }),
  component: Landing,
});

function Landing() {
  const { installScriptUrl } = Route.useLoaderData();
  return <LandingPage installScriptUrl={installScriptUrl} />;
}
