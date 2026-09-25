import { describe, expect, test } from "bun:test";

import { isFile } from "#src/server/attachments/upload-file.server";

describe("isFile", () => {
  test("accepts a real File", () => {
    expect(isFile(new File(["hello"], "note.txt"))).toBe(true);
  });

  test("accepts the duck-typed shape from another realm", () => {
    // What matters is that the routes can read it, not which constructor made it.
    const crossRealm = {
      name: "note.txt",
      size: 5,
      arrayBuffer: async () => new ArrayBuffer(5),
    };
    expect(isFile(crossRealm)).toBe(true);
  });

  test("rejects anything the routes could not read", () => {
    expect(isFile(undefined)).toBe(false);
    expect(isFile(null)).toBe(false);
    expect(isFile("note.txt")).toBe(false);
    expect(isFile({ name: "note.txt", size: 5 })).toBe(false); // no arrayBuffer
    expect(isFile({ name: 5, size: 5, arrayBuffer: () => {} })).toBe(false); // name is not a string
    expect(isFile({ name: "a", size: "5", arrayBuffer: () => {} })).toBe(false); // size is not a number
  });
});
