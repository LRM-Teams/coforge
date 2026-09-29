import type { ChannelCreatedEvent, ChannelUpdatedEvent } from "./conversation-realtime";

// Applying the Workspace's channel events (`channel.created.v1`, `channel.updated.v1`) to the
// lists Chat keeps, from the event alone, as Slack's clients apply `channel_created` and
// `channel_rename`. Pure, so the server's list order and the client's agree.

export type ChannelSignal = ChannelCreatedEvent | ChannelUpdatedEvent;

/** One channel as every channel's name lists it (`PublicChannels.names`). */
export type ChannelName = { id: string; name: string; description: string; archived: boolean };

/**
 * Every channel's name after the signal, or undefined when the signal names only ids (an older
 * server) and the names must be read again.
 */
export function channelNamesAfter(
  names: readonly ChannelName[],
  signal: ChannelSignal,
): ChannelName[] | undefined {
  if (signal.type === "channel.updated.v1" && signal.gone)
    return names.filter((channel) => channel.id !== signal.conversationId);
  if (!signal.channel) return undefined;
  const next = { id: signal.conversationId, ...signal.channel };
  return names.some((channel) => channel.id === next.id)
    ? names.map((channel) => (channel.id === next.id ? next : channel))
    : [...names, next];
}

/** The channel list's order: `#general` first, then by name in code point order, so it never
 * depends on the database's collation. */
export function compareChannelNames(left: string, right: string): number {
  if (left === right) return 0;
  if (left === "general") return -1;
  if (right === "general") return 1;
  return left < right ? -1 : 1;
}
