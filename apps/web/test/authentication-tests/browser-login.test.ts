import { expect, test } from "bun:test";

import {
  completeBrowserLogin,
  endBrowserLogin,
  readBrowserSession,
  startBrowserLogin,
  type TokenExchanger,
} from "../../src/server/auth/browser-login.server";

const sessionSecret = "test-session-secret-at-least-32-characters";
const config = {
  appId: "6a8fde6fa804dd3bea560bac",
  appSecret: "test-app-secret",
  issuer: "https://coforge.authing.cn/oidc",
  authorizationEndpoint: "https://coforge.authing.cn/oidc/auth",
  tokenEndpoint: "https://coforge.authing.cn/oidc/token",
  userinfoEndpoint: "https://coforge.authing.cn/oidc/me",
  endSessionEndpoint: "https://coforge.authing.cn/oidc/session/end",
  redirectUri: "http://localhost:3000/auth/callback",
};

function fakeAuthing(user: {
  sub: string;
  email?: string;
  name?: string;
  preferred_username?: string;
}): TokenExchanger {
  return {
    async exchangeAuthorizationCode(input) {
      if (input.code !== "valid-code") throw new Error("invalid authorization code");
      if (input.codeVerifier.length < 32) throw new Error("missing PKCE verifier");
      return { accessToken: "authing-access", idToken: "authing-id-token" };
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
  expect(url.origin + url.pathname).toBe("https://coforge.authing.cn/oidc/auth");
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
  expect(user).not.toHaveProperty("idToken");
});

test("the same Authing subject maps to the same CoForge user", async () => {
  const first = await loginAs("authing-user-1", "ada@example.com");
  const second = await loginAs("authing-user-1", "ada@example.com");
  expect(first.user.id).toBe(second.user.id);
});

test("passes Authing preferred_username to first-identity resolution and stores username", async () => {
  const started = startBrowserLogin({ config, sessionSecret });
  const state = new URL(started.authorizationUrl).searchParams.get("state")!;
  let profile: unknown;
  const completed = await completeBrowserLogin({
    config,
    sessionSecret,
    code: "valid-code",
    state,
    cookieHeader: cookieHeader(started.stateCookie),
    authing: fakeAuthing({
      sub: "provider-subject-not-a-username",
      email: "ada@example.com",
      preferred_username: "ada",
    }),
    resolveUser: async (input) => {
      profile = input;
      return { id: "00000000-0000-5000-8000-000000000002", username: "ada" };
    },
  });
  expect(profile).toEqual({
    provider: "authing",
    subject: "provider-subject-not-a-username",
    email: "ada@example.com",
    preferredUsername: "ada",
  });
  expect(completed.user.username).toBe("ada");
  expect(
    readBrowserSession({ sessionSecret, cookieHeader: cookieHeader(completed.sessionCookie) }),
  ).toMatchObject({ username: "ada" });
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

test("endBrowserLogin clears the session cookie and returns the Authing logout URL", () => {
  const ended = endBrowserLogin({
    config,
    postLogoutRedirectUri: "http://localhost:3000/login",
    sessionSecret,
    cookieHeader: "",
  });
  expect(ended.clearSessionCookie).toContain("coforge_session=");
  expect(ended.clearSessionCookie).toContain("Max-Age=0");
  expect(ended.clearSessionCookie).toContain("HttpOnly");
  const authingLogout = new URL(ended.authingLogoutUrl);
  expect(authingLogout.searchParams.get("post_logout_redirect_uri")).toBe(
    "http://localhost:3000/login",
  );
  expect(authingLogout.searchParams.get("id_token_hint")).toBeNull();
});

test("endBrowserLogin sends Authing the id_token hint so it can redirect back", async () => {
  const started = startBrowserLogin({ config, sessionSecret });
  const state = new URL(started.authorizationUrl).searchParams.get("state");
  if (!state) throw new Error("state missing");
  const completed = await completeBrowserLogin({
    config,
    sessionSecret,
    code: "valid-code",
    state,
    cookieHeader: cookieHeader(started.stateCookie),
    authing: fakeAuthing({ sub: "authing-user-1", email: "ada@example.com", name: "Ada" }),
  });
  const ended = endBrowserLogin({
    config,
    postLogoutRedirectUri: "http://localhost:3000/login",
    sessionSecret,
    cookieHeader: cookieHeader(completed.sessionCookie),
  });
  const authingLogout = new URL(ended.authingLogoutUrl);
  expect(authingLogout.searchParams.get("id_token_hint")).toBe("authing-id-token");
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
