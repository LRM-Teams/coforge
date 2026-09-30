import type { SubscribedContext } from "centrifuge/build/protobuf";

/** A place in a channel's stream: its `epoch` and the `offset` of a publication in it. */
export type StreamPosition = { offset: number; epoch: string };

/**
 * The two flags of a Centrifuge `subscribed` event that say what the subscribe replayed, and, on a
 * channel whose namespace keeps history, where the stream stands for the subscription whenever it
 * is asked: where it started, moved on by every publication it has delivered since.
 */
export type SubscribedRecovery = Pick<SubscribedContext, "wasRecovering" | "recovered"> & {
  position?: () => StreamPosition | undefined;
};

/**
 * Whether a read taken at stream position `read` may lack a publication the subscription at
 * `subscribed` will never deliver: every publication up to `read` was published, so written,
 * before the read; everything after `subscribed` reaches the subscription. It rests on reading the
 * position before the data, as Centrifugo's own state-loading recipe does
 * (https://centrifugal.dev/docs/server/history_and_recovery). Without either position, or across an
 * epoch change (the stream was reset), it may.
 */
export function streamMovedSince(
  read: StreamPosition | undefined,
  subscribed: StreamPosition | undefined,
): boolean {
  if (!read || !subscribed || read.epoch !== subscribed.epoch) return true;
  return read.offset < subscribed.offset;
}

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
