import { expect, test } from "bun:test";
import { readGitHubConfig } from "../src/server/integrations/github-config.server";

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
    readGitHubConfig({ ...env, COFORGE_GITHUB_CLIENT_SECRET_FILE: "/unused" }),
  ).rejects.toThrow();
});
