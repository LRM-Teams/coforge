import { expect, test } from "bun:test";

import { currentUserHandler, loginStartHandler } from "../../src/server/auth/route-handlers.server";

test("login start returns 503 when Authing config is missing", () => {
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
  } finally {
    restoreEnv(previous);
  }
});

test("current user returns 503 when the session secret is missing", () => {
  const previous = process.env.COFORGE_SESSION_SECRET;
  delete process.env.COFORGE_SESSION_SECRET;
  try {
    const response = currentUserHandler({
      request: new Request("http://localhost:3000/api/me"),
    });
    expect(response.status).toBe(503);
  } finally {
    if (previous === undefined) delete process.env.COFORGE_SESSION_SECRET;
    else process.env.COFORGE_SESSION_SECRET = previous;
  }
});

function restoreEnv(values: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
