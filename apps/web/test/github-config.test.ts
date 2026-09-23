import { expect, test } from "bun:test";
import {
  readGitHubAppBotIdentity,
  readGitHubConfig,
} from "@/server/integrations/github-config.server";

test("GitHub stays unconfigured without secrets and rejects non-HTTPS or mismatched callback paths", async () => {
  expect(await readGitHubConfig({})).toBeNull();
  const env = {
    COFORGE_GITHUB_APP_ID: "4937758",
    COFORGE_GITHUB_CLIENT_ID: "client",
    COFORGE_GITHUB_APP_SLUG: "coforge-staging",
    COFORGE_GITHUB_CALLBACK_URL: "https://staging.coforge.cn/api/integrations/github/callback",
    COFORGE_GITHUB_CLIENT_SECRET: "secret",
    COFORGE_GITHUB_CREDENTIAL_ENCRYPTION_KEY: "ab".repeat(32),
  };
  expect((await readGitHubConfig(env))?.encryptionKey).toEqual(new Uint8Array(32).fill(171));
  expect((await readGitHubConfig(env))?.webhookSecret).toBeNull();
  expect(
    (await readGitHubConfig({ ...env, COFORGE_GITHUB_WEBHOOK_SECRET: "whsec-value" }))
      ?.webhookSecret,
  ).toBe("whsec-value");
  await expect(
    readGitHubConfig({
      ...env,
      COFORGE_GITHUB_CALLBACK_URL: "http://staging.coforge.cn/api/integrations/github/callback",
    }),
  ).rejects.toThrow();
  await expect(
    readGitHubConfig({ ...env, COFORGE_GITHUB_CALLBACK_URL: "https://staging.coforge.cn/other" }),
  ).rejects.toThrow();
  await expect(
    readGitHubConfig({ ...env, COFORGE_GITHUB_CLIENT_SECRET_FILE: "/tmp/secret" }),
  ).rejects.toThrow();
});

test("GitHub App bot identity needs both a valid slug and a positive bot user id", () => {
  expect(readGitHubAppBotIdentity({})).toBeNull();
  expect(readGitHubAppBotIdentity({ COFORGE_GITHUB_APP_SLUG: "coforge-staging" })).toBeNull();
  expect(readGitHubAppBotIdentity({ COFORGE_GITHUB_APP_BOT_USER_ID: "328977087" })).toBeNull();
  expect(
    readGitHubAppBotIdentity({
      COFORGE_GITHUB_APP_SLUG: "Not_Valid",
      COFORGE_GITHUB_APP_BOT_USER_ID: "328977087",
    }),
  ).toBeNull();
  expect(
    readGitHubAppBotIdentity({
      COFORGE_GITHUB_APP_SLUG: "coforge-staging",
      COFORGE_GITHUB_APP_BOT_USER_ID: "not-a-number",
    }),
  ).toBeNull();
  expect(
    readGitHubAppBotIdentity({
      COFORGE_GITHUB_APP_SLUG: "coforge-staging",
      COFORGE_GITHUB_APP_BOT_USER_ID: "328977087",
    }),
  ).toEqual({ slug: "coforge-staging", botUserId: 328977087 });
});
