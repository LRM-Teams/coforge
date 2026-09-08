import { expect, test } from "bun:test";

import {
  currentUserHandler,
  loginStartHandler,
  logoutHandler,
} from "../../src/server/auth/route-handlers.server";

test("login start returns a safe 503 when Authing config is missing", async () => {
  const previous = {
    AUTHING_APP_ID: process.env.AUTHING_APP_ID,
    AUTHING_APP_SECRET: process.env.AUTHING_APP_SECRET,
    AUTHING_ISSUER: process.env.AUTHING_ISSUER,
    COFORGE_SESSION_SECRET: process.env.COFORGE_SESSION_SECRET,
  };
  delete process.env.AUTHING_APP_ID;
  delete process.env.AUTHING_APP_SECRET;
  delete process.env.AUTHING_ISSUER;
  delete process.env.COFORGE_SESSION_SECRET;

  try {
    const response = loginStartHandler({
      request: new Request("http://localhost:3000/auth/login"),
    });
    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(503);
    expect(await (response as Response).json()).toEqual({
      code: "TEMPORARILY_UNAVAILABLE",
    });
    expect((response as Response).headers.get("cache-control")).toBe("no-store");
  } finally {
    restoreEnv(previous);
  }
});

test("current user returns a safe 503 when the session secret is missing", async () => {
  const previous = process.env.COFORGE_SESSION_SECRET;
  delete process.env.COFORGE_SESSION_SECRET;
  try {
    const response = currentUserHandler({
      request: new Request("http://localhost:3000/api/me"),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: "TEMPORARILY_UNAVAILABLE" });
    expect(response.headers.get("cache-control")).toBe("no-store");
  } finally {
    if (previous === undefined) delete process.env.COFORGE_SESSION_SECRET;
    else process.env.COFORGE_SESSION_SECRET = previous;
  }
});

test("logout returns through Authing to the public HTTPS homepage behind the proxy", async () => {
  const previous = {
    AUTHING_APP_ID: process.env.AUTHING_APP_ID,
    AUTHING_APP_SECRET: process.env.AUTHING_APP_SECRET,
    AUTHING_ISSUER: process.env.AUTHING_ISSUER,
    COFORGE_SESSION_SECRET: process.env.COFORGE_SESSION_SECRET,
  };
  process.env.AUTHING_APP_ID = "6a8fde6fa804dd3bea560bac";
  process.env.AUTHING_APP_SECRET = "test-app-secret";
  process.env.AUTHING_ISSUER = "https://coforge.authing.cn/oidc";
  process.env.COFORGE_SESSION_SECRET = "test-session-secret-at-least-32-characters";

  try {
    const response = await logoutHandler({
      request: new Request("http://staging.coforge.cn/auth/logout", {
        headers: {
          "x-forwarded-proto": "https",
          "x-forwarded-host": "staging.coforge.cn",
        },
      }),
    });
    const authingLogout = new URL(response.headers.get("location") ?? "");
    expect(authingLogout.searchParams.get("post_logout_redirect_uri")).toBe(
      "https://staging.coforge.cn/",
    );
  } finally {
    restoreEnv(previous);
  }
});

function restoreEnv(values: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
