import { expect, test } from "bun:test";

import { namePrefill } from "#src/features/auth/name-prefill";

// The name field starts with what the sign-in provider reported, when that reads as a name.

test("the provider's name is offered as it is written, normalized", () => {
  expect(namePrefill(" Ada   Lovelace ")).toBe("Ada Lovelace");
  expect(namePrefill("安栋")).toBe("安栋");
});

test("a provider name that is a phone number is not offered", () => {
  for (const value of ["13800138000", "+86 138 0013 8000", "(415) 555-0134", "138-0013-8000"]) {
    expect(namePrefill(value)).toBe("");
  }
});

test("a provider name that is an email address is not offered", () => {
  expect(namePrefill("ada@example.com")).toBe("");
  expect(namePrefill(" Ada.Lovelace+work@mail.example.co.uk ")).toBe("");
});

test("a provider name the field would refuse is not offered", () => {
  expect(namePrefill("")).toBe("");
  expect(namePrefill("   ")).toBe("");
  expect(namePrefill("a".repeat(81))).toBe("");
  expect(namePrefill("Ada\u0000")).toBe("");
  expect(namePrefill("system")).toBe("");
  expect(namePrefill("@ada")).toBe("");
  expect(namePrefill("​")).toBe("");
});

test("a name with digits in it is still a name", () => {
  expect(namePrefill("Ada 2")).toBe("Ada 2");
  expect(namePrefill("R2 D2")).toBe("R2 D2");
});
