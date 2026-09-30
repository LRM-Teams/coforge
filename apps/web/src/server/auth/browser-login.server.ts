import { timingSafeEqual } from "node:crypto";

import { utf8Encoder, utf8Decoder } from "@lrm/coforge-sdk/internal";

import { safeReturnTo } from "#src/features/auth/return-to";
import { atLoginStage, LoginCallbackError } from "./login-failure.server";
export type BrowserUser = {
  id: string;
  /** What the provider reported, trimmed and lower-cased. An account made with a phone number
   * alone has none; the user is identified by `(provider, sub)`, never by this. */
  email: string | null;
  name: string;
  authingSub: string;
  username: string;
};
export type InternalUserResolver = (input: {
  provider: string;
  subject: string;
  email: string | null;
  preferredUsername?: string;
  /** What the provider reported as the person's name, for a username when nothing better names them. */
  name?: string;
  nickname?: string;
}) => Promise<{ id: string; username: string }>;

export type AuthingConfig = {
  appId: string;
  appSecret: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  userinfoEndpoint: string;
  endSessionEndpoint: string;
  redirectUri: string;
};

export type TokenExchanger = {
  exchangeAuthorizationCode(input: {
    code: string;
    redirectUri: string;
    codeVerifier: string;
  }): Promise<{ accessToken: string; idToken?: string }>;
  fetchUserInfo(accessToken: string): Promise<{
    sub: string;
    email?: string | null;
    name?: string | null;
    nickname?: string | null;
    preferred_username?: string | null;
  }>;
};

const SESSION_COOKIE = "coforge_session";
const STATE_COOKIE_PREFIX = "coforge_oauth_state_";
const LOGOUT_RETURN_COOKIE = "coforge_logout_return";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14;
const STATE_TTL_SECONDS = 60 * 10;
const LOGOUT_RETURN_TTL_SECONDS = 60 * 10;

type SignedState = {
  state: string;
  codeVerifier: string;
  exp: number;
  /** The page sign-in started from; signed, so the callback can trust where it sends people. */
  returnTo?: string;
};

type SignedSession = BrowserUser & { exp: number; idToken?: string };

type SignedLogoutReturn = { returnTo: string; exp: number };

/**
 * What a signed cookie is for. It is part of what the signature covers, so one cookie's value
 * never reads as another's: all three are signed with the same session secret, and without it a
 * sign-in state cookie replayed as `coforge_session` would pass as a session.
 */
type SignedPurpose = "session" | "login-state" | "logout-return";

/** What a `state` looks like when this module made it (base64url of random bytes): the only
 * strings that are safe in a cookie name, and the only ones a callback's query can name. */
const STATE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Each sign-in keeps its own state cookie, named by its `state`, so several tabs can sign in at
 * once: with one shared name the last sign-in started would overwrite the rest. `null` when
 * `state` is not one this module could have issued; the callback's `state` comes from the query
 * and must not reach a cookie name unchecked.
 */
function stateCookieName(state: string): string | null {
  return STATE_PATTERN.test(state) ? `${STATE_COOKIE_PREFIX}${state}` : null;
}

/** The signed state of the sign-in `state` names, or null when its cookie is missing, forged, or
 * signed for another state. Expiry is the caller's to judge. */
function readPendingState(input: {
  sessionSecret: string;
  cookieHeader: string;
  state: string;
}): SignedState | null {
  const name = stateCookieName(input.state);
  if (!name) return null;
  const signed = readSigned<SignedState>(
    "login-state",
    readCookie(input.cookieHeader, name),
    input.sessionSecret,
  );
  return signed?.state === input.state ? signed : null;
}

