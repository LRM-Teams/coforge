/**
 * Where opening the app root (`/`) returns a signed-in user: the last in-app page they had open,
 * for 24 hours after they opened it, and only in the Workspace it belongs to (app URLs do not name
 * the Workspace). The browser writes it as a cookie after each navigation so the server can
 * redirect `/` before rendering anything. The path is de-localized; the redirect localizes it.
 */

const COOKIE_NAME = "coforge-last-location";
const MAX_AGE_SECONDS = 24 * 60 * 60;

/** The signed-in app's top-level pages. Anything else — the landing page, login, OAuth, the API —
 * is never a place to return to. */
const APP_SECTIONS = [
  "messages",
  "projects",
  "agents",
  "tasks",
  "records",
  "computers",
  "settings",
];

/** One of the app's pages: a single leading slash, a known section, then plain path segments. No
 * `//`, backslash, scheme, dot segment, query, or fragment, so a forged cookie cannot turn the
 * redirect into an open redirect. */
const APP_PATH = new RegExp(
  `^/(?:${APP_SECTIONS.join("|")})(?:/[A-Za-z0-9_~%-]+(?:\\.[A-Za-z0-9_~%-]+)*)*/?$`,
);

export type LastLocation = { workspaceSlug: string; path: string };

function isAppPath(path: string): boolean {
  return APP_PATH.test(path) && !path.split("/").some((segment) => segment === "..");
}

/** The `Set-Cookie`/`document.cookie` string remembering `location`, or `undefined` when the page
 * is not one to return to. Every write restarts the 24 hours. */
export function lastLocationCookie(location: LastLocation, secure: boolean): string | undefined {
  if (!location.workspaceSlug || !isAppPath(location.path)) return undefined;
  return [
    `${COOKIE_NAME}=${encodeURIComponent(JSON.stringify(location))}`,
    "Path=/",
    `Max-Age=${MAX_AGE_SECONDS}`,
    "SameSite=Lax",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

function readLastLocation(cookieHeader: string): LastLocation | undefined {
  for (const part of cookieHeader.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key !== COOKIE_NAME) continue;
    try {
      const value: unknown = JSON.parse(decodeURIComponent(rest.join("=")));
      if (
        value &&
        typeof value === "object" &&
        "workspaceSlug" in value &&
        "path" in value &&
        typeof value.workspaceSlug === "string" &&
        typeof value.path === "string"
      ) {
        return { workspaceSlug: value.workspaceSlug, path: value.path };
      }
    } catch {
      // A malformed cookie is simply not a place to return to.
    }
    return undefined;
  }
  return undefined;
}

/**
 * The page `/` should open from the request's cookies, if any: the remembered page, when it is an
 * app page and belongs to the Workspace the user currently works in (`preferredWorkspaceSlug`, the
 * Workspace cookie; absent when they never switched, so the default Workspace is the one they had).
 */
export function restorableLastLocation(
  cookieHeader: string | undefined,
  preferredWorkspaceSlug: string | undefined,
): string | undefined {
  if (!cookieHeader) return undefined;
  const location = readLastLocation(cookieHeader);
  if (!location || !isAppPath(location.path)) return undefined;
  if (preferredWorkspaceSlug && preferredWorkspaceSlug !== location.workspaceSlug) return undefined;
  return location.path;
}
