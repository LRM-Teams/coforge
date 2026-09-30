import { createFileRoute, redirect } from "@tanstack/react-router";

import { getNameStep } from "#src/features/auth/first-sign-in.functions";
import { NameStepPage } from "#src/features/auth/name-step-page";
import { afterSignInHref, safeReturnTo, signInHref } from "#src/features/auth/return-to";

/**
 * The one question of first sign-in: a person's full name. Outside the Workspace layout on
 * purpose: it is asked before their personal Workspace exists. Sign-in and every page that would
 * make or open that Workspace send a person here while they have no full name, with the page to go
 * on to as `returnTo`; someone who has one is sent straight on.
 */
export const Route = createFileRoute("/welcome")({
  // Only a page of this site is a place to go on to. The key is always returned, like `/login`.
  validateSearch: (search: Record<string, unknown>): { returnTo?: string } => ({
    returnTo: safeReturnTo(search.returnTo),
  }),
  beforeLoad: async ({ search }) => {
    const step = await getNameStep();
    if (step.status === "named") throw redirect({ href: afterSignInHref(search.returnTo) });
    // The session outlived its user: nothing can be saved for them, so they sign in again (a
    // document load, `/auth/login` being a server route), which makes the user and a new session.
    if (step.status === "account_gone") {
      throw redirect({ href: signInHref(search.returnTo), reloadDocument: true });
    }
    return { prefill: step.prefill };
  },
  component: Welcome,
});

function Welcome() {
  const { prefill } = Route.useRouteContext();
  const { returnTo } = Route.useSearch();
  return <NameStepPage prefill={prefill} returnTo={returnTo} />;
}
