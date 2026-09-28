import { describe, expect, test } from "bun:test";
import { isRecord } from "./json-record";

describe("isRecord", () => {
  test("accepts a plain object, including an empty one", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord(Object.create(null) as object)).toBe(true);
  });

  test("rejects arrays: they are objects, but not records", () => {
    expect(isRecord([])).toBe(false);
    expect(isRecord([{ a: 1 }])).toBe(false);
  });

  test("rejects everything that is not an object at all", () => {
    expect(isRecord(null)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
    expect(isRecord("{}")).toBe(false);
    expect(isRecord(0)).toBe(false);
    expect(isRecord(false)).toBe(false);
    expect(isRecord(() => {})).toBe(false);
  });
});
