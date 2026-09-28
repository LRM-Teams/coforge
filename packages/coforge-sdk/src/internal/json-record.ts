/**
 * The one "is this a JSON record" test: a non-null object that is not an array.
 *
 * The `!Array.isArray` half is the part worth naming. An array *is* an object, so a reader that
 * forgets it happily treats `[]` as a record and then reads named fields off it — which is why the
 * daemon's HTTP wire validation and the web RPC handler's payload readers both spell the clause out.
 *
 * Three copies lived in this shape: two in the daemon (`agent-http-wire.ts` as a type guard, and
 * `code-agent/json-record.ts`'s `asRecord`, which returns the record rather than a boolean) and one
 * in `apps/web/src/server/centrifugo/rpc-handler.server.ts` (where it was called `record`). The two
 * record-returning forms now delegate here, so only the answer shape differs between callers.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
