import { z } from "zod";
import { browserCookie, cookiePairs } from "#src/lib/browser-cookie";
import { isValidWorkspaceSlug } from "./workspace-slug";

/**
 * Where opening the app root (`/`) returns a signed-in user: the last in-app page they had open,
 * for 24 hours after they opened it. The page URL names its Workspace (`/w/<slug>/…`). The browser
 * writes it as a cookie after each navigation so the server can redirect `/` before rendering
 * anything. The path is de-localized; the redirect localizes it.
 */

const COOKIE_NAME = "coforge-last-location";
const MAX_AGE_SECONDS = 24 * 60 * 60;

/** The signed-in app's top-level pages inside a Workspace. Anything else — the landing page,
 * login, OAuth, the API — is never a place to return to. */
const APP_SECTIONS = [
  "channel",
  "messages",
  "saved",
  "activity",
  "tasks",
  "search",
  "projects",
  "members",
  "agent",
  "records",
  "computers",
  "computer",
  "settings",
];

/** One of the app's pages: `/w/<slug>`, optionally a known section and plain path segments. No
 * `//`, backslash, scheme, dot segment, query, or fragment, so a forged cookie cannot turn the
 * redirect into an open redirect. */
const APP_PATH = new RegExp(
  `^/w/([^/]+)(?:/(?:${APP_SECTIONS.join("|")})(?:/[A-Za-z0-9_~%-]+(?:\\.[A-Za-z0-9_~%-]+)*)*)?/?$`,
);

function isAppPath(path: string): boolean {
  // A URL parser collapses dot segments, encoded ones (`%2e%2e`) included, before anything opens
  // the path; only a path it leaves untouched is the page it names.
  const slug = APP_PATH.exec(path)?.[1];
  return (
    slug !== undefined &&
    isValidWorkspaceSlug(slug) &&
    new URL(path, "http://coforge.invalid").pathname === path
  );
}

/** The `Set-Cookie`/`document.cookie` string remembering `path`, or `undefined` when the page is
 * not one to return to. Every write restarts the 24 hours. */
export function lastLocationCookie(path: string, secure: boolean): string | undefined {
  if (!isAppPath(path)) return undefined;
  return browserCookie(COOKIE_NAME, JSON.stringify({ path }), MAX_AGE_SECONDS, secure);
}

const storedLocation = z.object({ path: z.string() });

/** The page `/` should open from the request's cookies, if any. */
export function restorableLastLocation(cookieHeader: string | undefined): string | undefined {
  const pair = cookiePairs(cookieHeader).find(([name]) => name === COOKIE_NAME);
  if (!pair) return undefined;
  try {
    const parsed = storedLocation.safeParse(JSON.parse(decodeURIComponent(pair[1])));
    return parsed.success && isAppPath(parsed.data.path) ? parsed.data.path : undefined;
  } catch {
    // A malformed cookie is simply not a place to return to.
    return undefined;
  }
}
