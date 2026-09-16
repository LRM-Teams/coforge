import { createServerFn } from "@tanstack/react-start";
import { getRequest, setResponseHeader } from "@tanstack/react-start/server";
import { z } from "zod";
import { AppError } from "../../lib/app-error";
import { authMiddleware } from "../../server/auth/function-auth";
import { configuredGitHub } from "../../server/integrations/github-config.server";
import {
  githubInstallationStateCookie,
  githubStateCookie,
} from "../../server/integrations/github-http.server";

async function requiredGitHub() {
  const github = await configuredGitHub();
  if (!github) throw new AppError("TEMPORARILY_UNAVAILABLE");
  return github;
}

export const getGitHubConnection = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    setResponseHeader("cache-control", "no-store");
    const userId = context.user.id;
    const github = await configuredGitHub();
    if (!github) return { status: "unconfigured" as const, login: null, installUrl: null };
    return github.connection.overview(userId);
  });

export const startGitHubConnection = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const userId = context.user.id;
    const github = await requiredGitHub();
    // Prevent a sibling subdomain using a production session to start a connection.
    if (getRequest().headers.get("origin") !== new URL(github.config.callbackUrl).origin)
      throw new AppError("ACCESS_DENIED");
    const attempt = await github.connection.begin(userId);
    setResponseHeader("set-cookie", githubStateCookie(attempt.state));
    return { url: attempt.url };
  });

export const startGitHubReauthorization = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const userId = context.user.id;
    const github = await requiredGitHub();
    if (getRequest().headers.get("origin") !== new URL(github.config.callbackUrl).origin)
      throw new AppError("ACCESS_DENIED");
    const attempt = await github.connection.begin(userId, "reauthorize");
    setResponseHeader("set-cookie", githubStateCookie(attempt.state));
    return { url: attempt.url };
  });

export const startGitHubInstallation = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async () => {
    const github = await requiredGitHub();
    if (getRequest().headers.get("origin") !== new URL(github.config.callbackUrl).origin)
      throw new AppError("ACCESS_DENIED");
    const attempt = github.connection.beginInstallation();
    setResponseHeader("set-cookie", githubInstallationStateCookie(attempt.state));
    return { url: attempt.url };
  });

export const refreshGitHubConnection = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const userId = context.user.id;
    const github = await requiredGitHub();
    if (getRequest().headers.get("origin") !== new URL(github.config.callbackUrl).origin)
      throw new AppError("ACCESS_DENIED");
    return github.connection.sync(userId);
  });

export const disconnectGitHub = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const userId = context.user.id;
    const github = await requiredGitHub();
    if (getRequest().headers.get("origin") !== new URL(github.config.callbackUrl).origin)
      throw new AppError("ACCESS_DENIED");
    await github.connection.disconnect(userId);
    setResponseHeader("set-cookie", githubStateCookie(""));
    return { ok: true as const };
  });

const page = z.number().int().min(1).max(10000);
export const listGitHubInstallations = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(z.object({ page }))
  .handler(async ({ data, context }) => {
    const userId = context.user.id;
    return (await requiredGitHub()).connection.installations(userId, data.page);
  });

export const listGitHubRepositories = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(z.object({ installationId: z.number().int().positive().safe(), page }))
  .handler(async ({ data, context }) => {
    const userId = context.user.id;
    return (await requiredGitHub()).connection.repositories(userId, data.installationId, data.page);
  });

export const listAccessibleGitHubRepositories = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) =>
    (await requiredGitHub()).connection.accessibleRepositories(context.user.id),
  );
