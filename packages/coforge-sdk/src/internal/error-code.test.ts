import { describe, expect, test } from "bun:test";
import { hasErrorCode } from "./error-code";

describe("hasErrorCode", () => {
  test("matches a real error carrying the code, and a bare double that only has the code", () => {
    expect(hasErrorCode(Object.assign(new Error("gone"), { code: "ENOENT" }), "ENOENT")).toBe(true);
    // The reason this is a shape check: test doubles throw `{ code }` and nothing else.
    expect(hasErrorCode({ code: "ENOENT" }, "ENOENT")).toBe(true);
    expect(hasErrorCode({ code: "P2002" }, "P2002")).toBe(true);
  });

  test("does not match another code", () => {
    expect(hasErrorCode({ code: "ENOENT" }, "EACCES")).toBe(false);
    expect(hasErrorCode({ code: "P2002" }, "ENOENT")).toBe(false);
  });

  test("does not match values that carry no code at all", () => {
    expect(hasErrorCode(null, "ENOENT")).toBe(false);
    expect(hasErrorCode(undefined, "ENOENT")).toBe(false);
    expect(hasErrorCode("ENOENT", "ENOENT")).toBe(false);
    expect(hasErrorCode(13, "ENOENT")).toBe(false);
    expect(hasErrorCode({ message: "gone" }, "ENOENT")).toBe(false);
    expect(hasErrorCode([], "ENOENT")).toBe(false);
  });
});
