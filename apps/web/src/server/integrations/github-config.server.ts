import { AppError } from "@/lib/app-error";
import { requireDatabaseClient } from "@/server/db/client.server";
import { GitHubConnection, type GitHubConfig } from "./github-connection.server";

const GITHUB_APP_SLUG = /^[a-z0-9-]+$/;

export async function readGitHubConfig(
  env: Record<string, string | undefined> = Bun.env,
): Promise<GitHubConfig | null> {
  const clientId = env.COFORGE_GITHUB_CLIENT_ID?.trim();
  if (!clientId) return null;
  const clientSecret = await secret(env, "COFORGE_GITHUB_CLIENT_SECRET");
  const encryptionKey = await secret(env, "COFORGE_GITHUB_CREDENTIAL_ENCRYPTION_KEY");
  if (!clientSecret || !encryptionKey) return null;
  // Optional: existing deployments have no webhook configured yet. The webhook route
  // returns 503 until an operator sets this, independent of the OAuth connection flow.
  const webhookSecret = (await secret(env, "COFORGE_GITHUB_WEBHOOK_SECRET")) || null;
  const appId = Number(env.COFORGE_GITHUB_APP_ID);
  const appSlug = env.COFORGE_GITHUB_APP_SLUG?.trim() ?? "";
  const callbackUrl = new URL(env.COFORGE_GITHUB_CALLBACK_URL ?? "");
  if (
    !Number.isSafeInteger(appId) ||
    appId <= 0 ||
    !GITHUB_APP_SLUG.test(appSlug) ||
    !/^[0-9a-f]{64}$/i.test(encryptionKey) ||
    callbackUrl.protocol !== "https:" ||
    callbackUrl.username ||
    callbackUrl.password ||
    callbackUrl.search ||
    callbackUrl.hash ||
    callbackUrl.pathname !== "/api/integrations/github/callback"
  )
    throw new AppError("TEMPORARILY_UNAVAILABLE");
  return {
    appId,
    clientId,
    clientSecret,
    appSlug,
    callbackUrl: callbackUrl.toString(),
    encryptionKey: Uint8Array.from(Buffer.from(encryptionKey, "hex")),
    webhookSecret,
  };
}

export async function configuredGitHub() {
  const config = await readGitHubConfig();
  if (!config) return null;
  const db = requireDatabaseClient();
  return {
    config,
    connection: new GitHubConnection(db, config),
  };
}

export type GitHubAppBotIdentity = { slug: string; botUserId: number };

/**
 * The CoForge GitHub App's own bot identity (its `[bot]` account), used only to build a commit
 * `Co-authored-by` trailer (`github-commit-trailers.ts`). This is independent of `readGitHubConfig`
 * above (no OAuth client secret or encryption key needed) and per-environment, not a secret:
 * `COFORGE_GITHUB_APP_BOT_USER_ID` is the bot *user* id GitHub assigns the App (not the App id
 * itself). Unset or malformed means the feature is unconfigured, not broken: callers get `null`
 * and withhold the trailer rather than throwing.
 */
export function readGitHubAppBotIdentity(
  env: Record<string, string | undefined> = Bun.env,
): GitHubAppBotIdentity | null {
  const slug = env.COFORGE_GITHUB_APP_SLUG?.trim() ?? "";
  const botUserId = Number(env.COFORGE_GITHUB_APP_BOT_USER_ID);
  if (!GITHUB_APP_SLUG.test(slug) || !Number.isSafeInteger(botUserId) || botUserId <= 0)
    return null;
  return { slug, botUserId };
}

async function secret(env: Record<string, string | undefined>, name: string) {
  const inline = env[name]?.trim();
  const path = env[`${name}_FILE`]?.trim();
  if (inline && path) throw new AppError("TEMPORARILY_UNAVAILABLE");
  if (!path) return inline;
  try {
    return (await Bun.file(path).text()).trim();
  } catch {
    throw new AppError("TEMPORARILY_UNAVAILABLE");
  }
}
