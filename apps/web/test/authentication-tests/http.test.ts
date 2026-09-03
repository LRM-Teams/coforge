import { expect, test } from "bun:test";

import {
  completeBrowserLogin,
  startBrowserLogin,
} from "../../src/server/auth/browser-login.server";
import {
  handleCurrentUser,
  handleLoginCallback,
  handleLoginStart,
  handleLogout,
} from "../../src/server/auth/http.server";

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

const persistedAda = {
  id: "11111111-1111-4111-8111-111111111111",
  username: "ada",
};

function fakeAuthing() {
  return {
    async exchangeAuthorizationCode() {
      return { accessToken: "authing-access" };
    },
    async fetchUserInfo() {
      return { sub: "authing-user-1", email: "ada@example.com", name: "Ada" };
    },
  };
}

test("login start redirects to Authing and stores a host-only state cookie", () => {
  const response = handleLoginStart({ config, sessionSecret });
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toContain("https://coforge.authing.cn/oidc/auth");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(cookieHeader(response)).toContain("HttpOnly");
  expect(cookieHeader(response)).not.toContain("Domain=");
});

test("current user is unauthorized without a session", () => {
  const response = handleCurrentUser({
    request: new Request("http://localhost:3000/api/me"),
    sessionSecret,
  });
  expect(response.status).toBe(401);
});

test("current user returns the signed-in CoForge user", async () => {
  const started = startBrowserLogin({ config, sessionSecret });
  const state = new URL(started.authorizationUrl).searchParams.get("state");
  if (!state) throw new Error("state missing");
  const completed = await completeBrowserLogin({
    config,
    sessionSecret,
    code: "valid-code",
    state,
    cookieHeader: started.stateCookie.split(";", 1)[0] ?? "",
    authing: {
      async exchangeAuthorizationCode() {
        return { accessToken: "authing-access", idToken: "authing-id-token" };
      },
      async fetchUserInfo() {
        return { sub: "authing-user-1", email: "ada@example.com", name: "Ada" };
      },
    },
  });
  const response = handleCurrentUser({
    request: new Request("http://localhost:3000/api/me", {
      headers: { cookie: completed.sessionCookie.split(";", 1)[0] ?? "" },
    }),
    sessionSecret,
  });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body).toEqual({ user: completed.user });
  expect(JSON.stringify(body)).not.toContain("authing-id-token");
});

test("login callback stores a host-only session cookie and returns home", async () => {
  const started = startBrowserLogin({ config, sessionSecret });
  const state = new URL(started.authorizationUrl).searchParams.get("state");
  if (!state) throw new Error("state missing");
  const response = await handleLoginCallback({
    request: new Request(`http://localhost:3000/auth/callback?code=valid-code&state=${state}`, {
      headers: { cookie: started.stateCookie.split(";", 1)[0] ?? "" },
    }),
    config,
    sessionSecret,
    authing: fakeAuthing(),
    resolveUser: async () => persistedAda,
    enrollUser: async () => {},
  });
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe("/");
  const cookies = response.headers.getSetCookie();
  expect(
    cookies.some((cookie) => cookie.startsWith("coforge_session=") && cookie.includes("HttpOnly")),
  ).toBe(true);
  expect(
    cookies.some(
      (cookie) => cookie.includes("coforge_oauth_state=") && cookie.includes("Max-Age=0"),
    ),
  ).toBe(true);
  expect(cookies.join("\n")).not.toContain("Domain=");
});

test("login callback enrolls the resolved user into a Workspace", async () => {
  const started = startBrowserLogin({ config, sessionSecret });
  const state = new URL(started.authorizationUrl).searchParams.get("state");
  if (!state) throw new Error("state missing");
  const enrolled: string[] = [];
  const response = await handleLoginCallback({
    request: new Request(`http://localhost:3000/auth/callback?code=valid-code&state=${state}`, {
      headers: { cookie: started.stateCookie.split(";", 1)[0] ?? "" },
    }),
    config,
    sessionSecret,
    authing: fakeAuthing(),
    resolveUser: async () => persistedAda,
    enrollUser: async (userId) => {
      enrolled.push(userId);
    },
  });
  expect(response.status).toBe(302);
  expect(enrolled).toEqual([persistedAda.id]);
});

test("login callback fails closed when the database is unavailable", async () => {
  const previous = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  const started = startBrowserLogin({ config, sessionSecret });
  const state = new URL(started.authorizationUrl).searchParams.get("state");
  if (!state) throw new Error("state missing");
  try {
    const response = await handleLoginCallback({
      request: new Request(`http://localhost:3000/auth/callback?code=valid-code&state=${state}`, {
        headers: { cookie: started.stateCookie.split(";", 1)[0] ?? "" },
      }),
      config,
      sessionSecret,
      authing: fakeAuthing(),
    });
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "", "http://localhost:3000");
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("error")).toBe("login_failed");
    expect(location.href).not.toContain("database");
    expect(
      response.headers
        .getSetCookie()
        .some((cookie) => cookie.startsWith("coforge_session=") && !cookie.includes("Max-Age=0")),
    ).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  }
});

test("login callback returns to login when Authing state is invalid", async () => {
  const response = await handleLoginCallback({
    request: new Request("http://localhost:3000/auth/callback?code=valid-code&state=forged"),
    config,
    sessionSecret,
  });
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toContain("/login?error=login_failed");
});

test("logout clears the session cookie and signs the user out at Authing", () => {
  const response = handleLogout({
    origin: "http://localhost:3000",
    config,
    sessionSecret,
    cookieHeader: "",
  });
  expect(response.status).toBe(302);
  const location = response.headers.get("location");
  expect(location).toBeTruthy();
  const authingLogout = new URL(location!);
  expect(authingLogout.origin + authingLogout.pathname).toBe(
    "https://coforge.authing.cn/oidc/session/end",
  );
  expect(authingLogout.searchParams.get("client_id")).toBe("6a8fde6fa804dd3bea560bac");
  expect(authingLogout.searchParams.get("post_logout_redirect_uri")).toBe(
    "http://localhost:3000/login",
  );
  expect(cookieHeader(response)).toContain("Max-Age=0");
});

test("logout includes the Authing id_token hint from the session cookie", async () => {
  const started = startBrowserLogin({ config, sessionSecret });
  const state = new URL(started.authorizationUrl).searchParams.get("state");
  if (!state) throw new Error("state missing");
  const completed = await completeBrowserLogin({
    config,
    sessionSecret,
    code: "valid-code",
    state,
    cookieHeader: started.stateCookie.split(";", 1)[0] ?? "",
    authing: {
      async exchangeAuthorizationCode() {
        return { accessToken: "authing-access", idToken: "authing-id-token" };
      },
      async fetchUserInfo() {
        return { sub: "authing-user-1", email: "ada@example.com", name: "Ada" };
      },
    },
  });
  const response = handleLogout({
    origin: "http://localhost:3000",
    config,
    sessionSecret,
    cookieHeader: completed.sessionCookie.split(";", 1)[0] ?? "",
  });
  const authingLogout = new URL(response.headers.get("location") ?? "");
  expect(authingLogout.searchParams.get("id_token_hint")).toBe("authing-id-token");
});

function cookieHeader(response: Response): string {
  return response.headers.getSetCookie().join("\n");
}
