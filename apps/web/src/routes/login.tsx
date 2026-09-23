import { createFileRoute, redirect } from "@tanstack/react-router";

import { LoginPage } from "@/components/login-page";
import { getAuthenticationStatus } from "@/features/auth/current-user.functions";

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>) => ({
    error: typeof search.error === "string" ? search.error : undefined,
  }),
  beforeLoad: async () => {
    const isAuthenticated = await getAuthenticationStatus();
    if (isAuthenticated) throw redirect({ to: "/" });
  },
  component: Login,
});

function Login() {
  const { error } = Route.useSearch();
  return <LoginPage error={error} />;
}
