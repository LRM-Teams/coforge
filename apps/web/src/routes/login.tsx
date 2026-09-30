import { createFileRoute, redirect } from "@tanstack/react-router";

import { getAuthenticationStatus } from "#src/features/auth/current-user.functions";
import { LoginErrorPage } from "#src/features/auth/login-error-page";
import { afterSignInHref, safeReturnTo, signInHref } from "#src/features/auth/return-to";

/**
 * Sign-in has no page of its own: `/login` goes straight to Authing's hosted page through
 * `/auth/login`, and only a sign-in that did not finish (`?error=login_failed`, from the callback)
 * renders here.
 */
export const Route = createFileRoute("/login")({
  // The page to go back to after signing in; anything that is not a page of this site is dropped.
  // Both keys are always returned: the router keeps raw search keys a validator leaves out.
  validateSearch: (search: Record<string, unknown>): { returnTo?: string; error?: string } => ({
    returnTo: safeReturnTo(search.returnTo),
    error: typeof search.error === "string" ? search.error : undefined,
  }),
  beforeLoad: async ({ search }) => {
    const returnTo = safeReturnTo(search.returnTo);
    if (await getAuthenticationStatus()) {
      throw redirect({ href: afterSignInHref(returnTo) });
    }
    // /auth/login is a server route, so the browser has to load it as a document.
    if (!search.error) throw redirect({ href: signInHref(returnTo), reloadDocument: true });
  },
  component: Login,
});

function Login() {
  const { returnTo } = Route.useSearch();
  return <LoginErrorPage returnTo={returnTo} />;
}
