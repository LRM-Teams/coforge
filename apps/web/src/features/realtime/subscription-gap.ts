import type { SubscribedContext } from "centrifuge/build/protobuf";

/** The two flags of a Centrifuge `subscribed` event that say what the subscribe replayed. */
export type SubscribedRecovery = Pick<SubscribedContext, "wasRecovering" | "recovered">;

/**
 * What a page may have missed before a subscription became `subscribed`, read from the event's
 * recovery flags (https://centrifugal.dev/docs/transports/client_api):
 * - `"unrecovered"`: the subscribe did not try to recover (`wasRecovering` false) — a channel's
 *   first subscribe, or any resubscribe on a namespace without history. Nothing published before
 *   it reaches the page.
 * - `"lost"`: a resubscribe tried to recover but the stream no longer held every missed
 *   publication.
 * - `"none"`: the resubscribe replayed every missed publication.
 */
export function subscriptionGap({
  wasRecovering,
  recovered,
}: SubscribedRecovery): "unrecovered" | "lost" | "none" {
  if (!wasRecovering) return "unrecovered";
  return recovered ? "none" : "lost";
}
