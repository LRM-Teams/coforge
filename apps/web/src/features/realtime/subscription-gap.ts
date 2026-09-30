import type { SubscribedContext } from "centrifuge/build/protobuf";

/** A place in a channel's stream: its `epoch` and the `offset` of a publication in it. */
export type StreamPosition = { offset: number; epoch: string };

/** Stream positions by channel name. */
export type StreamPositions = Readonly<Record<string, StreamPosition>>;

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
 * The positions a list built from two reads stands at: per channel, the older of the two, since
 * the list may lack what either read did. A channel only one read has a position for, or whose
 * two positions are in different epochs (an offset is meaningful only within its epoch), has none.
 */
export function olderStreamPositions(
  left: StreamPositions,
  right: StreamPositions,
): StreamPositions {
  const older: Record<string, StreamPosition> = {};
  for (const [channel, first] of Object.entries(left)) {
    const second = right[channel];
    if (second && second.epoch === first.epoch)
      older[channel] = first.offset <= second.offset ? first : second;
  }
  return older;
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
