/**
 * Standard base64 (RFC 4648 §4), written out rather than delegated: this module also reaches the
 * browser bundle, which has no `Buffer`, and `Uint8Array.prototype.toBase64` is too new to rely
 * on. Both directions are exact inverses and `decodeBase64` is strict — the only accepted input is
 * what `encodeBase64` (or `Buffer.prototype.toString("base64")`) produces for some byte string, so
 * a payload cannot arrive with two spellings and be compared as if it had one.
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const DIGITS = new Map<string, number>([...ALPHABET].map((character, digit) => [character, digit]));

export function encodeBase64(bytes: Uint8Array): string {
  let encoded = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]!;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    encoded += ALPHABET[first >> 2];
    encoded += ALPHABET[((first & 0x03) << 4) | ((second ?? 0) >> 4)];
    encoded += second === undefined ? "=" : ALPHABET[((second & 0x0f) << 2) | ((third ?? 0) >> 6)];
    encoded += third === undefined ? "=" : ALPHABET[third & 0x3f];
  }
  return encoded;
}

export function decodeBase64(value: string): Uint8Array {
  // A base64 string is a whole number of 4-character groups; anything else is not one at all.
  if (value.length % 4 !== 0) throw new Error("Invalid base64 length");
  const bytes = new Uint8Array((value.length / 4) * 3);
  let offset = 0;
  const trailingPadding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  for (let index = 0; index < value.length; index += 4) {
    const lastGroup = index + 4 === value.length;
    // Padding is only ever the tail of the final group; `=` anywhere else is not base64.
    const padding = lastGroup ? trailingPadding : 0;
    if (!lastGroup && (value[index + 2] === "=" || value[index + 3] === "="))
      throw new Error("Invalid base64 padding");
    const digits: number[] = [];
    for (let position = 0; position < 4 - padding; position++) {
      const digit = DIGITS.get(value[index + position]!);
      if (digit === undefined) throw new Error("Invalid base64 character");
      digits.push(digit);
    }
    // Refuse a group whose unused trailing bits are set: `Zh==` decodes to `f` the way `Zg==` does,
    // so accepting it would admit a second spelling of the same bytes.
    if (padding === 2 && (digits[1]! & 0x0f) !== 0) throw new Error("Invalid base64 padding");
    if (padding === 1 && (digits[2]! & 0x03) !== 0) throw new Error("Invalid base64 padding");
    const group =
      (digits[0]! << 18) | ((digits[1] ?? 0) << 12) | ((digits[2] ?? 0) << 6) | (digits[3] ?? 0);
    bytes[offset++] = (group >> 16) & 0xff;
    if (padding < 2) bytes[offset++] = (group >> 8) & 0xff;
    if (padding < 1) bytes[offset++] = group & 0xff;
  }
  return bytes.subarray(0, offset);
}
