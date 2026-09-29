/** Refuses a wire payload larger than `maxBytes`, before it is encoded or decoded further. */
export function boundedPayload(bytes: Uint8Array, maxBytes: number, label: string): Uint8Array {
  if (bytes.length > maxBytes) throw new Error(`${label} payload too large`);
  return bytes;
}
