import { redirect } from "@tanstack/react-router";

import { readBrowserSession, type BrowserUser } from "./browser-login.server";
import { AuthConfigError, readSessionSecret } from "./config.server";
import { devBrowserUser } from "./dev-skip-auth.server";
import { safeReturnTo } from "#src/features/auth/return-to";

/**
 * The signed-in user, or a redirect to `/login`. `returnTo` is the page being opened; sign-in
 * brings the person back to it (a device-approval link keeps its code that way).
 */
export async function requireBrowserUser(
  cookieHeader: string | undefined,
  returnTo?: string,
): Promise<BrowserUser> {
  const skipped = devBrowserUser();
  if (skipped) return skipped;

  let sessionSecret: string;
  try {
    sessionSecret = await readSessionSecret(process.env);
  } catch (error) {
    if (error instanceof AuthConfigError) throw redirect({ href: loginHref(returnTo) });
    throw error;
  }
  const user = readBrowserSession({
    sessionSecret,
    cookieHeader: cookieHeader ?? "",
  });
  if (!user) throw redirect({ href: loginHref(returnTo) });
  return user;
}

function loginHref(returnTo: string | undefined): string {
  const page = safeReturnTo(returnTo);
  return page && page !== "/" ? `/login?returnTo=${encodeURIComponent(page)}` : "/login";
}

export async function optionalBrowserUser(
  cookieHeader: string | undefined,
): Promise<BrowserUser | null> {
  const skipped = devBrowserUser();
  if (skipped) return skipped;

  try {
    return readBrowserSession({
      sessionSecret: await readSessionSecret(process.env),
      cookieHeader: cookieHeader ?? "",
    });
  } catch (error) {
    if (error instanceof AuthConfigError) return null;
    throw error;
  }
}
