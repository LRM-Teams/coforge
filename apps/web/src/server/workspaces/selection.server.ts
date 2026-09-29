import { getRequest, setResponseHeader } from "@tanstack/react-start/server";
import type { PrismaClient } from "#src/generated/prisma/client";

import { AppError } from "#src/lib/app-error";
import { PrismaWorkspaceAccess } from "#src/server/db/repositories/setup.repositories.server";
import { workspaceSlugFromPath } from "#src/features/workspaces/workspace-url";
import type { RememberedWorkspace } from "./departure.server";
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

function serializeCookie(value: string, maxAge: number, secure: boolean): string {
  return [
    `${WORKSPACE_COOKIE}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
    secure ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

export function serializeWorkspaceCookie(slug: string, secure: boolean): string {
  return serializeCookie(slug, 31536000, secure);
}

/** Expires the cookie, so `/` no longer names a Workspace. */
export function serializeForgottenWorkspaceCookie(secure: boolean): string {
  return serializeCookie("", 0, secure);
}

export function preferredWorkspaceSlugFromRequest(): string | undefined {
  return readPreferredWorkspaceSlug(getRequest().headers.get("cookie") ?? "");
}

function isSecureRequest(): boolean {
  return new URL(getRequest().url).protocol === "https:";
}

export function writePreferredWorkspaceSlug(slug: string): void {
  setResponseHeader("Set-Cookie", serializeWorkspaceCookie(slug, isSecureRequest()));
}

/** The Workspace `/` returns to, kept in this request's cookie. */
export const rememberedWorkspaceCookie: RememberedWorkspace = {
  read: preferredWorkspaceSlugFromRequest,
  remember: writePreferredWorkspaceSlug,
  forget: () =>
    setResponseHeader("Set-Cookie", serializeForgottenWorkspaceCookie(isSecureRequest())),
};

const workspaceIdByRequest = new WeakMap<Request, Map<string, Promise<string>>>();

/**
 * Runs `load` once per (request, key) and shares the result with later callers on the same
 * request. A rejected load is forgotten so a retry can run.
 */
export function memoizeForRequest(
  request: Request,
  key: string,
  load: () => Promise<string>,
): Promise<string> {
  let byKey = workspaceIdByRequest.get(request);
  if (!byKey) workspaceIdByRequest.set(request, (byKey = new Map()));
  const cached = byKey.get(key);
  if (cached) return cached;
  const pending = load();
  byKey.set(key, pending);
  pending.catch(() => byKey.delete(key));
  return pending;
}

/** The Workspace a URL names, when the User is a member; NOT_FOUND otherwise, never another. */
export async function requireWorkspaceIdForSlug(
  db: PrismaClient,
  userId: string,
  slug: string,
): Promise<string> {
  const workspace = await new PrismaWorkspaceAccess(db).findAccessibleBySlug(slug, { userId });
  if (!workspace) throw new AppError("NOT_FOUND");
  return workspace.id;
}

/**
 * The caller's Workspace for this request: the one the page URL names (`/w/<slug>`), which must
 * be one of the caller's, or else the remembered Workspace for a page outside `/w/<slug>`. A
 * browser call sends its page's slug (`sentSlug`, only a claim until the membership check); during
 * SSR it is read from the page request. One page load calls many server functions against the
 * same Request, so each lookup runs once per Request, User and Workspace named.
 */
export function requireWorkspaceIdForRequest(
  db: PrismaClient,
  userId: string,
  sentSlug?: string,
): Promise<string> {
  const request = getRequest();
  const urlSlug = sentSlug ?? workspaceSlugFromPath(new URL(request.url).pathname);
  if (urlSlug)
    return memoizeForRequest(request, `url:${userId}:${urlSlug}`, () =>
      requireWorkspaceIdForSlug(db, userId, urlSlug),
    );
  return memoizeForRequest(request, `remembered:${userId}`, () =>
    requireExistingWorkspaceId(db, userId, preferredWorkspaceSlugFromRequest()),
  );
}
