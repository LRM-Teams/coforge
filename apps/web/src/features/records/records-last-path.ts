/** Session recall for the Records sidebar entry: leave 周报 for Agents/Projects, come back to the same path. */

export const DEFAULT_RECORDS_NAV_HREF = "/records?tab=weekly";

const STORAGE_PREFIX = "coforge-records-last-path:";
const MAX_PATH_LENGTH = 300;

type PathStorage = Pick<Storage, "getItem" | "setItem">;

function storageKey(workspaceKey: string) {
  return `${STORAGE_PREFIX}${workspaceKey}`;
}

/** Only allow in-app Records paths (no open redirect). Wider than `sanitizeRecordsReturnTo`:
 * the sidebar may restore `/records` or `/records?tab=…`, not only `/records/…`. */
export function sanitizeRecordsLastPath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (value !== "/records" && !value.startsWith("/records?") && !value.startsWith("/records/"))
    return undefined;
  if (value.includes("://") || value.includes("\\") || value.includes("\n")) return undefined;
  // Block path traversal that would leave Records (`/records/../agents`).
  if (value.includes("/../") || value.endsWith("/..")) return undefined;
  if (value.length > MAX_PATH_LENGTH) return undefined;
  return value;
}

function browserSessionStorage(): PathStorage | undefined {
  try {
    if (typeof sessionStorage === "undefined") return undefined;
    return sessionStorage;
  } catch {
    return undefined;
  }
}

export function rememberRecordsLastPath(
  workspaceKey: string,
  href: string,
  storage: PathStorage | undefined = browserSessionStorage(),
): void {
  if (!workspaceKey || !storage) return;
  const safe = sanitizeRecordsLastPath(href);
  if (!safe) return;
  try {
    storage.setItem(storageKey(workspaceKey), safe);
  } catch {
    // Quota / private mode: skip quietly; next visit uses the default landing.
  }
}

export function recallRecordsLastPath(
  workspaceKey: string,
  storage: PathStorage | undefined = browserSessionStorage(),
): string | undefined {
  if (!workspaceKey || !storage) return undefined;
  try {
    return sanitizeRecordsLastPath(storage.getItem(storageKey(workspaceKey)));
  } catch {
    return undefined;
  }
}

/** Href the AppShell Records item should navigate to for this Workspace. */
export function recordsNavHref(
  workspaceKey: string,
  storage: PathStorage | undefined = browserSessionStorage(),
  fallback: string = DEFAULT_RECORDS_NAV_HREF,
): string {
  return recallRecordsLastPath(workspaceKey, storage) ?? fallback;
}