export function startBrowserLogin(input: {
  config: AuthingConfig;
  sessionSecret: string;
  /** Kept only when it is a page of this site (`safeReturnTo`). */
  returnTo?: string | null;
  now?: () => number;
  randomBytes?: (size: number) => Uint8Array;
}): { authorizationUrl: string; stateCookie: string } {
  const now = input.now ?? Date.now;
  const randomBytes = input.randomBytes ?? defaultRandomBytes;
  const state = toBase64Url(randomBytes(16));
  const codeVerifier = toBase64Url(randomBytes(32));
  const returnTo = safeReturnTo(input.returnTo);
  const payload: SignedState = {
    state,
    codeVerifier,
    exp: Math.floor(now() / 1000) + STATE_TTL_SECONDS,
    ...(returnTo ? { returnTo } : {}),
  };
  const url = new URL(input.config.authorizationEndpoint);
  url.searchParams.set("client_id", input.config.appId);
  url.searchParams.set("redirect_uri", input.config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid profile email");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", sha256Base64Url(codeVerifier));
  url.searchParams.set("code_challenge_method", "S256");
  return {
    authorizationUrl: url.toString(),
    stateCookie: serializeCookie(
      `${STATE_COOKIE_PREFIX}${state}`,
      sign("login-state", payload, input.sessionSecret),
      STATE_TTL_SECONDS,
      input.config.redirectUri,
    ),
  };
}

export async function completeBrowserLogin(input: {
  config: AuthingConfig;
  sessionSecret: string;
  code: string;
  state: string;
  cookieHeader: string;
  authing: TokenExchanger;
  resolveUser?: InternalUserResolver;
  now?: () => number;
}): Promise<{
  user: BrowserUser;
  sessionCookie: string;
  clearStateCookie: string;
  /** Where sign-in started, when that was a page of this site. */
  returnTo?: string;
}> {
  const now = input.now ?? Date.now;
  const signedState = readPendingState(input);
  if (!signedState || signedState.exp * 1000 <= now()) {
    throw new LoginCallbackError("state");
  }

  const returnTo = pendingReturnTo(signedState);
  const tokens = await atLoginStage("token_exchange", () =>
    input.authing.exchangeAuthorizationCode({
      code: input.code,
      redirectUri: input.config.redirectUri,
      codeVerifier: signedState.codeVerifier,
    }),
  );
  const profile = await atLoginStage("userinfo", () =>
    input.authing.fetchUserInfo(tokens.accessToken),
  );
  const email = profile.email?.trim().toLowerCase() || null;
  const { resolveUser } = input;
  const resolved = resolveUser
    ? await atLoginStage("user_resolution", () =>
        resolveUser({
          provider: "authing",
          subject: profile.sub,
          email,
          ...(profile.preferred_username ? { preferredUsername: profile.preferred_username } : {}),
          ...(profile.name?.trim() ? { name: profile.name.trim() } : {}),
          ...(profile.nickname?.trim() ? { nickname: profile.nickname.trim() } : {}),
        }),
      )
    : {
        id: testOnlyStableInternalUserId("authing", profile.sub),
        username: `user-${testOnlyStableInternalUserId("authing", profile.sub).replaceAll("-", "")}`,
      };
  const user: BrowserUser = {
    id: resolved.id,
    username: resolved.username,
    email,
    // Never the phone number: without a name or an email, the name is the username.
    name:
      profile.name?.trim() ||
      profile.nickname?.trim() ||
      (email ? email.split("@")[0] || email : resolved.username),
    authingSub: profile.sub,
  };
  const session: SignedSession = {
    ...user,
    exp: Math.floor(now() / 1000) + SESSION_TTL_SECONDS,
    ...(tokens.idToken ? { idToken: tokens.idToken } : {}),
  };
  return {
    user,
    sessionCookie: serializeCookie(
      SESSION_COOKIE,
      sign("session", session, input.sessionSecret),
      SESSION_TTL_SECONDS,
      input.config.redirectUri,
    ),
    clearStateCookie: clearCookie(
      `${STATE_COOKIE_PREFIX}${signedState.state}`,
      input.config.redirectUri,
    ),
    ...(returnTo ? { returnTo } : {}),
  };
}

/**
 * The page the sign-in `state` names started from, read from its signed state cookie; `undefined`
 * when that cookie is missing, forged, or names no page of this site. A failed callback uses it to
 * offer the same sign-in again.
 */
export function pendingLoginReturnTo(input: {
  sessionSecret: string;
  cookieHeader: string;
  state: string;
}): string | undefined {
  return pendingReturnTo(readPendingState(input));
}

function pendingReturnTo(state: SignedState | null): string | undefined {
  return safeReturnTo(state?.returnTo);
}

