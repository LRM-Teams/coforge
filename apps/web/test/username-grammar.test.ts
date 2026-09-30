import { expect, test } from "bun:test";

import { STORED_USERNAME_SOURCE, USERNAME_PATTERN } from "#src/lib/username-grammar";

const STORED_USERNAME = new RegExp(`^${STORED_USERNAME_SOURCE}$`);

test("an allocated username starts with a letter and is 3 to 32 characters", () => {
  for (const name of [
    "ada",
    "a1b",
    "ada-lovelace",
    "ada_lovelace",
    "ada-2",
    "u1049208871",
    "a".repeat(32),
    "grace-12ab34cd",
  ]) {
    expect(USERNAME_PATTERN.test(name)).toBe(true);
  }
});

test("a username that is too short, too long, or not letter-first is not allocated", () => {
  for (const name of [
    "",
    "a",
    "ab",
    "a".repeat(33),
    "1ada",
    "1049208871",
    "-ada",
    "_ada",
    "ada-",
    "ada_",
    "Ada",
    "ada lovelace",
    "ada.lovelace",
    "安栋",
  ]) {
    expect(USERNAME_PATTERN.test(name)).toBe(false);
  }
});

test("every allocated shape is also a shape a stored username may have", () => {
  for (const name of ["ada", "a1b", "ada-2", "u1049208871", "a".repeat(32)]) {
    expect(USERNAME_PATTERN.test(name)).toBe(true);
    expect(STORED_USERNAME.test(name)).toBe(true);
  }
});

test("a username stored before letter-first allocation is still a valid target shape", () => {
  // Accounts created before this rule keep these names until they are renamed.
  for (const name of ["1049208871-2df895c9", "a", "9lives"]) {
    expect(STORED_USERNAME.test(name)).toBe(true);
    expect(USERNAME_PATTERN.test(name)).toBe(false);
  }
  for (const name of ["andong3-d9956ab1", "user-0a1b2c3d"]) {
    expect(STORED_USERNAME.test(name)).toBe(true);
    expect(USERNAME_PATTERN.test(name)).toBe(true);
  }
  for (const name of ["", "ab", "-ada", "ada-", "Ada", "a".repeat(33)]) {
    expect(STORED_USERNAME.test(name)).toBe(false);
  }
});
