import { expect, test } from "bun:test";

import { maskEmail } from "#src/code-agent/mask-email";

test("masks the local part like Raft's maskRuntimeAccountEmail", () => {
  // Local part shorter than 8 keeps 1 character and, with 3 remaining, no suffix.
  expect(maskEmail("abcd@gmail.com")).toBe("a****@gmail.com");
  // Local part of 8 keeps 3 + 1 trailing character (min(5, remaining - 4)).
  expect(maskEmail("abcdefgh@gmail.com")).toBe("abc****h@gmail.com");
  // Long local part: up to 5 trailing characters once more than 4 remain.
  expect(maskEmail("abcdefghijkl@gmail.com")).toBe("abc****hijkl@gmail.com");
  // The domain is lowercased; the mask marker is always present.
  expect(maskEmail("short@EXAMPLE.COM")).toBe("s****@example.com");
});

test("drops anything that is not one plain, well-formed address", () => {
  expect(maskEmail("not-an-email")).toBeUndefined();
  expect(maskEmail("")).toBeUndefined();
  expect(maskEmail("a@b")).toBeUndefined();
  expect(maskEmail("ex..ample@example.com")).toBeUndefined();
  expect(maskEmail(".lead@example.com")).toBeUndefined();
  expect(maskEmail("user@-bad.example.com")).toBeUndefined();
  expect(maskEmail("two@words@example.com")).toBeUndefined();
  expect(maskEmail("user name@example.com")).toBeUndefined();
  expect(maskEmail(`${"x".repeat(300)}@example.com`)).toBeUndefined();
});
