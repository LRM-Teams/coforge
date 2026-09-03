import { createCsrfMiddleware, createMiddleware, createStart } from "@tanstack/react-start";

import { toPublicServerError } from "@/server/errors/public-error.server";

const csrfMiddleware = createCsrfMiddleware({
  filter: ({ handlerType }) => handlerType === "serverFn",
});

const publicServerFunctionErrors = createMiddleware({ type: "function" }).server(
  async ({ next }) => {
    try {
      return await next();
    } catch (cause) {
      throw toPublicServerError(cause);
    }
  },
);

export const startInstance = createStart(() => ({
  requestMiddleware: [csrfMiddleware],
  functionMiddleware: [publicServerFunctionErrors],
}));
