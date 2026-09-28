import { redirect } from "@tanstack/react-router";

import { readBrowserSession, type BrowserUser } from "./browser-login.server";
import { AuthConfigError, readSessionSecret } from "./config.server";
import { devBrowserUser } from "./dev-skip-auth.server";

export async function requireBrowserUser(cookieHeader: string | undefined): Promise<BrowserUser> {
  const skipped = devBrowserUser();
  if (skipped) return skipped;

  let sessionSecret: string;
  try {
    sessionSecret = await readSessionSecret(process.env);
  } catch (error) {
    if (error instanceof AuthConfigError) throw redirect({ href: "/login" });
    throw error;
  }
  const user = readBrowserSession({
    sessionSecret,
    cookieHeader: cookieHeader ?? "",
  });
  if (!user) throw redirect({ href: "/login" });
  return user;
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
