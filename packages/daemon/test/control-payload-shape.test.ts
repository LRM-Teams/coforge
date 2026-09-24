import { expect, test } from "bun:test";
import { controlPayloadShape } from "#src/connection/control-payload";

/** Protobuf wire bytes, written by hand so each test states exactly what arrived. */
function varint(value: number): number[] {
  const bytes: number[] = [];
  let rest = value;
  while (rest > 127) {
    bytes.push((rest & 0x7f) | 0x80);
    rest >>>= 7;
  }
  bytes.push(rest);
  return bytes;
}
const tag = (field: number, wire: number) => varint((field << 3) | wire);
const bytes = (...values: number[][]) => new Uint8Array(values.flat());

test("a payload is named by the fields it carries, never by their values", () => {
  const shape = controlPayloadShape(
    bytes(tag(1, 2), varint(3), [0x61, 0x62, 0x63], tag(2, 0), varint(1)),
  );

  expect(shape).toBe("1:len(3),2:varint");
  expect(shape).not.toContain("abc");
});

test("a payload that ends mid-field says where it ran out", () => {
  const shape = controlPayloadShape(bytes(tag(1, 2), varint(40), [0x61, 0x62]));

  expect(shape).toContain("1:len(40)");
  expect(shape).toContain("truncated");
});

test("an empty payload is reported as empty rather than as a shape", () => {
  expect(controlPayloadShape(new Uint8Array())).toBe("empty");
});

test("fixed-width and group fields are walked without guessing at their contents", () => {
  const shape = controlPayloadShape(
    bytes(tag(1, 5), [1, 2, 3, 4], tag(2, 1), [1, 2, 3, 4, 5, 6, 7, 8]),
  );

  expect(shape).toBe("1:i32,2:i64");
});

test("a shape stays bounded however many fields a payload repeats", () => {
  const many = Array.from({ length: 40 }, (_, index) => [...tag(index + 1, 0), ...varint(1)]);

  const shape = controlPayloadShape(bytes(...many));

  expect(shape.length).toBeLessThanOrEqual(200);
  expect(shape).toContain("…");
});
