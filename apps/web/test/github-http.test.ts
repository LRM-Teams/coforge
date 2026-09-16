import { expect, test } from "bun:test";
import {
  GITHUB_INSTALL_STATE_COOKIE,
  GITHUB_STATE_COOKIE,
  githubCallbackHandler,
  githubInstallationStateCookie,
  validGitHubInstallationState,
} from "../src/server/integrations/github-http.server";

test("GitHub installation state is one-time, HttpOnly, and compared exactly", () => {
  const state = "state-for-this-browser";
  expect(githubInstallationStateCookie(state)).toContain(
    `__Host-coforge-github-install-state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
  );
  expect(validGitHubInstallationState(state, state)).toBe(true);
  expect(validGitHubInstallationState(state, `${state}-other`)).toBe(false);
  expect(validGitHubInstallationState("", "")).toBe(false);
  expect(validGitHubInstallationState("x".repeat(257), "x".repeat(257))).toBe(false);
  expect(githubInstallationStateCookie("")).toContain("Max-Age=0");
});

test("GitHub installation returns through the authorization callback", async () => {
  const previousSkipAuth = process.env.COFORGE_DEV_SKIP_AUTH;
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.COFORGE_DEV_SKIP_AUTH = "1";
  process.env.NODE_ENV = "development";
  try {
    const state = "installation-state-for-this-browser";
    const response = await githubCallbackHandler({
      request: new Request(
        `https://coforge.test/api/integrations/github/callback?setup_action=install&installation_id=123&state=${state}`,
        { headers: { cookie: `${GITHUB_INSTALL_STATE_COOKIE}=${state}` } },
      ),
    });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/settings?section=integrations");
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${GITHUB_INSTALL_STATE_COOKIE}=`);
    expect(cookie).not.toContain(GITHUB_STATE_COOKIE);
  } finally {
    if (previousSkipAuth === undefined) delete process.env.COFORGE_DEV_SKIP_AUTH;
    else process.env.COFORGE_DEV_SKIP_AUTH = previousSkipAuth;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});
