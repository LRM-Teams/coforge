import { optionalBrowserUser } from "../auth/require-user.server";
import { requireDatabaseClient } from "../db/client.server";
import { configuredGitHub, readGitHubConfig } from "./github-config.server";
import { applyGitHubWebhookEvent, verifyGitHubWebhookSignature } from "./github-webhook.server";

export const GITHUB_STATE_COOKIE = "__Host-coforge-github-state";

export function githubStateCookie(state: string) {
  return `${GITHUB_STATE_COOKIE}=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${state ? 600 : 0}`;
}

export async function githubCallbackHandler({ request }: { request: Request }) {
  const headers = new Headers({ "cache-control": "no-store", "referrer-policy": "no-referrer" });
  const user = optionalBrowserUser(request.headers.get("cookie") ?? undefined);
  if (!user) return new Response(null, { status: 401, headers });
  const params = new URL(request.url).searchParams;
  const state = params.get("state") ?? "";
  // GitHub can return from an independently initiated installation with a code but
  // no CoForge state. Do NOT link an identity or exchange that unbound code.
  if (!state) {
    headers.set("location", "/settings?section=integrations");
    return new Response(null, { status: 303, headers });
  }
  headers.set("set-cookie", githubStateCookie(""));
  let connected: boolean | "wrong_account" = false;
  try {
    const github = await configuredGitHub();
    const cookie =
      (request.headers.get("cookie") ?? "")
        .split(/;\s*/)
        .find((part) => part.startsWith(`${GITHUB_STATE_COOKIE}=`))
        ?.slice(GITHUB_STATE_COOKIE.length + 1) ?? "";
    if (github)
      connected = await github.connection.complete(
        user.id,
        cookie,
        state,
        params.has("error") ? "" : (params.get("code") ?? ""),
      );
  } catch {
    // Never put GitHub response bodies, authorization codes or secrets in errors/logs.
  }
  if (connected === true) {
    try {
      const github = await configuredGitHub();
      if (github) {
        const overview = await github.connection.overview(user.id);
        if (overview.status === "pending_installation") {
          headers.set("location", overview.installUrl);
          return new Response(null, { status: 303, headers });
        }
      }
    } catch {
      // The connection was completed. Leave the user on Settings if the
      // installation lookup is temporarily unavailable.
    }
  }
  headers.set(
    "location",
    `/settings?section=integrations&github=${connected === true ? "connected" : connected === "wrong_account" ? "wrong_account" : "error"}`,
  );
  return new Response(null, { status: 303, headers });
}

const GITHUB_SIGNATURE_HEADER = "x-hub-signature-256";
const GITHUB_EVENT_HEADER = "x-github-event";

/**
 * GitHub subscribes here instead of the settings page polling api.github.com (slow and
 * sometimes timing out from the production server's network path). See ADR 0019.
 * Always reads the raw body once and verifies its signature before any JSON parsing.
 */
export async function githubWebhookHandler({ request }: { request: Request }) {
  const headers = new Headers({ "cache-control": "no-store" });
  const config = await readGitHubConfig();
  if (!config || !config.webhookSecret) return new Response(null, { status: 503, headers });
  const rawBody = await request.text();
  if (
    !verifyGitHubWebhookSignature(
      config.webhookSecret,
      rawBody,
      request.headers.get(GITHUB_SIGNATURE_HEADER),
    )
  )
    return new Response(null, { status: 401, headers });
  const event = request.headers.get(GITHUB_EVENT_HEADER) ?? "";
  try {
    // Never log GitHub webhook bodies: they can carry account and installation details.
    const payload: unknown = JSON.parse(rawBody);
    await applyGitHubWebhookEvent(requireDatabaseClient(), config, event, payload);
  } catch {
    // Malformed JSON or an unexpected payload shape. GitHub retries non-2xx responses,
    // but a payload we cannot understand will not become understandable on retry either.
  }
  // GitHub retries non-2xx responses. Respond 204 for both handled and ignored event types
  // so an event type this handler does not care about is never retried.
  return new Response(null, { status: 204, headers });
}
