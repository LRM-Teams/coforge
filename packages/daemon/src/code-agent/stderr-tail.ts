/**
 * How much of a turn's stderr a failure report carries back. A failure's reason is usually in the
 * last lines, and the whole stream would travel to the server in one RPC message.
 */
const STDERR_TAIL_BYTES = 4_096;

/**
 * Drains a child's stderr into that bounded tail. One decoder for the whole stream, so a multi-byte
 * character split across two chunks still decodes as one; only the last `STDERR_TAIL_BYTES`
 * characters are kept.
 *
 * The three per-turn processes (Cursor, Grok, OpenCode) each read their stderr this way, and each
 * carried its own copy of the loop.
 */
export async function readStderrTail(stderr: AsyncIterable<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let tail = "";
  for await (const chunk of stderr) {
    tail = (tail + decoder.decode(chunk, { stream: true })).slice(-STDERR_TAIL_BYTES);
  }
  return tail;
}
