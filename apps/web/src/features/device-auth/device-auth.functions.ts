import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";

import { requireBrowserUser } from "@/server/auth/require-user.server";
import { userCodeInputSchema } from "./device-auth.schemas";
import {
  approveUserCode,
  denyUserCode,
  lookupUserCode,
  type DeviceAuthorizationStore,
} from "@/server/auth/device-auth.server";
import { getDatabaseClient } from "@/server/db/client.server";
import { PrismaDeviceAuthorizationStore } from "@/server/db/repositories/device-auth.repositories.server";

/**
 * The browser half of the device flow. Every one of these requires a signed-in user - the whole
 * point of the flow is that a Computer with no browser borrows the identity of someone who does
 * have one, so an unauthenticated caller must never be able to settle a grant.
 */

export type DeviceCodeState = "ok" | "unknown" | "expired" | "settled" | "unavailable";

/** Resolves the signed-in user for the approval page, redirecting to /login when there is none -
 * which is what makes "sign in first, then approve" a property of the route rather than an
 * instruction. Exposed as a feature server function, the way every other route reaches user
 * state, so a route file never imports a `@/server/...` module directly. */
export const getDeviceVerifyUser = createServerFn({ method: "GET" }).handler(async () => {
  const user = currentUser();
  return { email: user.email };
});

function resolveStore(): DeviceAuthorizationStore | undefined {
  const db = getDatabaseClient();
  return db ? new PrismaDeviceAuthorizationStore(db) : undefined;
}

function currentUser() {
  return requireBrowserUser(getRequest().headers.get("cookie") ?? undefined);
}

/** Checks a typed code without settling it, so the page can name what is about to be approved
 * before the user commits. Returns only whether the code is actionable - never who started it. */
export const checkDeviceCode = createServerFn({ method: "POST" })
  .validator(userCodeInputSchema)
  .handler(async ({ data }): Promise<{ state: DeviceCodeState; email: string }> => {
    const user = currentUser();
    const store = resolveStore();
    if (!store) return { state: "unavailable", email: user.email };
    const lookup = await lookupUserCode({ store, userCode: data.userCode });
    return {
      state: lookup.found ? "ok" : lookup.reason,
      email: user.email,
    };
  });

export const approveDeviceCode = createServerFn({ method: "POST" })
  .validator(userCodeInputSchema)
  .handler(async ({ data }): Promise<{ state: DeviceCodeState }> => {
    const user = currentUser();
    const store = resolveStore();
    if (!store) return { state: "unavailable" };
    const result = await approveUserCode({ store, userCode: data.userCode, userId: user.id });
    return { state: result.found ? "ok" : result.reason };
  });

export const denyDeviceCode = createServerFn({ method: "POST" })
  .validator(userCodeInputSchema)
  .handler(async ({ data }): Promise<{ state: DeviceCodeState }> => {
    currentUser();
    const store = resolveStore();
    if (!store) return { state: "unavailable" };
    const result = await denyUserCode({ store, userCode: data.userCode });
    return { state: result.found ? "ok" : result.reason };
  });
