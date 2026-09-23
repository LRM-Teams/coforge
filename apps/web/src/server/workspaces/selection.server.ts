import { getRequest, setResponseHeader } from "@tanstack/react-start/server";
import type { PrismaClient } from "@/generated/prisma/client";

import { requireExistingWorkspaceId } from "./enrollment.server";

const WORKSPACE_COOKIE = "coforge_workspace";

export function readPreferredWorkspaceSlug(cookieHeader: string): string | undefined {
  for (const part of cookieHeader.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === WORKSPACE_COOKIE) {
      const slug = rest.join("=").trim();
      return slug || undefined;
    }
  }
  return undefined;
}

export function serializeWorkspaceCookie(slug: string, secure: boolean): string {
  return [
    `${WORKSPACE_COOKIE}=${slug}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=31536000",
    secure ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

export function preferredWorkspaceSlugFromRequest(): string | undefined {
  return readPreferredWorkspaceSlug(getRequest().headers.get("cookie") ?? "");
}

export function writePreferredWorkspaceSlug(slug: string): void {
  const secure = new URL(getRequest().url).protocol === "https:";
  setResponseHeader("Set-Cookie", serializeWorkspaceCookie(slug, secure));
}

const selectedWorkspaceByRequest = new WeakMap<Request, Map<string, Promise<string>>>();

/**
 * Runs `load` once per (request, userId) and shares the result with later
 * callers on the same request. A rejected load is forgotten so a retry can run.
 */
export function memoizeForRequest(
  request: Request,
  userId: string,
  load: () => Promise<string>,
): Promise<string> {
  let byUser = selectedWorkspaceByRequest.get(request);
  if (!byUser) selectedWorkspaceByRequest.set(request, (byUser = new Map()));
  const cached = byUser.get(userId);
  if (cached) return cached;
  const pending = load();
  byUser.set(userId, pending);
  pending.catch(() => byUser.delete(userId));
  return pending;
}

/**
 * The caller's selected Workspace for this request. During SSR one page load
 * calls many server functions against the same Request, so the lookup runs
 * once per Request and User; a browser call is one Request and pays once.
 */
export function requireWorkspaceIdForRequest(db: PrismaClient, userId: string): Promise<string> {
  return memoizeForRequest(getRequest(), userId, () =>
    requireExistingWorkspaceId(db, userId, preferredWorkspaceSlugFromRequest()),
  );
}
