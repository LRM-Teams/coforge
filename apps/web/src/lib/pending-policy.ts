/**
 * One policy for the router's pending fallback, in one place.
 *
 * `pendingMs` delays the fallback so a fast load never shows one; `pendingMinMs` is how long it
 * stays once it does show. They are deliberately equal: a fallback that appears at the delay
 * boundary and vanishes a frame later reads as a glitch rather than as loading, which is exactly
 * what a channel open did (#112/#113). Below the delay nothing renders; at or above it the
 * skeleton is up long enough to read.
 *
 * These values are the router's defaults (`getRouter`), so no route restates them. A route that
 * genuinely needs a different pending behaviour states it, and `pending-policy.test.ts` fails if a
 * route quietly re-introduces the delay or the minimum.
 */
export const PENDING_DELAY_MS = 300;
export const PENDING_MIN_MS = PENDING_DELAY_MS;
