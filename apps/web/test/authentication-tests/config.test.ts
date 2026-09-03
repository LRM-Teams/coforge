import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";

import {
  AuthConfigError,
  readAuthingConfig,
  readSessionSecret,
} from "../../src/server/auth/config.server";

test("readAuthingConfig uses issuer endpoints and the request origin callback", () => {
  const config = readAuthingConfig(
    {
      AUTHING_APP_ID: "6a8fde6fa804dd3bea560bac",
      AUTHING_APP_SECRET: "test-app-secret",
      AUTHING_ISSUER: "https://coforge.authing.cn/oidc/",
    },
    "http://localhost:3000",
  );

  expect(config.appId).toBe("6a8fde6fa804dd3bea560bac");
  expect(config.authorizationEndpoint).toBe("https://coforge.authing.cn/oidc/auth");
  expect(config.tokenEndpoint).toBe("https://coforge.authing.cn/oidc/token");
  expect(config.userinfoEndpoint).toBe("https://coforge.authing.cn/oidc/me");
  expect(config.redirectUri).toBe("http://localhost:3000/auth/callback");
});

test("readAuthingConfig honors an explicit redirect URI", () => {
  const config = readAuthingConfig(
    {
      AUTHING_APP_ID: "6a8fde6fa804dd3bea560bac",
      AUTHING_APP_SECRET: "test-app-secret",
      AUTHING_ISSUER: "https://coforge.authing.cn/oidc",
      AUTHING_REDIRECT_URI: "https://app.coforge.cn/auth/callback",
    },
    "http://localhost:3000",
  );
  expect(config.redirectUri).toBe("https://app.coforge.cn/auth/callback");
});

test("readAuthingConfig rejects a non-HTTPS issuer", () => {
  expect(() =>
    readAuthingConfig(
      {
        AUTHING_APP_ID: "6a8fde6fa804dd3bea560bac",
        AUTHING_APP_SECRET: "test-app-secret",
        AUTHING_ISSUER: "http://attacker.example/oidc",
      },
      "http://localhost:3000",
    ),
  ).toThrow("AUTHING_ISSUER must use HTTPS");
});

test("reads Authing and session secrets from mounted files", async () => {
  const root = await mkdtemp(join(tmpdir(), "coforge-auth-config-"));
  try {
    const appIdFile = join(root, "authing_app_id");
    const appSecretFile = join(root, "authing_app_secret");
    const sessionSecretFile = join(root, "coforge_session_secret");
    await Bun.write(appIdFile, "6a8fde6fa804dd3bea560bac\n");
    await Bun.write(appSecretFile, "mounted-$app-${secret}\n");
    await Bun.write(sessionSecretFile, "mounted-$session-${secret}-at-least-32-characters\n");

    const config = readAuthingConfig(
      {
        AUTHING_APP_ID_FILE: appIdFile,
        AUTHING_APP_SECRET_FILE: appSecretFile,
        AUTHING_ISSUER: "https://coforge.authing.cn/oidc",
      },
      "http://localhost:3000",
    );
    expect(config.appId).toBe("6a8fde6fa804dd3bea560bac");
    expect(config.appSecret).toBe("mounted-$app-${secret}");
    expect(readSessionSecret({ COFORGE_SESSION_SECRET_FILE: sessionSecretFile })).toBe(
      "mounted-$session-${secret}-at-least-32-characters",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects ambiguous inline and file secret configuration", () => {
  expect(() =>
    readSessionSecret({
      COFORGE_SESSION_SECRET: "inline-session-secret-at-least-32-characters",
      COFORGE_SESSION_SECRET_FILE: "/run/secrets/coforge_session_secret",
    }),
  ).toThrow("COFORGE_SESSION_SECRET and COFORGE_SESSION_SECRET_FILE cannot both be set");
});

test("readSessionSecret rejects missing or short secrets", () => {
  expect(() => readSessionSecret({})).toThrow(AuthConfigError);
  expect(() => readSessionSecret({ COFORGE_SESSION_SECRET: "too-short" })).toThrow(
    "COFORGE_SESSION_SECRET must be at least 32 characters",
  );
  expect(
    readSessionSecret({
      COFORGE_SESSION_SECRET: "test-session-secret-at-least-32-characters",
    }),
  ).toBe("test-session-secret-at-least-32-characters");
});
