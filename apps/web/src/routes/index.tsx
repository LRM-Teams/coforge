import { createFileRoute, redirect } from "@tanstack/react-router";

import { LandingPage } from "@/features/landing/landing-page";
import { peekCurrentUser } from "@/server/auth/current-user";

export const Route = createFileRoute("/")({
  beforeLoad: async () => {
    const user = await peekCurrentUser();
    if (user) throw redirect({ to: "/agents" });
  },
  component: LandingPage,
});
