export async function* readLines(stream: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let pending = "";
  for await (const bytes of stream) {
    pending += decoder.decode(bytes, { stream: true });
    let end: number;
    while ((end = pending.indexOf("\n")) !== -1) {
      yield pending.slice(0, end + 1);
      pending = pending.slice(end + 1);
    }
  }
  pending += decoder.decode();
  if (pending) throw new Error("stream ended before newline");
}
