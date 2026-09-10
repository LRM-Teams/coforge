import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import {
  createAgentApiKey,
  findAgentApiKey,
  isAgentApiKeyBoundToComputer,
} from "#/server/agents/agent-api-key.server";
import { PrismaAgentApiKeyRepository } from "#/server/db/repositories/agent-api-key.repositories.server";
import { getDatabaseClient } from "#/server/db/client.server";
import { verifyDaemonApiKey } from "#/server/auth/daemon-api-key.server";
import { PrismaDaemonApiKeyRepository } from "#/server/db/repositories/daemon-api-key.repositories.server";
import { parseAgentRuntimeConfig } from "#/server/agents/agent-runtime-config.server";
import {
  AgentRuntimeCredentials,
  readOptionalAgentRuntimeCredentialEncryptionKey,
} from "#/server/agents/agent-runtime-credentials.server";
import { PrismaAgentRuntimeCredentialRepository } from "#/server/db/repositories/agent-runtime-credential.repositories.server";
import { AgentControl } from "#/server/agents/agent-control.server";
import { PrismaAgentControlStore } from "#/server/db/repositories/agent-control.repositories.server";
import { getAgentRuntimeLock } from "#/server/agents/agent-runtime-lock.server";
import { createCentrifugoServerApi } from "#/server/centrifugo/server-api.server";
import { ComputerRuntimeVisibility } from "#/server/computers/computer-runtime-visibility.server";
import { PrismaComputerRuntimeRepository } from "#/server/db/repositories/computer-runtime.repositories.server";
import { decryptAgentEnvironment } from "#/server/agents/agent-environment.server";

const createAgentApiKeyInputSchema = z.object({
  agentId: z.string().min(1),
  workspaceId: z.string().min(1),
  controlEpoch: z.number().int().positive().optional(),
  requestId: z.string().uuid().optional(),
  launchId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/)
    .optional(),
});
const revokeAgentApiKeyInputSchema = z.object({ apiKey: z.string().min(1) });

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
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return Response.json({ error: "bad request" }, { status: 400 });
        }
        const input = createAgentApiKeyInputSchema.safeParse(body);
        if (!input.success) return Response.json({ error: "bad request" }, { status: 400 });
        const db = getDatabaseClient();
        if (!db) return Response.json({ error: "service unavailable" }, { status: 503 });
        const agent = await db.agent.findFirst({
          where: {
            id: input.data.agentId,
            workspaceId: input.data.workspaceId,
            computerId: principal.computerId,
            owner: {
              memberships: { some: { workspaceId: input.data.workspaceId } },
            },
            workspace: {
              members: { some: { userId: principal.userId } },
              computers: { some: { computerId: principal.computerId } },
            },
          },
          select: {
            id: true,
            workspaceId: true,
            ownerId: true,
            runtimeConfig: true,
          },
        });
        if (principal.workspaceId !== input.data.workspaceId || !agent)
          return Response.json({ error: "forbidden" }, { status: 403 });
        try {
          const visibility = new ComputerRuntimeVisibility(new PrismaComputerRuntimeRepository(db));
          if (
            !(await visibility.canSelect(
              { userId: agent.ownerId, workspaceId: agent.workspaceId },
              principal.computerId,
              parseAgentRuntimeConfig(agent.runtimeConfig).runtime,
            ))
          )
            throw new Error("Runtime is not available");
          await new AgentControl(
            new PrismaAgentControlStore(db),
            createCentrifugoServerApi(),
            getAgentRuntimeLock(),
          ).authorizeLaunch({ ...input.data, computerId: principal.computerId });
        } catch {
          return Response.json({ error: "forbidden" }, { status: 403 });
        }
        let providerConfig;
        let envVars;
        try {
          const config = parseAgentRuntimeConfig(agent.runtimeConfig);
          const encryptionKey = readOptionalAgentRuntimeCredentialEncryptionKey(Bun.env);
          providerConfig = await new AgentRuntimeCredentials(
            new PrismaAgentRuntimeCredentialRepository(db),
            encryptionKey,
          ).launchProviderConfig(agent.id, config);
          envVars = await decryptAgentEnvironment(agent.id, config.environment, encryptionKey);
        } catch {
          return Response.json(
            { error: "service unavailable" },
            { status: 503, headers: { "cache-control": "no-store" } },
          );
        }
        const apiKey = await createAgentApiKey({
          agentId: agent.id,
          workspaceId: agent.workspaceId,
          ownerId: agent.ownerId,
          computerId: principal.computerId,
          repository: new PrismaAgentApiKeyRepository(db),
        });
        return Response.json(
          { apiKey, providerConfig, envVars },
          { headers: { "cache-control": "no-store" } },
        );
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
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return Response.json({ error: "bad request" }, { status: 400 });
        }
        const input = revokeAgentApiKeyInputSchema.safeParse(body);
        if (!input.success) return Response.json({ error: "bad request" }, { status: 400 });
        const db = getDatabaseClient();
        if (!db) return Response.json({ error: "service unavailable" }, { status: 503 });
        const repository = new PrismaAgentApiKeyRepository(db);
        let apiKey;
        try {
          apiKey = await findAgentApiKey(input.data.apiKey, repository);
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
