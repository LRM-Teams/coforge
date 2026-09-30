import { expect, test } from "bun:test";

import {
  completeBrowserLogin,
  consumeLogoutReturnTo,
  endBrowserLogin,
  readBrowserSession,
  startBrowserLogin,
  type InternalUserResolver,
  type TokenExchanger,
} from "#src/server/auth/browser-login.server";

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

type AuthingProfile = {
  sub: string;
  email?: string;
  name?: string;
  nickname?: string;
  preferred_username?: string;
};

function fakeAuthing(user: AuthingProfile): TokenExchanger {
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

test("each sign-in keeps its own state cookie, named by its state", () => {
  const first = startBrowserLogin({ config, sessionSecret });
  const second = startBrowserLogin({ config, sessionSecret });
  const firstState = new URL(first.authorizationUrl).searchParams.get("state");
  const secondState = new URL(second.authorizationUrl).searchParams.get("state");

  expect(firstState).not.toBe(secondState);
  // base64url is a legal cookie-name alphabet, so the state can be the name's suffix as it is.
  expect(firstState).toMatch(/^[A-Za-z0-9_-]+$/);
  expect(first.stateCookie).toStartWith(`coforge_oauth_state_${firstState}=`);
  expect(second.stateCookie).toStartWith(`coforge_oauth_state_${secondState}=`);
  expect(first.stateCookie).toContain("Max-Age=600");
  // Site-wide: Authing returns to the unprefixed callback, which the locale middleware redirects
  // to `/<locale>/auth/callback` before it reads the cookie, so a callback-only path would miss.
  expect(first.stateCookie).toContain("Path=/;");
});

test("completeBrowserLogin rejects another sign-in's cookie stored under this state's name", async () => {
  const mine = startBrowserLogin({ config, sessionSecret });
  const other = startBrowserLogin({ config, sessionSecret });
  const myState = new URL(mine.authorizationUrl).searchParams.get("state") ?? "";
  const otherValue = cookieHeader(other.stateCookie).split("=")[1] ?? "";

  await expect(
    completeBrowserLogin({
      config,
      sessionSecret,
      code: "valid-code",
      state: myState,
      cookieHeader: `coforge_oauth_state_${myState}=${otherValue}`,
      authing: fakeAuthing({ sub: "authing-user-1", email: "ada@example.com" }),
    }),
  ).rejects.toThrow("invalid login state");
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
  expect(completed.clearStateCookie).toStartWith(`coforge_oauth_state_${state}=`);
  expect(completed.clearStateCookie).toContain("Max-Age=0");
  expect(completed.clearStateCookie).toContain("Path=/;");
  expect(completed.sessionCookie).toContain("Path=/;");

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
      return { id: "00000000-0000-5000-8000-000000000002", username: "ada", fullName: null };
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
    readBrowserSession({
      sessionSecret,
      cookieHeader: cookieHeader(completed.sessionCookie),
    }),
  ).toMatchObject({ username: "ada" });
});

