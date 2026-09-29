/**
 * The largest wire payload one Centrifugo RPC message may carry. A whole RPC result travels as a
 * single publish, and the deployed transport limit is `websocket.message_size_limit` — 2 MiB in
 * `infra/centrifugo/config.yaml` and `infra/staging/centrifugo/config.yaml`, raised from the 64 KiB
 * default because a Workspace File read (up to 1 MiB of text) and the Code Agent inventory exceed
 * it, as those files' own comments record. Over the limit Centrifugo closes the socket with
 * "message too big", which the client treats as final and never reconnects, so the bound lives
 * below the configured limit rather than at it. Every whole-result bound in this package derives
 * from this one; `rpc-payload-limit.test.ts` fails if this constant or the configured limit moves
 * past that relationship.
 */
export const RPC_PAYLOAD_MAX_BYTES = 1_048_576;

/** Refuses a wire payload larger than `maxBytes`, before it is encoded or decoded further. */
export function boundedPayload(bytes: Uint8Array, maxBytes: number, label: string): Uint8Array {
  if (bytes.length > maxBytes) throw new Error(`${label} payload too large`);
  return bytes;
}
