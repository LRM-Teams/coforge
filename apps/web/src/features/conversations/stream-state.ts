/**
 * What a message stream may show right now.
 *
 * `docs/design.md:107` allows an empty state "only once the read has completed and the result really
 * is empty". A stream that calls itself empty while a read is still in flight flips between two
 * states in front of the reader - which is what opening a conversation did (#112/#113). The rule
 * lives here, once, so the main stream, a thread pane and a direct conversation all answer it the
 * same way instead of each render site deciding for itself.
 */
export type StreamRead = "loading" | "settled";

export type StreamState = "loading" | "empty" | "messages";

/** The stream's state: content wins, and without content only a settled read may say "empty". */
export function streamState(messageCount: number, read: StreamRead): StreamState {
  if (messageCount > 0) return "messages";
  return read === "loading" ? "loading" : "empty";
}
