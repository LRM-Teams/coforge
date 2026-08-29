import type { BrowserUser } from "./browser-login.server";

export const DEV_BROWSER_USER: BrowserUser = {
  id: "00000000-0000-5000-8000-000000000001",
  email: "dev@coforge.local",
  name: "Dev User",
  authingSub: "dev-skip-auth",
  username: "dev-user",
};

export function isDevSkipAuthEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NODE_ENV === "production") return false;
  const raw = env.COFORGE_DEV_SKIP_AUTH?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

export function devBrowserUser(env: NodeJS.ProcessEnv = process.env): BrowserUser | null {
  return isDevSkipAuthEnabled(env) ? DEV_BROWSER_USER : null;
}
