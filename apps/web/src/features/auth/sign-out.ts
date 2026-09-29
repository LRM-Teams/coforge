import { forgetQueryCache } from "#src/features/cache-persistence/browser-query-cache";

/** Longest a sign-out waits for the browser's storage: one that hangs must not keep anyone signed in. */
const FORGET_TIMEOUT_MS = 2_000;

/**
 * Signs out of this browser: what this person's pages kept in it (`features/cache-persistence/`)
 * goes first, then a full navigation to `/auth/logout` clears the session cookie and sends the
 * browser to Authing. `href` carries a `returnTo` for signing in again as someone else.
 */
export async function signOut(href = "/auth/logout") {
  await Promise.race([
    forgetQueryCache().catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, FORGET_TIMEOUT_MS)),
  ]);
  window.location.assign(href);
}
