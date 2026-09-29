import { expect, test } from "bun:test";

import { completeBrowserLogin, startBrowserLogin } from "#src/server/auth/browser-login.server";
import {
  handleCurrentUser,
  handleLoginCallback,
  handleLoginStart,
  handleLogout,
} from "#src/server/auth/http.server";

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
      (cookie) =>
        cookie.startsWith(`coforge_oauth_state_${state}=`) && cookie.includes("Max-Age=0"),
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

test("a failed sign-in behind the proxy returns to login on the site the browser reached", async () => {
  const response = await handleLoginCallback({
    // TLS ends at the proxy, so the request URL the server sees is http.
    request: new Request("http://staging.coforge.cn/auth/callback?code=valid-code&state=forged", {
      headers: { "x-forwarded-proto": "https", "x-forwarded-host": "staging.coforge.cn" },
    }),
    config,
    sessionSecret,
  });
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toStartWith(
    "https://staging.coforge.cn/login?error=login_failed",
  );
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

test("logout clears the session cookie, signs out at Authing, and returns to the homepage", () => {
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
  expect(authingLogout.searchParams.get("post_logout_redirect_uri")).toBe("http://localhost:3000/");
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

test("logout with a page to come back to remembers it in a short-lived signed cookie", () => {
  const response = handleLogout({
    origin: "http://localhost:3000",
    config,
    sessionSecret,
    cookieHeader: "",
    returnTo: "/join/abc",
  });
  // Authing only redirects to the URI registered for the app, so that stays the homepage.
  const authingLogout = new URL(response.headers.get("location") ?? "");
  expect(authingLogout.searchParams.get("post_logout_redirect_uri")).toBe("http://localhost:3000/");
  const cookies = response.headers.getSetCookie();
  expect(cookies.some((cookie) => cookie.startsWith("coforge_session=;"))).toBe(true);
  const remembered = cookies.filter((cookie) => cookie.startsWith("coforge_logout_return="));
  expect(remembered).toHaveLength(1);
  expect(remembered[0]).toContain("HttpOnly");
  expect(remembered[0]).toContain("SameSite=Lax");
  expect(remembered[0]).toContain("Max-Age=600");
  expect(remembered[0]).toContain("Path=/;");
  expect(remembered[0]).not.toContain("Domain=");
  // Signed, not readable as a page path.
  expect(remembered[0]).not.toContain("join");
});

test("logout without a page of this site to come back to forgets any page remembered before", () => {
  for (const returnTo of [undefined, null, "", "//evil.com", "https://evil.com", "/\\evil"]) {
    const response = handleLogout({
      origin: "http://localhost:3000",
      config,
      sessionSecret,
      cookieHeader: "",
      returnTo,
    });
    const cookies = response.headers.getSetCookie();
    // A page left by an earlier switch that never came back must not send this sign-out there.
    expect(cookies.filter((cookie) => cookie.startsWith("coforge_logout_return="))).toEqual([
      expect.stringMatching(/^coforge_logout_return=;.*Max-Age=0/),
    ]);
    expect(cookies.some((cookie) => cookie.startsWith("coforge_session=;"))).toBe(true);
  }
});

function cookieHeader(response: Response): string {
  return response.headers.getSetCookie().join("\n");
}

async function loginRoundTrip(
  returnTo: string | null,
  options: {
    tamper?: (payload: Record<string, unknown>) => void;
    enrollUser?: () => Promise<void>;
  } = {},
) {
  const started = handleLoginStart({ config, sessionSecret, returnTo });
  const location = new URL(started.headers.get("location") ?? "");
  const state = location.searchParams.get("state") ?? "";
  let stateCookie = started.headers.getSetCookie()[0]?.split(";", 1)[0] ?? "";
  if (options.tamper) {
    // Rewrite the payload but keep Authing's state and the old signature.
    const [name, value] = stateCookie.split("=");
    const [body, signature] = (value ?? "").split(".");
    const payload = JSON.parse(Buffer.from(body ?? "", "base64url").toString("utf8"));
    options.tamper(payload);
    stateCookie = `${name}=${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${signature}`;
  }
  return handleLoginCallback({
    request: new Request(`http://localhost:3000/auth/callback?code=valid-code&state=${state}`, {
      headers: { cookie: stateCookie },
    }),
    config,
    sessionSecret,
    authing: fakeAuthing(),
    resolveUser: async () => persistedAda,
    enrollUser: options.enrollUser ?? (async () => {}),
  });
}

test("the page a sign-in started from rides in the signed state and is where it ends", async () => {
  const device = await loginRoundTrip("/oauth/verify?user_code=AB-CD");
  expect(device.headers.get("location")).toBe("/oauth/verify?user_code=AB-CD");
  // Pages carry the locale prefix; /oauth has none.
  const page = await loginRoundTrip("/w/acme/channel/1?view=chat");
  expect(page.headers.get("location")).toBe("/en/w/acme/channel/1?view=chat");
});

test("a returnTo that could leave CoForge, or none, ends sign-in at /", async () => {
  for (const returnTo of ["//evil.com", "https://evil.com", "/\\evil", null]) {
    const response = await loginRoundTrip(returnTo);
    expect(response.headers.get("location")).toBe("/");
  }
});

test("a tampered state cookie is rejected, and its returnTo is not followed", async () => {
  const response = await loginRoundTrip("/w/acme", {
    tamper: (payload) => {
      payload.returnTo = "https://evil.com";
    },
  });
  const location = new URL(response.headers.get("location") ?? "");
  expect(location.pathname).toBe("/login");
  expect(location.searchParams.get("error")).toBe("login_failed");
  expect(location.searchParams.get("returnTo")).toBeNull();
  expect(
    response.headers.getSetCookie().some((cookie) => cookie.startsWith("coforge_session=")),
  ).toBe(false);
});

test("a failed sign-in goes back to /login with the page it started from", async () => {
  const response = await loginRoundTrip("/join/abc", {
    enrollUser: async () => {
      throw new Error("database is required");
    },
  });
  const location = new URL(response.headers.get("location") ?? "");
  expect(location.pathname).toBe("/login");
  expect(location.searchParams.get("error")).toBe("login_failed");
  expect(location.searchParams.get("returnTo")).toBe("/join/abc");
});

function startSignIn(returnTo: string) {
  const started = handleLoginStart({ config, sessionSecret, returnTo });
  const state = new URL(started.headers.get("location") ?? "").searchParams.get("state") ?? "";
  const cookie = started.headers.getSetCookie()[0]?.split(";", 1)[0] ?? "";
  return { state, cookie };
}

function callbackFor(
  state: string,
  cookies: string[],
  enrollUser: () => Promise<void> = async () => {},
) {
  return handleLoginCallback({
    request: new Request(`http://localhost:3000/auth/callback?code=valid-code&state=${state}`, {
      headers: { cookie: cookies.join("; ") },
    }),
    config,
    sessionSecret,
    authing: fakeAuthing(),
    resolveUser: async () => persistedAda,
    enrollUser,
  });
}

test("sign-ins started in several tabs each finish on the page their own tab started from", async () => {
  const first = startSignIn("/w/acme/channel/1");
  const second = startSignIn("/join/abc");
  const third = startSignIn("/oauth/verify?user_code=AB-CD");
  const browserCookies = [first.cookie, second.cookie, third.cookie];

  // The callbacks arrive in any order, each with every state cookie the browser still holds.
  const secondDone = await callbackFor(second.state, browserCookies);
  const firstDone = await callbackFor(first.state, browserCookies);
  const thirdDone = await callbackFor(third.state, browserCookies);

  expect(secondDone.headers.get("location")).toBe("/en/join/abc");
  expect(firstDone.headers.get("location")).toBe("/en/w/acme/channel/1");
  expect(thirdDone.headers.get("location")).toBe("/oauth/verify?user_code=AB-CD");
});

function clearedStateCookies(response: Response): string[] {
  return response.headers
    .getSetCookie()
    .filter((cookie) => cookie.startsWith("coforge_oauth_state_") && cookie.includes("Max-Age=0"))
    .map((cookie) => cookie.split("=", 1)[0] ?? "");
}

test("a sign-in that finishes clears only its own state cookie", async () => {
  const first = startSignIn("/w/acme");
  const second = startSignIn("/join/abc");
  const response = await callbackFor(second.state, [first.cookie, second.cookie]);
  expect(clearedStateCookies(response)).toEqual([`coforge_oauth_state_${second.state}`]);
});

test("a sign-in that fails clears only its own state cookie and offers its own page again", async () => {
  const first = startSignIn("/w/acme");
  const second = startSignIn("/join/abc");
  const response = await callbackFor(second.state, [first.cookie, second.cookie], async () => {
    throw new Error("database is required");
  });
  const location = new URL(response.headers.get("location") ?? "");
  expect(location.searchParams.get("error")).toBe("login_failed");
  expect(location.searchParams.get("returnTo")).toBe("/join/abc");
  expect(clearedStateCookies(response)).toEqual([`coforge_oauth_state_${second.state}`]);
});

test("a callback for a state no tab started fails, whatever other state cookies the browser holds", async () => {
  const started = startSignIn("/w/acme");
  const response = await callbackFor("AAAAAAAAAAAAAAAAAAAAAA", [started.cookie]);
  const location = new URL(response.headers.get("location") ?? "");
  expect(location.searchParams.get("error")).toBe("login_failed");
  expect(location.searchParams.get("returnTo")).toBeNull();
  expect(clearedStateCookies(response)).toEqual([]);
  expect(
    response.headers.getSetCookie().some((cookie) => cookie.startsWith("coforge_session=")),
  ).toBe(false);
});

test("a state from the callback's query never becomes part of a cookie name", async () => {
  const started = startSignIn("/w/acme");
  for (const state of [
    encodeURIComponent("x; Domain=evil.example"),
    encodeURIComponent("x=y"),
    "",
    "A".repeat(65),
  ]) {
    const response = await callbackFor(state, [started.cookie]);
    expect(new URL(response.headers.get("location") ?? "").searchParams.get("error")).toBe(
      "login_failed",
    );
    expect(response.headers.getSetCookie()).toEqual([]);
  }
});
