import { expect, test } from "bun:test";

import { AuthConfigError, readAuthingConfig, readSessionSecret } from "../../src/identity/config";

test("readAuthingConfig uses issuer endpoints and the request origin callback", () => {
  const config = readAuthingConfig(
    {
      AUTHING_APP_ID: "6a8fde6fa804dd3bea560bac",
      AUTHING_APP_SECRET: "test-app-secret",
      AUTHING_ISSUER: "https://coforge-dev.authing.cn/oidc/",
    },
    "http://localhost:3000",
  );

  expect(config.appId).toBe("6a8fde6fa804dd3bea560bac");
  expect(config.authorizationEndpoint).toBe("https://coforge-dev.authing.cn/oidc/auth");
  expect(config.tokenEndpoint).toBe("https://coforge-dev.authing.cn/oidc/token");
  expect(config.userinfoEndpoint).toBe("https://coforge-dev.authing.cn/oidc/me");
  expect(config.redirectUri).toBe("http://localhost:3000/auth/callback");
});

test("readAuthingConfig honors an explicit redirect URI", () => {
  const config = readAuthingConfig(
    {
      AUTHING_APP_ID: "6a8fde6fa804dd3bea560bac",
      AUTHING_APP_SECRET: "test-app-secret",
      AUTHING_ISSUER: "https://coforge-dev.authing.cn/oidc",
      AUTHING_REDIRECT_URI: "https://app.coforge.cn/auth/callback",
    },
    "http://localhost:3000",
  );
  expect(config.redirectUri).toBe("https://app.coforge.cn/auth/callback");
});

test("readSessionSecret rejects missing or short secrets", () => {
  expect(() => readSessionSecret({})).toThrow(AuthConfigError);
  expect(() => readSessionSecret({ COFORGE_SESSION_SECRET: "too-short" })).toThrow(
    "COFORGE_SESSION_SECRET must be at least 32 characters",
  );
  expect(
    readSessionSecret({ COFORGE_SESSION_SECRET: "test-session-secret-at-least-32-characters" }),
  ).toBe("test-session-secret-at-least-32-characters");
});
