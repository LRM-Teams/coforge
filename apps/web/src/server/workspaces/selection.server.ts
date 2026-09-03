import { getRequest, setResponseHeader } from "@tanstack/react-start/server";
import type { PrismaClient } from "../../../generated/client";

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

export function requireWorkspaceIdForRequest(db: PrismaClient, userId: string): Promise<string> {
  return requireExistingWorkspaceId(db, userId, preferredWorkspaceSlugFromRequest());
}
