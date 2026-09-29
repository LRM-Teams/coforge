import { getDatabaseClient } from "#src/server/db/client.server";
import { PrismaDeviceAuthorizationStore } from "#src/server/db/repositories/device-auth.repositories.server";
import type { DeviceAuthorizationStore } from "./device-auth.server";

/**
 * The device-authorization store, or `undefined` when this deployment has no database.
 *
 * Both surfaces of the flow need the same store and both read its absence as "the flow is not
 * available here": the browser half (`features/device-auth`) answers with the typed state
 * `"unavailable"` in its result, and the OAuth half (`device-auth-http.server.ts`) answers 503
 * `{"error":"temporarily_unavailable"}` with `cache-control: no-store`. Those two answers belong to
 * their surfaces; only the resolution is shared, which is also why this returns an optional store
 * instead of using `requireDatabaseClient()`: that one throws `AppError("TEMPORARILY_UNAVAILABLE")`
 * and would decide both answers — the server function would stop returning its `"unavailable"`
 * state at all.
 */
export function deviceAuthorizationStore(): DeviceAuthorizationStore | undefined {
  const db = getDatabaseClient();
  return db ? new PrismaDeviceAuthorizationStore(db) : undefined;
}
