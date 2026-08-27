import { expect, test } from "bun:test";

import { completeBrowserLogin, startBrowserLogin } from "../../src/identity/browser-login";
import {
  handleCurrentUser,
  handleLoginCallback,
  handleLoginStart,
  handleLogout,
} from "../../src/identity/http";

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

test("login start redirects to Authing and stores a host-only state cookie", () => {
  const response = handleLoginStart({ config, sessionSecret });
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toContain("https://coforge-dev.authing.cn/oidc/auth");
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
        return { accessToken: "authing-access" };
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
  expect(await response.json()).toEqual({ user: completed.user });
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
    authing: {
      async exchangeAuthorizationCode() {
        return { accessToken: "authing-access" };
      },
      async fetchUserInfo() {
        return { sub: "authing-user-1", email: "ada@example.com", name: "Ada" };
      },
    },
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

test("login callback returns to login when Authing state is invalid", async () => {
  const response = await handleLoginCallback({
    request: new Request("http://localhost:3000/auth/callback?code=valid-code&state=forged"),
    config,
    sessionSecret,
  });
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toContain("/login?error=");
});

test("logout clears the session cookie", () => {
  const response = handleLogout({ origin: "http://localhost:3000" });
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe("/login");
  expect(cookieHeader(response)).toContain("Max-Age=0");
});

function cookieHeader(response: Response): string {
  return response.headers.getSetCookie().join("\n");
}
