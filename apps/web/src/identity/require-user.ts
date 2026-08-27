import { redirect } from "@tanstack/react-router";

import { readBrowserSession, type BrowserUser } from "./browser-login";
import { AuthConfigError, readSessionSecret } from "./config";
import { devBrowserUser } from "./dev-skip-auth";

export function requireBrowserUser(cookieHeader: string | undefined): BrowserUser {
  const skipped = devBrowserUser();
  if (skipped) return skipped;

  let sessionSecret: string;
  try {
    sessionSecret = readSessionSecret(process.env);
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

export function optionalBrowserUser(cookieHeader: string | undefined): BrowserUser | null {
  const skipped = devBrowserUser();
  if (skipped) return skipped;

  try {
    return readBrowserSession({
      sessionSecret: readSessionSecret(process.env),
      cookieHeader: cookieHeader ?? "",
    });
  } catch (error) {
    if (error instanceof AuthConfigError) return null;
    throw error;
  }
}
