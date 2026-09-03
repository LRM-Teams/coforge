import {
  completeBrowserLogin,
  createAuthingExchanger,
  endBrowserLogin,
  readBrowserSession,
  startBrowserLogin,
  type AuthingConfig,
  type BrowserUser,
  type InternalUserResolver,
  type TokenExchanger,
} from "./browser-login.server";
import { UserIdentityRepository } from "./user-identity.repository.server";
import { getDatabaseClient } from "../db/client.server";
import { workspaceIdForUser } from "../workspaces/enrollment.server";

export function handleLoginStart(input: {
  config: AuthingConfig;
  sessionSecret: string;
}): Response {
  const started = startBrowserLogin({
    config: input.config,
    sessionSecret: input.sessionSecret,
  });
  return redirect(started.authorizationUrl, {
    "set-cookie": started.stateCookie,
    "cache-control": "no-store",
  });
}

export async function handleLoginCallback(input: {
  request: Request;
  config: AuthingConfig;
  sessionSecret: string;
  authing?: TokenExchanger;
  resolveUser?: Parameters<typeof completeBrowserLogin>[0]["resolveUser"];
  enrollUser?: (userId: string) => Promise<void>;
}): Promise<Response> {
  const url = new URL(input.request.url);
  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";
  const origin = url.origin;
  try {
    const completed = await completeBrowserLogin({
      config: input.config,
      sessionSecret: input.sessionSecret,
      code,
      state,
      cookieHeader: input.request.headers.get("cookie") ?? "",
      authing: input.authing ?? createAuthingExchanger(input.config),
      resolveUser: input.resolveUser ?? persistedIdentityResolver(),
    });
    if (input.enrollUser) await input.enrollUser(completed.user.id);
    else {
      const db = getDatabaseClient();
      if (!db) throw new Error("database is required");
      await workspaceIdForUser(
        db,
        completed.user,
        input.request.headers.get("accept-language") ?? "",
      );
    }
    return redirect("/", {
      "set-cookie": [completed.sessionCookie, completed.clearStateCookie],
      "cache-control": "no-store",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "login failed";
    return redirect(`${origin}/login?error=${encodeURIComponent(message)}`, {
      "cache-control": "no-store",
    });
  }
}

export function handleLogout(input: { origin: string; config: AuthingConfig }): Response {
  const ended = endBrowserLogin({
    config: input.config,
    postLogoutRedirectUri: `${input.origin}/login`,
  });
  return redirect(ended.authingLogoutUrl, {
    "set-cookie": ended.clearSessionCookie,
    "cache-control": "no-store",
  });
}

export function handleCurrentUser(input: { request: Request; sessionSecret: string }): Response {
  const user = readRequestUser(input.request, input.sessionSecret);
  if (!user) {
    return Response.json({ error: "unauthorized" }, { status: 401, headers: noStore() });
  }
  return Response.json({ user }, { headers: noStore() });
}

export function readRequestUser(request: Request, sessionSecret: string): BrowserUser | null {
  return readBrowserSession({
    sessionSecret,
    cookieHeader: request.headers.get("cookie") ?? "",
  });
}

function persistedIdentityResolver(): InternalUserResolver {
  const db = getDatabaseClient();
  if (!db) throw new Error("database is required");
  const identities = new UserIdentityRepository(db);
  return (identity) =>
    identities.resolve(identity.provider, identity.subject, {
      email: identity.email,
      preferredUsername: identity.preferredUsername,
    });
}

function redirect(
  location: string,
  headers: { "set-cookie"?: string | string[]; "cache-control"?: string },
): Response {
  const response = new Headers({
    location,
    "cache-control": headers["cache-control"] ?? "no-store",
  });
  const cookies = headers["set-cookie"];
  if (typeof cookies === "string") response.append("set-cookie", cookies);
  if (Array.isArray(cookies)) {
    for (const cookie of cookies) response.append("set-cookie", cookie);
  }
  return new Response(null, { status: 302, headers: response });
}

function noStore(): HeadersInit {
  return { "cache-control": "no-store" };
}
