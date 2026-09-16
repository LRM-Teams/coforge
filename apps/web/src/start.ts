import { createCsrfMiddleware, createMiddleware, createStart } from "@tanstack/react-start";

import { toPublicServerError } from "@/server/errors/public-error.server";

const csrfMiddleware = createCsrfMiddleware({
  filter: ({ handlerType }) => handlerType === "serverFn",
});

const publicServerFunctionErrors = createMiddleware({
  type: "function",
}).server(async ({ next }) => {
  try {
    return await next();
  } catch (cause) {
    throw toPublicServerError(cause);
  }
});

const agentRequestLogger = createMiddleware().server(async ({ next, request }) => {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/agent/")) return next();

  const startedAt = performance.now();
  const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
  const fields = {
    request_id: requestId,
    method: request.method,
    path: url.pathname,
  };

  console.info(JSON.stringify({ event: "agent_http.request_started", ...fields }));
  try {
    const result = await next();
    console.info(
      JSON.stringify({
        event: "agent_http.request_finished",
        ...fields,
        duration_ms: Math.round(performance.now() - startedAt),
        result_type: result === undefined ? "undefined" : typeof result,
      }),
    );
    return result;
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "agent_http.request_failed",
        ...fields,
        duration_ms: Math.round(performance.now() - startedAt),
        error_type: error instanceof Error ? error.constructor.name : typeof error,
        error_message: error instanceof Error ? error.message : String(error),
      }),
    );
    throw error;
  }
});

export const startInstance = createStart(() => ({
  requestMiddleware: [csrfMiddleware, agentRequestLogger],
  functionMiddleware: [publicServerFunctionErrors],
}));
