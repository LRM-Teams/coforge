import { createFileRoute } from "@tanstack/react-router";

import { DeviceVerifyPage } from "@/features/device-auth/device-verify-page";
import { normalizeUserCode } from "@/features/device-auth/device-code-format";
import { requireCurrentUser } from "@/server/auth/current-user";

/**
 * Where a Computer's `login` sends the person sitting in front of it. It is deliberately outside
 * `_app`: someone arriving here may not have a Workspace selected yet, and the page must work as
 * a standalone destination pasted from a terminal.
 *
 * `requireCurrentUser` redirects to /login when there is no session, which is what makes
 * "log in first, then approve" the natural path rather than an instruction.
 */
export const Route = createFileRoute("/oauth/verify")({
  validateSearch: (search: Record<string, unknown>) => ({
    user_code: typeof search.user_code === "string" ? search.user_code : undefined,
  }),
  loader: async () => ({ user: await requireCurrentUser() }),
  component: Verify,
});

function Verify() {
  const { user } = Route.useLoaderData();
  const { user_code: userCode } = Route.useSearch();
  // The code arrives prefilled from `verification_uri_complete`, but it is only ever a
  // convenience: the field stays editable and nothing is approved until the person confirms.
  return (
    <DeviceVerifyPage
      email={user.email}
      initialCode={userCode ? normalizeUserCode(userCode) : ""}
    />
  );
}
