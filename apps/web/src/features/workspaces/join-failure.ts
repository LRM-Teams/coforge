import { isRedirect } from "@tanstack/react-router";

import { isAppError } from "#src/lib/app-error";

/** Why a join by invite link did not go through, as the invite page tells it. */
export type JoinFailure =
  /** The session ended after the page loaded; joining needs signing in again. */
  | { kind: "signed-out" }
  /** The link was revoked, expired or used up after the page loaded. */
  | { kind: "link-invalid" }
  /** A lost connection or a server failure; asking again can work. */
  | { kind: "unavailable"; errorId?: string };

/**
 * What a rejected `joinWorkspaceByLink` means. A call that finds no session comes back as a
 * thrown TanStack redirect to sign-in (`authMiddleware`); a plain call never follows it, so the
 * caller decides what to do.
 */
export function joinFailure(error: unknown): JoinFailure {
  if (isRedirect(error)) return { kind: "signed-out" };
  if (isAppError(error)) {
    if (error.code === "NOT_FOUND") return { kind: "link-invalid" };
    if (error.errorId) return { kind: "unavailable", errorId: error.errorId };
  }
  return { kind: "unavailable" };
}
