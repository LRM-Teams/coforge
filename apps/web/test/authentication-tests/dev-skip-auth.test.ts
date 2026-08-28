import { expect, test } from "bun:test";

import { DEV_BROWSER_USER, isDevSkipAuthEnabled } from "../../src/server/auth/dev-skip-auth.server";
import { optionalBrowserUser, requireBrowserUser } from "../../src/server/auth/require-user.server";

test("isDevSkipAuthEnabled is off by default", () => {
  expect(isDevSkipAuthEnabled({ NODE_ENV: "development" })).toBe(false);
  expect(isDevSkipAuthEnabled({ NODE_ENV: "development", COFORGE_DEV_SKIP_AUTH: "" })).toBe(false);
});

test("isDevSkipAuthEnabled accepts common truthy values in non-production", () => {
  expect(isDevSkipAuthEnabled({ NODE_ENV: "development", COFORGE_DEV_SKIP_AUTH: "1" })).toBe(true);
  expect(isDevSkipAuthEnabled({ NODE_ENV: "development", COFORGE_DEV_SKIP_AUTH: "true" })).toBe(
    true,
  );
});

test("isDevSkipAuthEnabled is always off in production", () => {
  expect(isDevSkipAuthEnabled({ NODE_ENV: "production", COFORGE_DEV_SKIP_AUTH: "1" })).toBe(false);
});

test("requireBrowserUser returns the fixed dev user without a session cookie", () => {
  const previous = process.env.COFORGE_DEV_SKIP_AUTH;
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.COFORGE_DEV_SKIP_AUTH = "1";
  process.env.NODE_ENV = "development";
  try {
    expect(requireBrowserUser(undefined)).toEqual(DEV_BROWSER_USER);
  } finally {
    if (previous === undefined) delete process.env.COFORGE_DEV_SKIP_AUTH;
    else process.env.COFORGE_DEV_SKIP_AUTH = previous;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});

test("optionalBrowserUser returns the fixed dev user without Authing config", () => {
  const previous = process.env.COFORGE_DEV_SKIP_AUTH;
  const previousNodeEnv = process.env.NODE_ENV;
  const previousSecret = process.env.COFORGE_SESSION_SECRET;
  delete process.env.COFORGE_SESSION_SECRET;
  process.env.COFORGE_DEV_SKIP_AUTH = "1";
  process.env.NODE_ENV = "development";
  try {
    expect(optionalBrowserUser(undefined)).toEqual(DEV_BROWSER_USER);
  } finally {
    if (previous === undefined) delete process.env.COFORGE_DEV_SKIP_AUTH;
    else process.env.COFORGE_DEV_SKIP_AUTH = previous;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousSecret === undefined) delete process.env.COFORGE_SESSION_SECRET;
    else process.env.COFORGE_SESSION_SECRET = previousSecret;
  }
});
