import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";

import { startBrowserLogin, type AuthingConfig } from "#src/server/auth/browser-login.server";
import { handleLoginCallback } from "#src/server/auth/http.server";

// A failed sign-in redirects to /login and says nothing else to the browser. The operator's only
// account of why is the callback's log line, so it must name the step and the non-secret reason,
// and never carry anything a sign-in is made of.

const sessionSecret = "test-session-secret-at-least-32-characters";
const appSecret = "test-app-secret";
const authorizationCode = "authorization-code-secret-7f3a";
const accessToken = "access-token-secret-9c1d";
const idToken = "id-token-secret-4b2e";
const email = "ada@example.com";
const baseConfig: AuthingConfig = {
  appId: "6a8fde6fa804dd3bea560bac",
  appSecret,
  issuer: "https://coforge.authing.cn/oidc",
  authorizationEndpoint: "https://coforge.authing.cn/oidc/auth",
  tokenEndpoint: "https://coforge.authing.cn/oidc/token",
  userinfoEndpoint: "https://coforge.authing.cn/oidc/me",
  endSessionEndpoint: "https://coforge.authing.cn/oidc/session/end",
  redirectUri: "http://localhost:3000/auth/callback",
};

type FakeAuthing = { token?: () => Response; userinfo?: () => Response };

const servers: Array<ReturnType<typeof Bun.serve>> = [];

// A shell that enables detailed server-error logging would print exception messages these tests
// assert never reach the log, so the variable is cleared for each test and restored after it.
let logServerErrors: string | undefined;
beforeEach(() => {
  logServerErrors = process.env.COFORGE_LOG_SERVER_ERRORS;
  delete process.env.COFORGE_LOG_SERVER_ERRORS;
});

afterEach(async () => {
  if (logServerErrors === undefined) delete process.env.COFORGE_LOG_SERVER_ERRORS;
  else process.env.COFORGE_LOG_SERVER_ERRORS = logServerErrors;
  await Promise.all(servers.splice(0).map((server) => server.stop(true)));
});

/** A real HTTP Authing, so the callback runs the exchanger it ships with. */
function authingAt(routes: FakeAuthing): AuthingConfig {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url);
      const respond = pathname === "/token" ? routes.token : routes.userinfo;
      return respond ? respond() : new Response("not found", { status: 404 });
    },
  });
  servers.push(server);
  return {
    ...baseConfig,
    tokenEndpoint: `${server.url}token`,
    userinfoEndpoint: `${server.url}me`,
  };
}

const tokenGranted = () =>
  Response.json({ access_token: accessToken, id_token: idToken, token_type: "Bearer" });
const userinfoOk = () =>
  Response.json({ sub: "authing-user-1", email, name: "Ada", preferred_username: "ada" });

type Callback = {
  config?: AuthingConfig;
  /** `forged` sends a state no sign-in started. */
  state?: "started" | "forged";
  resolveUser?: () => Promise<{ id: string; username: string }>;
  enrollUser?: () => Promise<void>;
  /** Leaves user resolution and enrollment to the database the callback ships with. */
  persisted?: boolean;
};

async function failedCallback(options: Callback = {}) {
  const config = options.config ?? baseConfig;
  const started = startBrowserLogin({ config, sessionSecret });
  const startedState = new URL(started.authorizationUrl).searchParams.get("state") ?? "";
  const stateCookie = started.stateCookie.split(";", 1)[0] ?? "";
  const stateCookieValue = stateCookie.split("=")[1] ?? "";
  const codeVerifier = (
    JSON.parse(Buffer.from(stateCookieValue.split(".")[0] ?? "", "base64url").toString("utf8")) as {
      codeVerifier: string;
    }
  ).codeVerifier;
  const state = options.state === "forged" ? "forged" : startedState;

  const lines: string[] = [];
  const spy = spyOn(console, "error").mockImplementation((line: unknown) => {
    lines.push(String(line));
  });
  let response: Response;
  try {
    response = await handleLoginCallback({
      request: new Request(
        `http://localhost:3000/auth/callback?code=${authorizationCode}&state=${state}`,
        { headers: { cookie: stateCookie } },
      ),
      config,
      sessionSecret,
      ...(options.persisted
        ? {}
        : {
            resolveUser: options.resolveUser ?? (async () => ({ id: "user-1", username: "ada" })),
            enrollUser: options.enrollUser ?? (async () => {}),
          }),
    });
  } finally {
    spy.mockRestore();
  }
  // Everything a sign-in is made of, none of which may reach a log.
  const secrets = [
    authorizationCode,
    codeVerifier,
    appSecret,
    accessToken,
    idToken,
    email,
    stateCookie,
    stateCookieValue,
    startedState,
    sessionSecret,
  ];
  return { response, lines, secrets };
}

