import { createFileRoute } from "@tanstack/react-router";
import {
  createAgentApiKey,
  findAgentApiKey,
  isAgentApiKeyBoundToComputer,
} from "#/server/agents/agent-api-key.server";
import { PrismaAgentApiKeyRepository } from "#/server/db/repositories/agent-api-key.repositories.server";
import { getDatabaseClient } from "#/server/db/client.server";
import { verifyDaemonApiKey } from "#/server/auth/daemon-api-key.server";
import { PrismaDaemonApiKeyRepository } from "#/server/db/repositories/daemon-api-key.repositories.server";

export const Route = createFileRoute("/api/agent-api-keys")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const header = request.headers.get("authorization");
        if (!header?.startsWith("Bearer "))
          return Response.json({ error: "unauthorized" }, { status: 401 });
        let principal: Awaited<ReturnType<typeof verifyDaemonApiKey>>;
        try {
          const db = getDatabaseClient();
          if (!db) throw new Error("database unavailable");
          principal = await verifyDaemonApiKey(
            header.slice(7).trim(),
            new PrismaDaemonApiKeyRepository(db),
          );
        } catch {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
        let body: { agentId?: unknown; workspaceId?: unknown };
        try {
          body = await request.json();
        } catch {
          return Response.json({ error: "bad request" }, { status: 400 });
        }
        if (typeof body.agentId !== "string" || typeof body.workspaceId !== "string")
          return Response.json({ error: "bad request" }, { status: 400 });
        const db = getDatabaseClient();
        if (!db) return Response.json({ error: "service unavailable" }, { status: 503 });
        const agent = await db.agent.findFirst({
          where: {
            id: body.agentId,
            workspaceId: body.workspaceId,
            ownerId: principal.userId,
            computerId: principal.computerId,
            workspace: {
              members: { some: { userId: principal.userId } },
              computers: { some: { computerId: principal.computerId } },
            },
          },
          select: { id: true, workspaceId: true, ownerId: true },
        });
        if (principal.workspaceId !== body.workspaceId || !agent)
          return Response.json({ error: "forbidden" }, { status: 403 });
        const apiKey = await createAgentApiKey({
          agentId: agent.id,
          workspaceId: agent.workspaceId,
          ownerId: agent.ownerId,
          computerId: principal.computerId,
          repository: new PrismaAgentApiKeyRepository(db),
        });
        return Response.json({ apiKey }, { headers: { "cache-control": "no-store" } });
      },
      DELETE: async ({ request }) => {
        const header = request.headers.get("authorization");
        if (!header?.startsWith("Bearer "))
          return Response.json({ error: "unauthorized" }, { status: 401 });
        let principal: Awaited<ReturnType<typeof verifyDaemonApiKey>>;
        try {
          const db = getDatabaseClient();
          if (!db) throw new Error("database unavailable");
          principal = await verifyDaemonApiKey(
            header.slice(7).trim(),
            new PrismaDaemonApiKeyRepository(db),
          );
        } catch {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
        let body: { apiKey?: unknown };
        try {
          body = await request.json();
        } catch {
          return Response.json({ error: "bad request" }, { status: 400 });
        }
        if (typeof body.apiKey !== "string")
          return Response.json({ error: "bad request" }, { status: 400 });
        const db = getDatabaseClient();
        if (!db) return Response.json({ error: "service unavailable" }, { status: 503 });
        const repository = new PrismaAgentApiKeyRepository(db);
        let apiKey;
        try {
          apiKey = await findAgentApiKey(body.apiKey, repository);
        } catch {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
        const authorized =
          isAgentApiKeyBoundToComputer(apiKey, principal) &&
          (await db.workspaceComputer.findUnique({
            where: {
              workspaceId_computerId: {
                workspaceId: principal.workspaceId,
                computerId: principal.computerId,
              },
            },
            select: { id: true },
          }));
        if (!authorized) return Response.json({ error: "forbidden" }, { status: 403 });
        if (apiKey.disabledAt) return Response.json({ error: "unauthorized" }, { status: 401 });
        await repository.revoke(apiKey.id);
        return Response.json({ revoked: true }, { headers: { "cache-control": "no-store" } });
      },
    },
  },
});
