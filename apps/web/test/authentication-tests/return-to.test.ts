import { expect, test } from "bun:test";

import { localizedReturnHref, safeReturnTo, signInHref } from "#src/features/auth/return-to";

test("a same-site page path is a place to return to after signing in", () => {
  expect(safeReturnTo("/w/x/channel/1?view=chat")).toBe("/w/x/channel/1?view=chat");
  expect(safeReturnTo("/join/abc")).toBe("/join/abc");
  expect(safeReturnTo("/oauth/verify?user_code=AB-CD")).toBe("/oauth/verify?user_code=AB-CD");
});

test("anything that could leave CoForge is not a place to return to", () => {
  for (const value of [
    "//evil.com",
    "https://evil.com",
    "/\\evil",
    "javascript:alert(1)",
    "",
    "w/x",
    // Browsers drop tabs and newlines from URLs, which would turn this into `//evil.com`.
    "/\t/evil.com",
    "/\n/evil.com",
    undefined,
    42,
  ]) {
    expect(safeReturnTo(value)).toBeUndefined();
  }
});

test("the page to return to keeps the locale prefix CoForge pages carry, and none on /oauth", () => {
  expect(localizedReturnHref("/w/x/channel/1?view=chat")).toBe("/en/w/x/channel/1?view=chat");
  expect(localizedReturnHref("/oauth/verify?user_code=AB-CD")).toBe(
    "/oauth/verify?user_code=AB-CD",
  );
});

test("signing in starts at /auth/login and carries the page to come back to", () => {
  expect(signInHref("/oauth/verify?user_code=AB-CD")).toBe(
    "/auth/login?returnTo=%2Foauth%2Fverify%3Fuser_code%3DAB-CD",
  );
  expect(signInHref(undefined)).toBe("/auth/login");
});
