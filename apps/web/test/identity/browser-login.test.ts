import { expect, test } from "bun:test";

import {
  completeBrowserLogin,
  endBrowserLogin,
  readBrowserSession,
  startBrowserLogin,
  type TokenExchanger,
} from "../../src/identity/browser-login";

const sessionSecret = "test-session-secret-at-least-32-characters";
const config = {
  appId: "6a8fde6fa804dd3bea560bac",
  appSecret: "test-app-secret",
  issuer: "https://coforge-dev.authing.cn/oidc",
  authorizationEndpoint: "https://coforge-dev.authing.cn/oidc/auth",
  tokenEndpoint: "https://coforge-dev.authing.cn/oidc/token",
  userinfoEndpoint: "https://coforge-dev.authing.cn/oidc/me",
  endSessionEndpoint: "https://coforge-dev.authing.cn/oidc/session/end",
  redirectUri: "http://localhost:3000/auth/callback",
};

function fakeAuthing(user: { sub: string; email?: string; name?: string }): TokenExchanger {
  return {
    async exchangeAuthorizationCode(input) {
      if (input.code !== "valid-code") throw new Error("invalid authorization code");
      if (input.codeVerifier.length < 32) throw new Error("missing PKCE verifier");
      return { accessToken: "authing-access" };
    },
    async fetchUserInfo(accessToken) {
      if (accessToken !== "authing-access") throw new Error("invalid access token");
      return user;
    },
  };
}

test("startBrowserLogin sends the user to Authing with PKCE", () => {
  const started = startBrowserLogin({
    config,
    sessionSecret,
    now: () => 1_700_000_000_000,
  });

  const url = new URL(started.authorizationUrl);
  expect(url.origin + url.pathname).toBe("https://coforge-dev.authing.cn/oidc/auth");
  expect(url.searchParams.get("client_id")).toBe("6a8fde6fa804dd3bea560bac");
  expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:3000/auth/callback");
  expect(url.searchParams.get("response_type")).toBe("code");
  expect(url.searchParams.get("scope")).toBe("openid profile email");
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  expect(url.searchParams.get("code_challenge")).toBeTruthy();
  expect(url.searchParams.get("state")).toBeTruthy();
  expect(started.stateCookie).toContain("HttpOnly");
  expect(started.stateCookie).toContain("SameSite=Lax");
  expect(started.stateCookie).not.toContain("Domain=");
});

test("completeBrowserLogin creates a CoForge user session from Authing", async () => {
  const started = startBrowserLogin({ config, sessionSecret });
  const state = new URL(started.authorizationUrl).searchParams.get("state");
  if (!state) throw new Error("state missing");

  const completed = await completeBrowserLogin({
    config,
    sessionSecret,
    code: "valid-code",
    state,
    cookieHeader: cookieHeader(started.stateCookie),
    authing: fakeAuthing({
      sub: "authing-user-1",
      email: "ada@example.com",
      name: "Ada",
    }),
  });

  expect(completed.user.email).toBe("ada@example.com");
  expect(completed.user.name).toBe("Ada");
  expect(completed.user.authingSub).toBe("authing-user-1");
  expect(completed.user.id).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
  expect(completed.sessionCookie).toContain("coforge_session=");
  expect(completed.sessionCookie).toContain("HttpOnly");
  expect(completed.sessionCookie).toContain("SameSite=Lax");
  expect(completed.sessionCookie).not.toContain("Domain=");
  expect(completed.clearStateCookie).toContain("coforge_oauth_state=");
  expect(completed.clearStateCookie).toContain("Max-Age=0");

  const user = readBrowserSession({
    sessionSecret,
    cookieHeader: cookieHeader(completed.sessionCookie),
  });
  expect(user).toEqual(completed.user);
});

test("the same Authing subject maps to the same CoForge user", async () => {
  const first = await loginAs("authing-user-1", "ada@example.com");
  const second = await loginAs("authing-user-1", "ada@example.com");
  expect(first.user.id).toBe(second.user.id);
});

test("completeBrowserLogin rejects a mismatched or missing state", async () => {
  const started = startBrowserLogin({ config, sessionSecret });

  await expect(
    completeBrowserLogin({
      config,
      sessionSecret,
      code: "valid-code",
      state: "forged-state",
      cookieHeader: cookieHeader(started.stateCookie),
      authing: fakeAuthing({ sub: "authing-user-1", email: "ada@example.com" }),
    }),
  ).rejects.toThrow("invalid login state");
});

test("completeBrowserLogin rejects an Authing account without email", async () => {
  const started = startBrowserLogin({ config, sessionSecret });
  const state = new URL(started.authorizationUrl).searchParams.get("state");
  if (!state) throw new Error("state missing");

  await expect(
    completeBrowserLogin({
      config,
      sessionSecret,
      code: "valid-code",
      state,
      cookieHeader: cookieHeader(started.stateCookie),
      authing: fakeAuthing({ sub: "authing-user-1", name: "No Email" }),
    }),
  ).rejects.toThrow("email is required");
});

test("endBrowserLogin clears the session cookie", () => {
  const ended = endBrowserLogin();
  expect(ended.clearSessionCookie).toContain("coforge_session=");
  expect(ended.clearSessionCookie).toContain("Max-Age=0");
  expect(ended.clearSessionCookie).toContain("HttpOnly");
});

test("readBrowserSession returns null for a missing or tampered cookie", () => {
  expect(readBrowserSession({ sessionSecret, cookieHeader: "" })).toBeNull();
  expect(
    readBrowserSession({
      sessionSecret,
      cookieHeader: "coforge_session=not-a-real-session",
    }),
  ).toBeNull();
});

async function loginAs(sub: string, email: string) {
  const started = startBrowserLogin({ config, sessionSecret });
  const state = new URL(started.authorizationUrl).searchParams.get("state");
  if (!state) throw new Error("state missing");
  return completeBrowserLogin({
    config,
    sessionSecret,
    code: "valid-code",
    state,
    cookieHeader: cookieHeader(started.stateCookie),
    authing: fakeAuthing({ sub, email, name: "Ada" }),
  });
}

function cookieHeader(setCookie: string): string {
  return setCookie.split(";", 1)[0] ?? "";
}
