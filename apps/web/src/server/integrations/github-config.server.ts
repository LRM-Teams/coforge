import { AppError } from "../../lib/app-error";
import { requireDatabaseClient } from "../db/client.server";
import { GitHubConnection, type GitHubConfig } from "./github-connection.server";

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
    !/^[a-z0-9-]+$/.test(appSlug) ||
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
  return { config, connection: new GitHubConnection(db, config) };
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
