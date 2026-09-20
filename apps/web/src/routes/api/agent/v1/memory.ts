import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { agentAuthMiddleware } from "#/server/agents/agent-http.middleware";
import { isAppError, type AppErrorCode } from "#/lib/app-error";
import type { PrismaClient } from "../../../../../generated/client";
import {
  closeMemoryExploration,
  exploreMemoryStep,
  MEMORY_EXPLORATION_MAX_EXPLORE_LIMIT,
  MEMORY_EXPLORATION_MAX_RESULTS,
  MEMORY_EXPLORATION_MAX_STEPS,
  redirectMemoryStep,
  startMemoryExploration,
} from "#/server/group-memory/memory-exploration.server";

/**
 * The Memory Agent's exploration API over the agent HTTP boundary (ADR 0052-E:
 * this API admits only the designated Memory Agent's key — the fence resolves
 * the principal against the designation before any memory content is served;
 * ordinary Agents are refused here, not silently scoped). The wire is plain
 * JSON, one command discriminated on `op`: start | explore | redirect | close
 * (ADR 0052-E's bounded exploration protocol).
 */

const OPERATION_KEY = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const CITATION_ID =
  /^(episode|insight|skill):[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const requestSchema = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("start"),
      startKey: z.string().regex(OPERATION_KEY),
      query: z.string().trim().min(1).max(500),
      maxSteps: z.number().int().min(1).max(MEMORY_EXPLORATION_MAX_STEPS).optional(),
      maxResults: z.number().int().min(1).max(MEMORY_EXPLORATION_MAX_RESULTS).optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal("explore"),
      sessionId: z.string().regex(SESSION_ID),
      operationId: z.string().regex(OPERATION_KEY),
      anchor: z.string().regex(CITATION_ID),
      relation: z.enum(["similar", "related", "collaborators", "skills"]).optional(),
      limit: z.number().int().min(1).max(MEMORY_EXPLORATION_MAX_EXPLORE_LIMIT).optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal("redirect"),
      sessionId: z.string().regex(SESSION_ID),
      operationId: z.string().regex(OPERATION_KEY),
      query: z.string().trim().min(1).max(500),
    })
    .strict(),
  z
    .object({
      op: z.literal("close"),
      sessionId: z.string().regex(SESSION_ID),
      operationId: z.string().regex(OPERATION_KEY),
      found: z.boolean(),
      summary: z.string().trim().max(2000).optional(),
      citationIds: z.array(z.string().regex(CITATION_ID)).max(30).optional(),
    })
    .strict(),
]);

const STATUS_BY_CODE: Record<AppErrorCode, number> = {
  INVALID_INPUT: 400,
  NOT_FOUND: 404,
  ACCESS_DENIED: 403,
  CONFLICT: 409,
  TEMPORARILY_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
  WORKSPACE_REQUIRED: 400,
  COMPUTER_OFFLINE: 503,
  COMPUTER_IDENTITY_UNKNOWN: 403,
  RELEASE_FEED_UNAVAILABLE: 503,
  AGENT_CONTEXT_UNAVAILABLE: 503,
};

export type AgentMemoryPrincipal = { workspaceId: string; agentId: string };

export async function handleAgentMemoryPost(
  request: Request,
  db: PrismaClient,
  principal: AgentMemoryPrincipal,
): Promise<Response> {
  let command: z.infer<typeof requestSchema>;
  try {
    command = requestSchema.parse(await request.json());
  } catch {
    return Response.json(
      { ok: false, errorCode: "gm-memory-request-invalid" },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }
  try {
    switch (command.op) {
      case "start":
        return Response.json(
          {
            ok: true,
            ...(await startMemoryExploration(db, {
              workspaceId: principal.workspaceId,
              agentId: principal.agentId,
              startKey: command.startKey,
              query: command.query,
              ...(command.maxSteps === undefined ? {} : { maxSteps: command.maxSteps }),
              ...(command.maxResults === undefined ? {} : { maxResults: command.maxResults }),
            })),
          },
          { headers: { "cache-control": "no-store" } },
        );
      case "explore":
        return Response.json(
          {
            ok: true,
            ...(await exploreMemoryStep(db, {
              workspaceId: principal.workspaceId,
              agentId: principal.agentId,
              sessionId: command.sessionId,
              operationId: command.operationId,
              anchor: command.anchor,
              ...(command.relation === undefined ? {} : { relation: command.relation }),
              ...(command.limit === undefined ? {} : { limit: command.limit }),
            })),
          },
          { headers: { "cache-control": "no-store" } },
        );
      case "redirect":
        return Response.json(
          {
            ok: true,
            ...(await redirectMemoryStep(db, {
              workspaceId: principal.workspaceId,
              agentId: principal.agentId,
              sessionId: command.sessionId,
              operationId: command.operationId,
              query: command.query,
            })),
          },
          { headers: { "cache-control": "no-store" } },
        );
      case "close":
        return Response.json(
          {
            ok: true,
            ...(await closeMemoryExploration(db, {
              workspaceId: principal.workspaceId,
              agentId: principal.agentId,
              sessionId: command.sessionId,
              operationId: command.operationId,
              found: command.found,
              ...(command.summary === undefined || command.summary === ""
                ? {}
                : { summary: command.summary }),
              ...(command.citationIds === undefined ? {} : { citationIds: command.citationIds }),
            })),
          },
          { headers: { "cache-control": "no-store" } },
        );
    }
  } catch (error) {
    if (isAppError(error)) {
      return Response.json(
        { ok: false, errorCode: error.errorId ?? error.code },
        { status: STATUS_BY_CODE[error.code], headers: { "cache-control": "no-store" } },
      );
    }
    return Response.json(
      { ok: false, errorCode: "gm-memory-request-failed" },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }
}

export const Route = createFileRoute("/api/agent/v1/memory")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      POST: async ({ request, context: { principal, db } }) =>
        handleAgentMemoryPost(request, db, principal),
    },
  },
});
