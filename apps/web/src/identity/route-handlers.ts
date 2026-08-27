import { AuthConfigError, readAuthingConfig, readSessionSecret } from "./config";
import { handleCurrentUser, handleLoginCallback, handleLoginStart, handleLogout } from "./http";

export function loginStartHandler({ request }: { request: Request }): Response | Promise<Response> {
  return withAuthConfig(request, (config, sessionSecret) =>
    handleLoginStart({ config, sessionSecret }),
  );
}

export function loginCallbackHandler({ request }: { request: Request }): Promise<Response> {
  return Promise.resolve(
    withAuthConfig(request, (config, sessionSecret) =>
      handleLoginCallback({ request, config, sessionSecret }),
    ),
  );
}

export function logoutHandler({ request }: { request: Request }): Response | Promise<Response> {
  return withAuthConfig(request, (config, _sessionSecret) =>
    handleLogout({ origin: new URL(request.url).origin, config }),
  );
}

export function currentUserHandler({ request }: { request: Request }): Response {
  try {
    return handleCurrentUser({
      request,
      sessionSecret: readSessionSecret(process.env),
    });
  } catch (error) {
    if (error instanceof AuthConfigError) {
      return Response.json({ error: error.message }, { status: 503 });
    }
    throw error;
  }
}

function withAuthConfig(
  request: Request,
  handle: (
    config: ReturnType<typeof readAuthingConfig>,
    sessionSecret: string,
  ) => Response | Promise<Response>,
): Response | Promise<Response> {
  try {
    const origin = new URL(request.url).origin;
    return handle(readAuthingConfig(process.env, origin), readSessionSecret(process.env));
  } catch (error) {
    if (error instanceof AuthConfigError) {
      return new Response(error.message, { status: 503, headers: { "cache-control": "no-store" } });
    }
    throw error;
  }
}
