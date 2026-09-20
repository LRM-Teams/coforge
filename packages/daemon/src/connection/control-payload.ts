/** How many top-level fields a shape names before it stops. A control payload that repeats a
 * field far past this is already identified by what came first. */
const SHAPE_FIELD_LIMIT = 12;

const WIRE_NAMES = new Map([
  [0, "varint"],
  [1, "i64"],
  [2, "len"],
  [5, "i32"],
]);

/**
 * The top-level protobuf fields a rejected control payload carries - their numbers, their wire
 * types, and the length of each length-delimited one - and never their contents.
 *
 * A payload no decoder accepts leaves nothing else behind to identify it by: the decoders report
 * how they failed, not what they were given, so an Agent that never woke up used to be
 * indistinguishable from noise on the wire. This names the message shape well enough to match it
 * against a schema, while a field's value - which may be message text or a credential - never
 * reaches the log.
 */
export function controlPayloadShape(data: Uint8Array): string {
  if (data.byteLength === 0) return "empty";
  const fields: string[] = [];
  let offset = 0;
  while (offset < data.byteLength) {
    if (fields.length === SHAPE_FIELD_LIMIT) return `${fields.join(",")},…`;
    const key = readVarint(data, offset);
    if (!key) return truncated(fields, offset);
    const field = key.value >>> 3;
    const wire = key.value & 7;
    const name = WIRE_NAMES.get(wire);
    if (!name || field === 0) return `${[...fields, `${field}:wire${wire}?`].join(",")}`;
    offset = key.offset;
    if (wire === 0) {
      const value = readVarint(data, offset);
      if (!value) return truncated([...fields, `${field}:varint`], offset);
      offset = value.offset;
      fields.push(`${field}:varint`);
      continue;
    }
    if (wire === 1 || wire === 5) {
      const width = wire === 1 ? 8 : 4;
      if (offset + width > data.byteLength)
        return truncated([...fields, `${field}:${name}`], offset);
      offset += width;
      fields.push(`${field}:${name}`);
      continue;
    }
    const length = readVarint(data, offset);
    if (!length) return truncated([...fields, `${field}:len`], offset);
    fields.push(`${field}:len(${length.value})`);
    offset = length.offset + length.value;
    if (offset > data.byteLength) return truncated(fields, data.byteLength);
  }
  return fields.join(",");
}

function truncated(fields: string[], offset: number): string {
  return `${fields.join(",")}${fields.length ? "," : ""}truncated@${offset}`;
}

function readVarint(data: Uint8Array, start: number): { value: number; offset: number } | null {
  let value = 0;
  let shift = 0;
  for (let offset = start; offset < data.byteLength && shift <= 28; offset++) {
    const byte = data[offset]!;
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: value >>> 0, offset: offset + 1 };
    shift += 7;
  }
  return null;
}
