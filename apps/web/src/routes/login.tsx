import { createFileRoute, redirect } from "@tanstack/react-router";

import { LoginPage } from "@/components/login-page";
import { peekCurrentUser } from "@/identity/current-user";

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>) => ({
    error: typeof search.error === "string" ? search.error : undefined,
  }),
  beforeLoad: async () => {
    const user = await peekCurrentUser();
    if (user) throw redirect({ to: "/" });
  },
  component: Login,
});

function Login() {
  const { error } = Route.useSearch();
  return <LoginPage error={error} />;
}
