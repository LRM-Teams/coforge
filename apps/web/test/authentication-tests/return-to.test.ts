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

test("a page path with non-ASCII characters comes back percent-encoded, so it fits a Location header", () => {
  expect(safeReturnTo("/oauth/verify?x=项")).toBe("/oauth/verify?x=%E9%A1%B9");
  expect(safeReturnTo("/w/acme/项目")).toBe("/w/acme/%E9%A1%B9%E7%9B%AE");
  expect(() => new Headers({ location: safeReturnTo("/oauth/verify?x=项")! })).not.toThrow();
});

test("dot segments that would resolve to another host are not a place to return to", () => {
  expect(safeReturnTo("/.//evil.com")).toBeUndefined();
  expect(safeReturnTo("/a/..//evil.com")).toBeUndefined();
  expect(safeReturnTo("/w/acme/../../join/abc")).toBe("/join/abc");
});

test("a return path long enough to overflow the sign-in cookie is dropped", () => {
  expect(safeReturnTo(`/w/acme/${"a".repeat(2_041)}`)).toBeUndefined();
  expect(safeReturnTo(`/w/acme/${"a".repeat(2_040)}`)).toHaveLength(2_048);
  expect(safeReturnTo(`/w/acme/${"a".repeat(1_000)}`)).toBe(`/w/acme/${"a".repeat(1_000)}`);
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