/**
 * Expires the state cookie of a sign-in that did not finish, when the browser sent one for
 * `state`; other sign-ins' cookies stay. `undefined` when there is nothing of this sign-in to clear.
 */
export function clearPendingLoginState(input: {
  config: AuthingConfig;
  cookieHeader: string;
  state: string;
}): string | undefined {
  const name = stateCookieName(input.state);
  if (!name || readCookie(input.cookieHeader, name) === null) return undefined;
  return clearCookie(name, input.config.redirectUri);
}

// The real callback supplies the persistence resolver. This deterministic fallback
// keeps the pure authentication seam usable without a database in unit tests.
function testOnlyStableInternalUserId(provider: string, subject: string): string {
  const bytes = Array.from(sha256Bytes(`coforge-internal-user:${provider}:${subject}`));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function readBrowserSession(input: {
  sessionSecret: string;
  cookieHeader: string;
  now?: () => number;
}): BrowserUser | null {
  const now = input.now ?? Date.now;
  const session = readSigned<SignedSession>(
    "session",
    readCookie(input.cookieHeader, SESSION_COOKIE),
    input.sessionSecret,
  );
  if (!isSignedSession(session) || session.exp * 1000 <= now()) return null;
  return {
    id: session.id,
    email: session.email,
    name: session.name,
    authingSub: session.authingSub,
    username: session.username,
  };
}

export function buildAuthingLogoutUrl(
  config: AuthingConfig,
  postLogoutRedirectUri: string,
  idTokenHint?: string,
): string {
  const url = new URL(config.endSessionEndpoint);
  url.searchParams.set("client_id", config.appId);
  url.searchParams.set("post_logout_redirect_uri", postLogoutRedirectUri);
  if (idTokenHint) url.searchParams.set("id_token_hint", idTokenHint);
  return url.toString();
}

export function endBrowserLogin(input: {
  config: AuthingConfig;
  postLogoutRedirectUri: string;
  sessionSecret: string;
  cookieHeader: string;
  /**
   * The page to sign in to again once Authing has ended its session (switching account). Kept
   * only when it is a page of this site (`safeReturnTo`).
   */
  returnTo?: string | null;
  now?: () => number;
}): {
  clearSessionCookie: string;
  authingLogoutUrl: string;
  /** Carries `returnTo` across Authing's redirect, which can only land on the registered
   * `postLogoutRedirectUri`; `consumeLogoutReturnTo` reads it there. Without a `returnTo` it
   * expires any earlier one, so a switch that never came back cannot redirect this sign-out. */
  returnCookie: string;
} {
  const now = input.now ?? Date.now;
  const session = readSigned<SignedSession>(
    "session",
    readCookie(input.cookieHeader, SESSION_COOKIE),
    input.sessionSecret,
  );
  const returnTo = safeReturnTo(input.returnTo);
  const remembered: SignedLogoutReturn | null = returnTo
    ? { returnTo, exp: Math.floor(now() / 1000) + LOGOUT_RETURN_TTL_SECONDS }
    : null;
  return {
    clearSessionCookie: clearCookie(SESSION_COOKIE, input.config.redirectUri),
    authingLogoutUrl: buildAuthingLogoutUrl(
      input.config,
      input.postLogoutRedirectUri,
      session?.idToken,
    ),
    returnCookie: remembered
      ? serializeCookie(
          LOGOUT_RETURN_COOKIE,
          sign("logout-return", remembered, input.sessionSecret),
          LOGOUT_RETURN_TTL_SECONDS,
          input.config.redirectUri,
        )
      : clearCookie(LOGOUT_RETURN_COOKIE, input.config.redirectUri),
  };
}

/**
 * The step where the browser lands back after signing out at Authing. Reads the cookie
 * `endBrowserLogin` left: `returnTo` is the page to sign in to again, present only while the
 * signed cookie is valid and unexpired. `clearCookie` expires it, so it is used once; a forged
 * or expired cookie is cleared too and gives no `returnTo`. `undefined` when no cookie came.
 */
export function consumeLogoutReturnTo(input: {
  sessionSecret: string;
  cookieHeader: string;
  config: AuthingConfig;
  now?: () => number;
}): { returnTo?: string; clearCookie: string } | undefined {
  const now = input.now ?? Date.now;
  const value = readCookie(input.cookieHeader, LOGOUT_RETURN_COOKIE);
  if (value === null) return undefined;
  const signed = readSigned<SignedLogoutReturn>("logout-return", value, input.sessionSecret);
  const returnTo = signed && signed.exp * 1000 > now() ? safeReturnTo(signed.returnTo) : undefined;
  return {
    ...(returnTo ? { returnTo } : {}),
    clearCookie: clearCookie(LOGOUT_RETURN_COOKIE, input.config.redirectUri),
  };
}

export function createAuthingExchanger(config: AuthingConfig): TokenExchanger {
  return {
    async exchangeAuthorizationCode(input) {
      const response = await fetch(config.tokenEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: input.code,
          client_id: config.appId,
          client_secret: config.appSecret,
          redirect_uri: input.redirectUri,
          code_verifier: input.codeVerifier,
        }),
      });
      // A gateway's HTML error page is not JSON; the status still says what happened.
      const body = (await response.json().catch(() => ({}))) as {
        access_token?: string;
        id_token?: string;
        error?: unknown;
      };
      if (!response.ok || !body.access_token) {
        throw new LoginCallbackError("token_exchange", {
          status: response.status,
          providerError: body.error,
        });
      }
      return {
        accessToken: body.access_token,
        ...(body.id_token ? { idToken: body.id_token } : {}),
      };
    },
    async fetchUserInfo(accessToken) {
      const response = await fetch(config.userinfoEndpoint, {
        headers: { authorization: `Bearer ${accessToken}` },
      });
      if (!response.ok) throw new LoginCallbackError("userinfo", { status: response.status });
      return (await response.json()) as {
        sub: string;
        email?: string | null;
        name?: string | null;
        nickname?: string | null;
        preferred_username?: string | null;
      };
    },
  };
}

