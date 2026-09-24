import { expect, test } from "bun:test";
import { AppError } from "#src/lib/app-error";
import { agentRouteDomainErrorResponse } from "#src/server/agents/agent-http-routes.server";

async function responseBody(response: Response) {
  return { status: response.status, body: await response.json() };
}

test("agent domain route errors use the shared standard HTTP mapping", async () => {
  await expect(
    responseBody(agentRouteDomainErrorResponse({ code: "NOT_FOUND" }, "fallback")),
  ).resolves.toEqual({ status: 404, body: { error: "not found" } });
  await expect(
    responseBody(agentRouteDomainErrorResponse(new AppError("ACCESS_DENIED"), "fallback")),
  ).resolves.toEqual({ status: 403, body: { error: "forbidden" } });
  await expect(
    responseBody(agentRouteDomainErrorResponse({ code: "INVALID_INPUT" }, "fallback")),
  ).resolves.toEqual({ status: 400, body: { error: "invalid input" } });
});

test("unknown agent domain errors use the route fallback", async () => {
  await expect(
    responseBody(agentRouteDomainErrorResponse({ code: "INTERNAL_ERROR" }, "invalid report")),
  ).resolves.toEqual({ status: 400, body: { error: "invalid report" } });
  await expect(
    responseBody(agentRouteDomainErrorResponse(new Error("broken"), "invalid report")),
  ).resolves.toEqual({ status: 400, body: { error: "invalid report" } });
});
