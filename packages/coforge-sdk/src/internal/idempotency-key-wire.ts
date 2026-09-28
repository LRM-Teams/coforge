/**
 * The Agent HTTP path names a request's idempotency key `idempotencyKey`, while every protobuf
 * schema that still carries the same value — the local RPC over the Unix socket and the reminder
 * messages — names it `request_id`. This pair is the one place the two names meet: an HTTP-path
 * shape is written to a protobuf init with `requestId`, and a decoded message is read back under
 * `idempotencyKey`. Neither name is ever carried alongside the other.
 */
export function toWireRequestId<T extends { idempotencyKey: string }>(value: T) {
  const { idempotencyKey, ...fields } = value;
  return { ...fields, requestId: idempotencyKey };
}
export function fromWireRequestId<T extends { requestId: string }>(value: T) {
  const { requestId, ...fields } = value;
  return { ...fields, idempotencyKey: requestId };
}