function sign(purpose: SignedPurpose, payload: object, secret: string): string {
  const body = toBase64Url(utf8Encoder.encode(JSON.stringify(payload)));
  return `${body}.${hmacSha256(secret, `${purpose}.${body}`)}`;
}

function readSigned<T>(purpose: SignedPurpose, value: string | null, secret: string): T | null {
  if (!value) return null;
  const [body, signature, ...rest] = value.split(".");
  if (!body || !signature || rest.length > 0) return null;
  const expected = utf8Encoder.encode(hmacSha256(secret, `${purpose}.${body}`));
  const given = utf8Encoder.encode(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    return JSON.parse(utf8Decoder.decode(fromBase64Url(body))) as T;
  } catch {
    return null;
  }
}

/** Whether a signed session carries every field a `BrowserUser` needs; `id` goes straight into
 * queries, where `undefined` would match every row. */
function isSignedSession(value: SignedSession | null): value is SignedSession {
  return (
    value !== null &&
    typeof value.exp === "number" &&
    [value.id, value.name, value.authingSub, value.username].every(
      (field) => typeof field === "string",
    ) &&
    // A session made before an email became optional carries a string; a new one may carry null.
    (typeof value.email === "string" || value.email === null) &&
    value.id !== ""
  );
}

function readCookie(header: string, name: string): string | null {
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

function serializeCookie(
  name: string,
  value: string,
  maxAgeSeconds: number,
  siteUrl: string,
): string {
  const secure = siteUrl.startsWith("https:");
  return [
    `${name}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
    secure ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

function clearCookie(name: string, siteUrl: string): string {
  return serializeCookie(name, "", 0, siteUrl);
}

function defaultRandomBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return bytes;
}

function sha256Base64Url(value: string): string {
  return toBase64Url(sha256Bytes(value));
}

function sha256Bytes(value: string): Uint8Array {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(value);
  return new Uint8Array(hasher.digest());
}

function hmacSha256(secret: string, value: string): string {
  const hasher = new Bun.CryptoHasher("sha256", secret);
  hasher.update(value);
  return toBase64Url(new Uint8Array(hasher.digest()));
}

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function fromBase64Url(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64url"));
}
