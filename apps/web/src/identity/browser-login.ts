export type BrowserUser = {
  id: string;
  email: string;
  name: string;
  authingSub: string;
};

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
  }): Promise<{ accessToken: string }>;
  fetchUserInfo(accessToken: string): Promise<{
    sub: string;
    email?: string | null;
    name?: string | null;
    nickname?: string | null;
  }>;
};

const SESSION_COOKIE = "coforge_session";
const STATE_COOKIE = "coforge_oauth_state";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14;
const STATE_TTL_SECONDS = 60 * 10;

type SignedState = {
  state: string;
  codeVerifier: string;
  exp: number;
};

type SignedSession = BrowserUser & { exp: number };

export function startBrowserLogin(input: {
  config: AuthingConfig;
  sessionSecret: string;
  now?: () => number;
  randomBytes?: (size: number) => Uint8Array;
}): { authorizationUrl: string; stateCookie: string } {
  const now = input.now ?? Date.now;
  const randomBytes = input.randomBytes ?? defaultRandomBytes;
  const state = toBase64Url(randomBytes(16));
  const codeVerifier = toBase64Url(randomBytes(32));
  const payload: SignedState = {
    state,
    codeVerifier,
    exp: Math.floor(now() / 1000) + STATE_TTL_SECONDS,
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
      STATE_COOKIE,
      sign(payload, input.sessionSecret),
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
  now?: () => number;
}): Promise<{ user: BrowserUser; sessionCookie: string; clearStateCookie: string }> {
  const now = input.now ?? Date.now;
  const signedState = readSigned<SignedState>(
    readCookie(input.cookieHeader, STATE_COOKIE),
    input.sessionSecret,
  );
  if (!signedState || signedState.state !== input.state || signedState.exp * 1000 <= now()) {
    throw new Error("invalid login state");
  }

  const tokens = await input.authing.exchangeAuthorizationCode({
    code: input.code,
    redirectUri: input.config.redirectUri,
    codeVerifier: signedState.codeVerifier,
  });
  const profile = await input.authing.fetchUserInfo(tokens.accessToken);
  const email = profile.email?.trim().toLowerCase();
  if (!email) throw new Error("email is required");
  const user: BrowserUser = {
    id: userIdFromAuthingSub(profile.sub),
    email,
    name: profile.name?.trim() || profile.nickname?.trim() || email.split("@")[0] || email,
    authingSub: profile.sub,
  };
  const session: SignedSession = {
    ...user,
    exp: Math.floor(now() / 1000) + SESSION_TTL_SECONDS,
  };
  return {
    user,
    sessionCookie: serializeCookie(
      SESSION_COOKIE,
      sign(session, input.sessionSecret),
      SESSION_TTL_SECONDS,
      input.config.redirectUri,
    ),
    clearStateCookie: clearCookie(STATE_COOKIE, input.config.redirectUri),
  };
}

export function readBrowserSession(input: {
  sessionSecret: string;
  cookieHeader: string;
  now?: () => number;
}): BrowserUser | null {
  const now = input.now ?? Date.now;
  const session = readSigned<SignedSession>(
    readCookie(input.cookieHeader, SESSION_COOKIE),
    input.sessionSecret,
  );
  if (!session || session.exp * 1000 <= now()) return null;
  return {
    id: session.id,
    email: session.email,
    name: session.name,
    authingSub: session.authingSub,
  };
}

export function endBrowserLogin(redirectUri = "http://localhost:3000/"): {
  clearSessionCookie: string;
} {
  return { clearSessionCookie: clearCookie(SESSION_COOKIE, redirectUri) };
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
      const body = (await response.json()) as { access_token?: string; error?: string };
      if (!response.ok || !body.access_token) {
        throw new Error(body.error ?? "failed to exchange authorization code");
      }
      return { accessToken: body.access_token };
    },
    async fetchUserInfo(accessToken) {
      const response = await fetch(config.userinfoEndpoint, {
        headers: { authorization: `Bearer ${accessToken}` },
      });
      if (!response.ok) throw new Error("failed to fetch Authing user info");
      return (await response.json()) as {
        sub: string;
        email?: string | null;
        name?: string | null;
        nickname?: string | null;
      };
    },
  };
}

function userIdFromAuthingSub(sub: string): string {
  const hash = sha256Bytes(`coforge-user:${sub}`);
  const bytes = Array.from(hash);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function sign(payload: object, secret: string): string {
  const body = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  return `${body}.${hmacSha256(secret, body)}`;
}

function readSigned<T>(value: string | null, secret: string): T | null {
  if (!value) return null;
  const [body, signature] = value.split(".");
  if (!body || !signature || hmacSha256(secret, body) !== signature) return null;
  try {
    return JSON.parse(new TextDecoder().decode(fromBase64Url(body))) as T;
  } catch {
    return null;
  }
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
  redirectUri: string,
): string {
  const secure = redirectUri.startsWith("https:");
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

function clearCookie(name: string, redirectUri: string): string {
  return serializeCookie(name, "", 0, redirectUri);
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
