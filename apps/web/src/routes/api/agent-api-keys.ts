import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import {
  createAgentApiKey,
  findAgentApiKey,
  isAgentApiKeyBoundToComputer,
} from "#src/server/agents/agent-api-key.server";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import { PrismaAgentApiKeyRepository } from "#src/server/db/repositories/agent-api-key.repositories.server";
import { getDatabaseClient } from "#src/server/db/client.server";
import { verifyDaemonApiKey } from "#src/server/auth/daemon-api-key.server";
import { PrismaDaemonApiKeyRepository } from "#src/server/db/repositories/daemon-api-key.repositories.server";
import { parseAgentRuntimeConfig } from "#src/server/agents/agent-runtime-config.server";
import {
  AgentRuntimeCredentials,
  readOptionalAgentRuntimeCredentialEncryptionKey,
} from "#src/server/agents/agent-runtime-credentials.server";
import { PrismaAgentRuntimeCredentialRepository } from "#src/server/db/repositories/agent-runtime-credential.repositories.server";
import { AgentControl } from "#src/server/agents/agent-control.server";
import { PrismaAgentControlStore } from "#src/server/db/repositories/agent-control.repositories.server";
import { getAgentRuntimeLock } from "#src/server/agents/agent-runtime-lock.server";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { ComputerRuntimeVisibility } from "#src/server/computers/computer-runtime-visibility.server";
import { PrismaComputerRuntimeRepository } from "#src/server/db/repositories/computer-runtime.repositories.server";
import { decryptAgentEnvironment } from "#src/server/agents/agent-environment.server";
import {
  buildAgentRuntimeContext,
  type AgentRuntimeContextComputer,
} from "#src/server/agents/agent-runtime-context.server";

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

/** The daemon behind a Bearer API key and the database it was verified against, or the error response. */
async function authenticateDaemon(request: Request) {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer "))
    return Response.json({ error: "unauthorized" }, { status: 401 });
  const db = getDatabaseClient();
  if (!db) return Response.json({ error: "service unavailable" }, { status: 503 });
  try {
    const principal = await verifyDaemonApiKey(
      header.slice(7).trim(),
      new PrismaDaemonApiKeyRepository(db),
    );
    return { principal, db };
  } catch {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
}

/** The parsed request body, or the error response. */
async function parseBody<T>(request: Request, schema: z.ZodType<T>) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "bad request" }, { status: 400 });
  }
  const input = schema.safeParse(body);
  return input.success ? input.data : Response.json({ error: "bad request" }, { status: 400 });
}

type LaunchIdentityComputer = AgentRuntimeContextComputer;

/**
 * The Agent's server-authored identity for the Daemon's standing prompt (`agent-instructions.ts`
 * on the Daemon side). It travels in this launch-config response because that is where the Agent's
 * other per-launch server data (`apiKey`/`providerConfig`/`envVars`) already travels; see ADR
 * 0036's "Prompt versus Manual placement" table. Every field is omitted rather than sent empty
 * so an older Daemon's defensive decoder degrades cleanly.
 */
function buildAgentLaunchIdentity(agent: {
  name: string;
  displayName: string;
  description: string;
  workspaceId: string;
  workspace: { slug: string; name: string } | null;
  computerId: string;
  computer: LaunchIdentityComputer;
}) {
  const runtimeContext = buildAgentRuntimeContext(agent);
  const identity = {
    ...(agent.name ? { name: agent.name } : {}),
    ...(agent.displayName ? { displayName: agent.displayName } : {}),
    ...(agent.description ? { description: agent.description } : {}),
    ...(Object.keys(runtimeContext).length > 0 ? { runtimeContext } : {}),
  };
  return Object.keys(identity).length > 0 ? identity : undefined;
}

export const Route = createFileRoute("/api/agent-api-keys")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const daemon = await authenticateDaemon(request);
        if (daemon instanceof Response) return daemon;
        const { principal, db } = daemon;
        const input = await parseBody(request, createAgentApiKeyInputSchema);
        if (input instanceof Response) return input;
        const agent = await db.agent.findFirst({
          where: {
            id: input.agentId,
            workspaceId: input.workspaceId,
            computerId: principal.computerId,
            ...ACTIVE_AGENT_WHERE,
            owner: {
              memberships: { some: { workspaceId: input.workspaceId } },
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
            name: true,
            displayName: true,
            description: true,
            weeklyReportAssistant: { select: { id: true } },
            weeklyReportCollectorBinding: { select: { id: true } },
            workspace: { select: { slug: true, name: true } },
            computer: {
              select: {
                name: true,
                displayName: true,
                platform: true,
                osVersion: true,
                computerVersion: true,
              },
            },
          },
        });
        if (principal.workspaceId !== input.workspaceId || !agent)
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
          ).authorizeLaunch({ ...input, computerId: principal.computerId });
        } catch {
          return Response.json({ error: "forbidden" }, { status: 403 });
        }
        let providerConfig;
        let envVars;
        try {
          const config = parseAgentRuntimeConfig(agent.runtimeConfig);
          const encryptionKey = await readOptionalAgentRuntimeCredentialEncryptionKey(Bun.env);
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
        const identity = buildAgentLaunchIdentity({
          name: agent.name,
          displayName: agent.displayName,
          description: agent.description,
          workspaceId: agent.workspaceId,
          workspace: agent.workspace,
          computerId: principal.computerId,
          // The lookup above already requires `computerId: principal.computerId`.
          computer: agent.computer,
        });
        const assignedSkillPacks = agent.weeklyReportAssistant
          ? (["weekly-report"] as const)
          : agent.weeklyReportCollectorBinding
            ? (["weekly-report-collect"] as const)
            : [];
        return Response.json(
          {
            apiKey,
            providerConfig,
            envVars,
            ...(assignedSkillPacks.length > 0
              ? { assignedSkillPacks: [...assignedSkillPacks] }
              : {}),
            ...(identity ? { identity } : {}),
          },
          { headers: { "cache-control": "no-store" } },
        );
      },
      DELETE: async ({ request }) => {
        const daemon = await authenticateDaemon(request);
        if (daemon instanceof Response) return daemon;
        const { principal, db } = daemon;
        const input = await parseBody(request, revokeAgentApiKeyInputSchema);
        if (input instanceof Response) return input;
        const repository = new PrismaAgentApiKeyRepository(db);
        let apiKey;
        try {
          apiKey = await findAgentApiKey(input.apiKey, repository);
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