function records(lines: string[]): Array<Record<string, unknown>> {
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function callbackFailure(lines: string[]): Record<string, unknown> {
  const found = records(lines).filter((record) => record.event === "auth.login_callback_failed");
  expect(found).toHaveLength(1);
  return found[0] ?? {};
}

function expectLoginFailedRedirect(response: Response) {
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toContain("/login?error=login_failed");
}

function expectNoSecrets(lines: string[], secrets: string[]) {
  const logged = lines.join("\n");
  for (const secret of secrets) expect(logged).not.toContain(secret);
}

test("a callback whose state no sign-in started says the login state was invalid", async () => {
  const { response, lines, secrets } = await failedCallback({ state: "forged" });
  expectLoginFailedRedirect(response);
  expect(lines).toHaveLength(1);
  expect(callbackFailure(lines)).toEqual({
    event: "auth.login_callback_failed",
    stage: "state",
    reason: "invalid login state",
  });
  expectNoSecrets(lines, secrets);
});

test("a rejected authorization code says the token exchange failed, with Authing's status and error", async () => {
  const config = authingAt({
    token: () =>
      Response.json(
        {
          error: "invalid_grant",
          error_description: `authorization code ${authorizationCode} is expired`,
        },
        { status: 400 },
      ),
  });
  const { response, lines, secrets } = await failedCallback({ config });
  expectLoginFailedRedirect(response);
  expect(lines).toHaveLength(1);
  expect(callbackFailure(lines)).toEqual({
    event: "auth.login_callback_failed",
    stage: "token_exchange",
    reason: "failed to exchange authorization code",
    status: 400,
    providerError: "invalid_grant",
  });
  expectNoSecrets(lines, secrets);
});

test("a token endpoint that is not answering with JSON still says its status", async () => {
  const config = authingAt({
    token: () => new Response("<html>bad gateway</html>", { status: 502 }),
  });
  const { response, lines, secrets } = await failedCallback({ config });
  expectLoginFailedRedirect(response);
  expect(callbackFailure(lines)).toEqual({
    event: "auth.login_callback_failed",
    stage: "token_exchange",
    reason: "failed to exchange authorization code",
    status: 502,
  });
  expectNoSecrets(lines, secrets);
});

test("an error code that could carry something else is not logged as Authing's error", async () => {
  const config = authingAt({
    token: () =>
      Response.json({ error: `invalid code ${authorizationCode} ${accessToken}` }, { status: 400 }),
  });
  const { lines, secrets } = await failedCallback({ config });
  expect(callbackFailure(lines)).toEqual({
    event: "auth.login_callback_failed",
    stage: "token_exchange",
    reason: "failed to exchange authorization code",
    status: 400,
  });
  expectNoSecrets(lines, secrets);
});

test("an Authing that cannot be reached says the token exchange failed, without the request", async () => {
  const gone = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const config = { ...baseConfig, tokenEndpoint: `${gone.url}token` };
  await gone.stop(true);
  const { response, lines, secrets } = await failedCallback({ config });
  expectLoginFailedRedirect(response);
  const failure = callbackFailure(lines);
  expect(failure).toMatchObject({
    event: "auth.login_callback_failed",
    stage: "token_exchange",
    reason: "failed to exchange authorization code",
    errorType: expect.any(String),
    errorId: expect.any(String),
  });
  expect(failure).not.toHaveProperty("status");
  expectNoSecrets(lines, secrets);
});

test("a userinfo request Authing refuses says userinfo failed, with the status", async () => {
  const config = authingAt({
    token: tokenGranted,
    userinfo: () => Response.json({ error: "invalid_token" }, { status: 401 }),
  });
  const { response, lines, secrets } = await failedCallback({ config });
  expectLoginFailedRedirect(response);
  expect(lines).toHaveLength(1);
  expect(callbackFailure(lines)).toEqual({
    event: "auth.login_callback_failed",
    stage: "userinfo",
    reason: "failed to fetch Authing user info",
    status: 401,
  });
  expectNoSecrets(lines, secrets);
});

test("an Authing account without an email says the email is required", async () => {
  const config = authingAt({
    token: tokenGranted,
    userinfo: () => Response.json({ sub: "authing-user-1", name: "No Email" }),
  });
  const { response, lines, secrets } = await failedCallback({ config });
  expectLoginFailedRedirect(response);
  expect(lines).toHaveLength(1);
  expect(callbackFailure(lines)).toEqual({
    event: "auth.login_callback_failed",
    stage: "email",
    reason: "email is required",
  });
  expectNoSecrets(lines, secrets);
});

test("a user that cannot be resolved says so, without the error's message or the email in it", async () => {
  const config = authingAt({ token: tokenGranted, userinfo: userinfoOk });
  const { response, lines, secrets } = await failedCallback({
    config,
    resolveUser: async () => {
      throw new Error(`duplicate key value violates unique constraint for ${email}`);
    },
  });
  expectLoginFailedRedirect(response);
  const failure = callbackFailure(lines);
  expect(failure).toEqual({
    event: "auth.login_callback_failed",
    stage: "user_resolution",
    reason: "failed to resolve user",
    errorType: "error",
    errorId: expect.any(String),
  });
  // The exception itself stays where it always was: the generic line with the same errorId.
  expect(records(lines).find((record) => record.event === "server_operation_failed")).toMatchObject(
    { errorId: failure.errorId },
  );
  expectNoSecrets(lines, secrets);
  expect(lines.join("\n")).not.toContain("duplicate key");
});

test("a Workspace enrollment that fails says the enrollment failed", async () => {
  const config = authingAt({ token: tokenGranted, userinfo: userinfoOk });
  const { response, lines, secrets } = await failedCallback({
    config,
    enrollUser: async () => {
      throw new Error(`no seat for ${email}`);
    },
  });
  expectLoginFailedRedirect(response);
  expect(callbackFailure(lines)).toMatchObject({
    event: "auth.login_callback_failed",
    stage: "enrollment",
    reason: "failed to enroll user in a Workspace",
    errorType: "error",
  });
  expectNoSecrets(lines, secrets);
});

test("a database that is missing says so as the step that needed it", async () => {
  const previous = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    const config = authingAt({ token: tokenGranted, userinfo: userinfoOk });
    const { response, lines, secrets } = await failedCallback({ config, persisted: true });
    expectLoginFailedRedirect(response);
    expect(callbackFailure(lines)).toEqual({
      event: "auth.login_callback_failed",
      stage: "user_resolution",
      reason: "database is unavailable",
    });
    expectNoSecrets(lines, secrets);
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  }
});
