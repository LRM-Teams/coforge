import { expect, test } from "bun:test";
import { isRedirect } from "@tanstack/react-router";

import { requireBrowserUser } from "#src/server/auth/require-user.server";

async function loginRedirect(returnTo?: string): Promise<string | undefined> {
  const previous = {
    COFORGE_SESSION_SECRET: process.env.COFORGE_SESSION_SECRET,
    COFORGE_DEV_SKIP_AUTH: process.env.COFORGE_DEV_SKIP_AUTH,
  };
  process.env.COFORGE_SESSION_SECRET = "test-session-secret-at-least-32-characters";
  delete process.env.COFORGE_DEV_SKIP_AUTH;
  try {
    await requireBrowserUser(undefined, returnTo);
  } catch (error) {
    if (isRedirect(error)) return error.options.href;
    throw error;
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  throw new Error("expected a redirect to /login");
}

test("a signed-out visitor is sent to /login with the page to come back to", async () => {
  expect(await loginRedirect("/oauth/verify?user_code=AB-CD")).toBe(
    "/login?returnTo=%2Foauth%2Fverify%3Fuser_code%3DAB-CD",
  );
});

test("without a same-site page to come back to, /login carries no returnTo", async () => {
  expect(await loginRedirect()).toBe("/login");
  expect(await loginRedirect("/")).toBe("/login");
  expect(await loginRedirect("//evil.com")).toBe("/login");
});