test("the profile's name and nickname reach user resolution, so a username can be derived from them", async () => {
  let resolved: unknown;
  await signIn({ sub: "s", name: " Ada Lovelace ", nickname: "Ace" }, async (input) => {
    resolved = input;
    return {
      id: "00000000-0000-5000-8000-000000000004",
      username: "ada-lovelace",
      fullName: null,
    };
  });

  expect(resolved).toEqual({
    provider: "authing",
    subject: "s",
    email: null,
    name: "Ada Lovelace",
    nickname: "Ace",
  });
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

test("completeBrowserLogin signs in an Authing account that has no email", async () => {
  const completed = await signIn({ sub: "authing-phone-user", name: "Ada" });

  expect(completed.user.email).toBeNull();
  expect(completed.user.name).toBe("Ada");
  expect(completed.user.authingSub).toBe("authing-phone-user");
  expect(completed.sessionCookie).toContain("coforge_session=");
  // The session keeps the missing email as an explicit null, not as a key that is gone.
  expect(
    readBrowserSession({ sessionSecret, cookieHeader: cookieHeader(completed.sessionCookie) }),
  ).toEqual({ ...completed.user, email: null });
});

test("an account with no email reaches user resolution with a null email, and no username hint it did not send", async () => {
  let resolved: unknown;
  await signIn({ sub: "authing-phone-user" }, async (input) => {
    resolved = input;
    return {
      id: "00000000-0000-5000-8000-000000000003",
      username: "user-0a1b2c3d",
      fullName: null,
    };
  });

  expect(resolved).toEqual({ provider: "authing", subject: "authing-phone-user", email: null });
});

// The session's `name` is what the provider reported (its name, else its nickname), kept only to
// start the first-sign-in name field with. It is never a stand-in for a person's name: nothing is
// derived from an email or the username.

test("the session name is the provider's name, trimmed, else its nickname, else nothing", async () => {
  const resolveUser = async () => ({
    id: "00000000-0000-5000-8000-000000000003",
    username: "user-0a1b2c3d",
    fullName: null,
  });
  const nameOf = async (profile: Omit<AuthingProfile, "sub">) =>
    (await signIn({ sub: "s", ...profile }, resolveUser)).user.name;

  expect(await nameOf({ name: " Ada ", nickname: "Ace" })).toBe("Ada");
  expect(await nameOf({ nickname: " Ace " })).toBe("Ace");
  expect(await nameOf({ name: "  ", nickname: "Ace" })).toBe("Ace");
  expect(await nameOf({ name: "  ", nickname: "" })).toBe("");
  // An email is not a name, and neither is the username the account was given.
  expect(await nameOf({ email: "Grace@Example.com" })).toBe("");
  expect(await nameOf({ preferred_username: "grace" })).toBe("");
});

test("sign-in reports the full name the person already has, or none", async () => {
  const resolved = (fullName: string | null) => async () => ({
    id: "00000000-0000-5000-8000-000000000003",
    username: "ada",
    fullName,
  });

  expect((await signIn({ sub: "s", name: "Ada" }, resolved(null))).fullName).toBeNull();
  // The provider's name is not the stored one: the stored one is what decides.
  expect((await signIn({ sub: "s" }, resolved("Ada Lovelace"))).fullName).toBe("Ada Lovelace");
});

test("an email is trimmed and lower-cased, and a blank one counts as none", async () => {
  const padded = await signIn({ sub: "s", email: "  Ada@Example.COM ", name: "Ada" });
  expect(padded.user.email).toBe("ada@example.com");

  const blank = await signIn({ sub: "s", email: "   ", name: "Ada" });
  expect(blank.user.email).toBeNull();
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
    authing: fakeAuthing({
      sub: "authing-user-1",
      email: "ada@example.com",
      name: "Ada",
    }),
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

function logoutReturn(returnTo: string, now?: () => number) {
  return endBrowserLogin({
    config,
    postLogoutRedirectUri: "http://localhost:3000/",
    sessionSecret,
    cookieHeader: "",
    returnTo,
    ...(now ? { now } : {}),
  }).returnCookie;
}

test("coming back from Authing after switching account gives the page to sign in to, once", () => {
  const returnCookie = logoutReturn("/join/abc");

  const landed = consumeLogoutReturnTo({
    sessionSecret,
    cookieHeader: cookieHeader(returnCookie),
    config,
  });
  expect(landed?.returnTo).toBe("/join/abc");
  expect(landed?.clearCookie).toStartWith("coforge_logout_return=;");
  expect(landed?.clearCookie).toContain("Max-Age=0");

  // The browser applied the clearing cookie, so the next landing on / has nothing to consume.
  expect(consumeLogoutReturnTo({ sessionSecret, cookieHeader: "", config })).toBeUndefined();
});

test("the clearing cookie of the landing step is Secure on an https site", () => {
  const returnCookie = logoutReturn("/join/abc");
  const landed = consumeLogoutReturnTo({
    sessionSecret,
    cookieHeader: cookieHeader(returnCookie),
    config: { ...config, redirectUri: "https://staging.coforge.cn/auth/callback" },
  });
  expect(landed?.clearCookie).toContain("Secure");
});

test("a forged or expired switch-account cookie gives no page, and is cleared", () => {
  const start = 1_700_000_000_000;
  const valid = cookieHeader(logoutReturn("/join/abc", () => start));
  const [name, value] = valid.split("=");
  const [body, signature] = (value ?? "").split(".");
  const forgedBody = Buffer.from(
    JSON.stringify({ returnTo: "/w/evil", exp: Math.floor(start / 1000) + 600 }),
  ).toString("base64url");
  const otherSecret = "another-session-secret-of-32-characters";
  const signedElsewhere = cookieHeader(
    endBrowserLogin({
      config,
      postLogoutRedirectUri: "http://localhost:3000/",
      sessionSecret: otherSecret,
      cookieHeader: "",
      returnTo: "/join/abc",
      now: () => start,
    }).returnCookie,
  );

  const cases = [
    // Payload rewritten under the old signature.
    { cookieHeader: `${name}=${forgedBody}.${signature}`, now: start },
    // Signed with another secret.
    { cookieHeader: signedElsewhere, now: start },
    { cookieHeader: `${name}=${body}`, now: start },
    { cookieHeader: `${name}=not-a-cookie`, now: start },
    // Valid, but read after its ten minutes.
    { cookieHeader: valid, now: start + 601_000 },
  ];
  for (const { cookieHeader: header, now } of cases) {
    const landed = consumeLogoutReturnTo({
      sessionSecret,
      cookieHeader: header,
      config,
      now: () => now,
    });
    expect(landed?.returnTo).toBeUndefined();
    expect(landed?.clearCookie).toContain("Max-Age=0");
  }
  // Still valid just inside the window.
  expect(
    consumeLogoutReturnTo({
      sessionSecret,
      cookieHeader: valid,
      config,
      now: () => start + 599_000,
    })?.returnTo,
  ).toBe("/join/abc");
});

test("switching account only remembers a page of this site", () => {
  for (const returnTo of ["//evil.com", "https://evil.com", "/\\evil"]) {
    expect(logoutReturn(returnTo)).toMatch(/^coforge_logout_return=;.*Max-Age=0/);
  }
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

async function signIn(profile: AuthingProfile, resolveUser?: InternalUserResolver) {
  const started = startBrowserLogin({ config, sessionSecret });
  const state = new URL(started.authorizationUrl).searchParams.get("state");
  if (!state) throw new Error("state missing");
  return completeBrowserLogin({
    config,
    sessionSecret,
    code: "valid-code",
    state,
    cookieHeader: cookieHeader(started.stateCookie),
    authing: fakeAuthing(profile),
    ...(resolveUser ? { resolveUser } : {}),
  });
}

function cookieHeader(setCookie: string): string {
  return setCookie.split(";", 1)[0] ?? "";
}

/** The value a Set-Cookie header gives its cookie. */
function cookieValue(setCookie: string): string {
  return setCookie.slice(setCookie.indexOf("=") + 1, setCookie.indexOf(";"));
}

test("a sign-in state cookie replayed as the session cookie signs nobody in", () => {
  const started = startBrowserLogin({ config, sessionSecret });

  expect(
    readBrowserSession({
      sessionSecret,
      cookieHeader: `coforge_session=${cookieValue(started.stateCookie)}`,
    }),
  ).toBeNull();
});

test("a switch-account return cookie replayed as the session cookie signs nobody in", () => {
  const ended = endBrowserLogin({
    config,
    postLogoutRedirectUri: "http://localhost:3000/",
    sessionSecret,
    cookieHeader: "",
    returnTo: "/join/abc",
  });

  expect(
    readBrowserSession({
      sessionSecret,
      cookieHeader: `coforge_session=${cookieValue(ended.returnCookie)}`,
    }),
  ).toBeNull();
});

/** A session cookie for `fields` laid over a valid session, signed the way this module signs one. */
function sessionCookieWith(fields: Record<string, unknown>): string {
  const body = Buffer.from(
    JSON.stringify({
      id: "user-1",
      email: "ada@example.com",
      name: "Ada",
      authingSub: "authing-user-1",
      username: "ada",
      exp: Math.floor(Date.now() / 1000) + 3600,
      ...fields,
    }),
  ).toString("base64url");
  const signature = new Bun.CryptoHasher("sha256", sessionSecret)
    .update(`session.${body}`)
    .digest("base64url");
  return `coforge_session=${body}.${signature}`;
}

test("a session cookie signed in with an email, or with none, still reads as that session", () => {
  const read = (fields: Record<string, unknown>) =>
    readBrowserSession({ sessionSecret, cookieHeader: sessionCookieWith(fields) });

  // Cookies made before an email became optional carry a string, and stay valid.
  expect(read({})).toMatchObject({ id: "user-1", email: "ada@example.com" });
  expect(read({ email: null })).toMatchObject({ id: "user-1", email: null });
  // Anything else in the email's place is not a session this module wrote.
  expect(read({ email: 42 })).toBeNull();
  expect(read({ email: undefined })).toBeNull();
});

test("only a signature made for a session reads as a session", () => {
  const body = Buffer.from(
    JSON.stringify({
      id: "user-1",
      email: "ada@example.com",
      name: "Ada",
      authingSub: "authing-user-1",
      username: "ada",
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  ).toString("base64url");
  const signedOver = (input: string) =>
    new Bun.CryptoHasher("sha256", sessionSecret).update(input).digest("base64url");
  const read = (value: string) =>
    readBrowserSession({ sessionSecret, cookieHeader: `coforge_session=${value}` });

  expect(read(`${body}.${signedOver(`session.${body}`)}`)).toMatchObject({ id: "user-1" });
  // Signed over the body alone, or for another kind of cookie.
  expect(read(`${body}.${signedOver(body)}`)).toBeNull();
  expect(read(`${body}.${signedOver(`login-state.${body}`)}`)).toBeNull();
  expect(read(`${body}.${signedOver(`logout-return.${body}`)}`)).toBeNull();
  expect(read(`${body}.${signedOver(`session.${body}`)}.extra`)).toBeNull();
});
