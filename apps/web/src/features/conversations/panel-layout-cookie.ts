import type { LayoutStorage } from "react-resizable-panels";

import { cookiePairs, saveBrowserCookie } from "#src/lib/browser-cookie";

/**
 * The conversation's panel layout, remembered in a cookie so the server render can start from it.
 * `react-resizable-panels` gives `useDefaultLayout` a `storage` for this, and its "Persistent
 * layouts with server rendering" guide says `localStorage` does not exist on the server and a
 * cookie storage avoids the layout shift; it also says never to fall back to `localStorage`
 * conditionally, which would differ between the server and hydrating renders.
 * https://github.com/bvaughn/react-resizable-panels (src/routes/PersistentLayoutsServerRenderingRoute.tsx)
 *
 * The browser writes the cookie after a resize; the request carries it back, and the server render
 * reads it (`storedPanelLayouts`, from the chat layout's loader) while the browser reads its own
 * live cookie, so the two agree on the layout the first render uses.
 */

const COOKIE_PREFIX = "coforge-layout-";
const MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

/** The saved layouts, by the storage key `react-resizable-panels` reads and writes them under. */
export type StoredPanelLayouts = Readonly<Record<string, string>>;

/** No layouts saved: one object, so what is memoized on it keeps. */
export const NO_PANEL_LAYOUTS: StoredPanelLayouts = {};

const cookieName = (key: string) => `${COOKIE_PREFIX}${encodeURIComponent(key)}`;

function decode(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

/** Whether a value is a layout — panel id to size, as the library saves it. A cookie is user
 * input, and the library parses whatever it is given, so anything else is ignored. */
function isLayout(value: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value);
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      Object.values(parsed).every((size) => typeof size === "number" && Number.isFinite(size))
    );
  } catch {
    return false;
  }
}

/** The layouts a `Cookie` header carries. Nothing else in it is kept: the result is sent to the
 * browser with the page, and the header holds the session. */
export function storedPanelLayouts(cookieHeader: string | undefined): StoredPanelLayouts {
  if (!cookieHeader) return NO_PANEL_LAYOUTS;
  const stored: Record<string, string> = {};
  for (const [name, raw] of cookiePairs(cookieHeader)) {
    if (!name.startsWith(COOKIE_PREFIX)) continue;
    const key = decode(name.slice(COOKIE_PREFIX.length));
    const value = decode(raw);
    if (key !== undefined && value !== undefined && isLayout(value)) stored[key] = value;
  }
  return stored;
}

/**
 * The `useDefaultLayout` storage. On the server it reads the layouts the request carried; in the
 * browser it reads and writes the live cookie, which is what the server saw when it rendered.
 */
export function panelLayoutStorage(onServer: StoredPanelLayouts): LayoutStorage {
  return {
    getItem(key) {
      const stored =
        typeof document === "undefined" ? onServer : storedPanelLayouts(document.cookie);
      return stored[key] ?? null;
    },
    setItem(key, value) {
      if (typeof document === "undefined") return;
      saveBrowserCookie(cookieName(key), value, MAX_AGE_SECONDS);
    },
  };
}
