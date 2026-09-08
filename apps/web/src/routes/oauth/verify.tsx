import { createFileRoute } from "@tanstack/react-router";

import { DeviceVerifyPage } from "@/features/device-auth/device-verify-page";
import { getDeviceVerifyUser } from "@/features/device-auth/device-auth.functions";
import { normalizeUserCode } from "@/features/device-auth/device-code-format";

/**
 * Where a Computer's `login` sends the person sitting in front of it. Deliberately outside
 * `_app`: someone arriving here may have no Workspace selected yet, and the page has to work as a
 * standalone destination pasted from a terminal.
 *
 * The loader redirects to /login when there is no session, so signing in first is a property of
 * the route rather than an instruction the user has to follow.
 */
export const Route = createFileRoute("/oauth/verify")({
  validateSearch: (search: Record<string, unknown>) => ({
    user_code: typeof search.user_code === "string" ? search.user_code : undefined,
  }),
  loader: async () => ({ user: await getDeviceVerifyUser() }),
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
