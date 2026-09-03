import { describe, expect, mock, test } from "bun:test";
import { notFound, redirect } from "@tanstack/react-router";

import { AppError, isAppError } from "@/lib/app-error";
import { toPublicServerError } from "@/server/errors/public-error.server";
import { startInstance } from "@/start";

describe("server error disclosure", () => {
  test("replaces an unexpected exception and reports only safe diagnostics", () => {
    const report = mock((_record: unknown) => {});
    const cause = new Error(
      "Can't reach database server at postgresql://user:secret@127.0.0.1:15432",
    );
    cause.name = "secret@127.0.0.1";
    Object.assign(cause, { code: "PASSWORD_SECRET" });
    const result = toPublicServerError(cause, report, () => "error-id");

    expect(result).toEqual(
      new AppError("INTERNAL_ERROR", {
        errorId: "error-id",
      }),
    );
    expect(JSON.stringify(report.mock.calls)).not.toContain("secret");
    expect(JSON.stringify(report.mock.calls)).not.toContain("127.0.0.1");
    expect(report).toHaveBeenCalledWith({
      event: "server_operation_failed",
      errorId: "error-id",
      errorType: "error",
    });
  });

  test("preserves deliberate public errors and Router control flow", () => {
    const publicError = new AppError("INVALID_INPUT");
    const redirectResult = redirect({ href: "/login" });
    const notFoundResult = notFound();

    expect(toPublicServerError(publicError)).toBe(publicError);
    expect(toPublicServerError(redirectResult)).toBe(redirectResult);
    expect(toPublicServerError(notFoundResult)).toBe(notFoundResult);
  });

  test("public errors never carry a server stack", () => {
    const error = new AppError("INTERNAL_ERROR", { errorId: "error-id" });
    expect(error.stack).toBeUndefined();
  });

  test("public error details survive TanStack's shallow Error serialization", () => {
    const original = new AppError("INTERNAL_ERROR", {
      errorId: "99e7af75-e39c-4bc9-bfdb-c1f76c5306ac",
    });
    const deserialized = new Error(original.message);

    expect(isAppError(deserialized)).toBeTrue();
    expect(deserialized).toMatchObject({
      name: "AppError",
      code: "INTERNAL_ERROR",
      errorId: "99e7af75-e39c-4bc9-bfdb-c1f76c5306ac",
    });
    expect(deserialized.stack).toBeUndefined();

    const withoutReference = new Error(new AppError("INVALID_INPUT").message);
    expect(isAppError(withoutReference)).toBeTrue();
    expect(withoutReference).toMatchObject({ code: "INVALID_INPUT" });
    expect(Reflect.has(withoutReference, "errorId")).toBeFalse();
  });

  test("the configured function middleware sanitizes unexpected exceptions", async () => {
    const options = await startInstance.getOptions();
    const middleware = options.functionMiddleware?.[0]?.options.server;
    if (!middleware) throw new Error("function middleware missing");

    let result: unknown;
    try {
      await middleware({
        next: async () => {
          throw new Error("database password is secret");
        },
      } as never);
    } catch (error) {
      result = error;
    }

    expect(result).toBeInstanceOf(AppError);
    expect((result as AppError).code).toBe("INTERNAL_ERROR");
    expect((result as AppError).errorId).toMatch(/^[0-9a-f-]{36}$/);
    expect((result as AppError).stack).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  test("the configured request middleware rejects cross-site Server Function posts", async () => {
    const options = await startInstance.getOptions();
    const middleware = options.requestMiddleware?.[0]?.options.server;
    if (!middleware) throw new Error("request middleware missing");
    const next = mock(async () => new Response("executed"));

    const rejected = await middleware({
      request: new Request("https://coforge.test/_server", {
        method: "POST",
        headers: { origin: "https://attacker.test" },
      }),
      handlerType: "serverFn",
      next,
    } as never);
    if (!(rejected instanceof Response)) throw new Error("expected a response");
    expect(rejected.status).toBe(403);
    expect(next).not.toHaveBeenCalled();

    const accepted = await middleware({
      request: new Request("https://coforge.test/_server", {
        method: "POST",
        headers: { origin: "https://coforge.test" },
      }),
      handlerType: "serverFn",
      next,
    } as never);
    if (!(accepted instanceof Response)) throw new Error("expected a response");
    expect(accepted.status).toBe(200);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
