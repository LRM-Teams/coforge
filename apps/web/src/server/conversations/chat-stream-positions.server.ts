import type { StreamPositions } from "#src/features/realtime/subscription-gap";
import {
  createCentrifugoServerApi,
  type CentrifugoStreams,
} from "#src/server/centrifugo/server-api.server";

/** How long a list read waits for the positions before it goes on without them. */
const POSITIONS_TIMEOUT_MS = 500;

function configuredStreams(env = process.env) {
  if (!env.COFORGE_CENTRIFUGO_API_URL || !env.COFORGE_CENTRIFUGO_API_KEY) return null;
  return createCentrifugoServerApi(env, { timeoutMs: POSITIONS_TIMEOUT_MS });
}

/**
 * The current stream positions of the Chat signal channels a list read keeps consistent with. Read
 * them before the list itself, Centrifugo's recipe for loading state and then subscribing
 * (https://centrifugal.dev/docs/server/history_and_recovery): whatever was published up to them was
 * written before the read, so a page whose subscription starts no later than them missed nothing
 * the list lacks (`streamMovedSince`). Without Centrifugo, or when it does not answer in time,
 * there are none, and the page re-reads the list once it has subscribed.
 */
export async function chatStreamPositions(
  channels: string[],
  streams: CentrifugoStreams | null = configuredStreams(),
): Promise<StreamPositions> {
  if (!streams) return {};
  try {
    return await streams.streamPositions(channels);
  } catch {
    console.warn(JSON.stringify({ event: "chat_stream_positions.unavailable" }));
    return {};
  }
}

/**
 * A list read with the positions of the signal channels that keep it live: the positions are read
 * first and `read` starts only after they have answered, never alongside them, or the list could
 * hold rows written after the positions it claims (see `chatStreamPositions`). `read` is the
 * list's own read; its failure is the caller's, and only the positions fall back to none.
 */
export async function readAfterStreamPositions<T>(
  channels: string[],
  read: () => Promise<T>,
  streams?: CentrifugoStreams | null,
): Promise<{ streamPositions: StreamPositions; data: T }> {
  const streamPositions = await chatStreamPositions(channels, streams);
  return { streamPositions, data: await read() };
}
