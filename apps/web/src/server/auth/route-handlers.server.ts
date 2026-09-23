import { AuthConfigError, readAuthingConfig, readSessionSecret } from "./config.server";
import {
  handleCurrentUser,
  handleLoginCallback,
  handleLoginStart,
  handleLogout,
} from "./http.server";
import { publicOrigin } from "#src/server/http/public-origin.server";

export function loginStartHandler({ request }: { request: Request }): Promise<Response> {
  return withAuthConfig(request, (config, sessionSecret) =>
    handleLoginStart({ config, sessionSecret }),
  );
}

export function loginCallbackHandler({ request }: { request: Request }): Promise<Response> {
  return withAuthConfig(request, (config, sessionSecret) =>
    handleLoginCallback({ request, config, sessionSecret }),
  );
}

export function logoutHandler({ request }: { request: Request }): Promise<Response> {
  return withAuthConfig(request, (config, sessionSecret) =>
    handleLogout({
      origin: publicOrigin(request),
      config,
      sessionSecret,
      cookieHeader: request.headers.get("cookie") ?? "",
    }),
  );
}

export async function currentUserHandler({ request }: { request: Request }): Promise<Response> {
  try {
    return handleCurrentUser({
      request,
      sessionSecret: await readSessionSecret(process.env),
    });
  } catch (error) {
    if (error instanceof AuthConfigError) {
      return authUnavailableResponse();
    }
    throw error;
  }
}

async function withAuthConfig(
  request: Request,
  handle: (
    config: Awaited<ReturnType<typeof readAuthingConfig>>,
    sessionSecret: string,
  ) => Response | Promise<Response>,
): Promise<Response> {
  try {
    const origin = new URL(request.url).origin;
    return handle(
      await readAuthingConfig(process.env, origin),
      await readSessionSecret(process.env),
    );
  } catch (error) {
    if (error instanceof AuthConfigError) {
      return authUnavailableResponse();
    }
    throw error;
  }
}

function authUnavailableResponse(): Response {
  return Response.json(
    { code: "TEMPORARILY_UNAVAILABLE" },
    { status: 503, headers: { "cache-control": "no-store" } },
  );
}
