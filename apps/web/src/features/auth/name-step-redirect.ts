import { redirect } from "@tanstack/react-router";

import { safeReturnTo } from "#src/features/auth/return-to";

/**
 * Sends a signed-in person who has not been asked for a full name to the name step, coming back to
 * `returnTo` (the page they were opening) once they have answered. Every page that would make or
 * open their personal Workspace throws this first, so that Workspace is titled with the answer.
 */
export function nameStepRedirect(returnTo: string) {
  return redirect({ to: "/welcome", search: { returnTo: safeReturnTo(returnTo) } });
}
