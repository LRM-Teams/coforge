import { expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/client";
import { DEV_BROWSER_USER } from "../src/server/auth/dev-skip-auth.server";
import {
  createWorkspaceWorkerTokenIssuer,
  verifyWorkspaceWorkerToken,
} from "../src/server/auth/workspace-worker-token.server";
import { ComputerRegistrar } from "../src/server/computers/registration.server";
import {
  PrismaComputerConnectionRepository,
  PrismaWorkspaceAccess,
} from "../src/server/db/repositories/setup.repositories.server";
import { PrismaAgentRepository } from "../src/server/db/repositories/agent.repositories.server";
import { AgentCollection } from "../src/server/agents/agent-collection.server";
import { PrismaDirectConversationRepository } from "../src/server/db/repositories/direct-conversation.repositories.server";
import { SendDirectMessage } from "../src/server/conversations/direct-message.server";
import { RedisMessageRequestIdempotency } from "../src/server/conversations/redis-message-request-idempotency.server";
import { createCentrifugoServerApi } from "../src/server/centrifugo/server-api.server";
import {
  CentrifugoWorkspaceTransport,
  DaemonRuntime,
  InMemoryDaemonCredentialStore,
  PiAgentAdapter,
  startAgentProxy,
} from "../../coforge-daemon";

const databaseUrl = requireEnvironment("DATABASE_URL");
if (requireEnvironment("COFORGE_E2E_ALLOW_RESET") !== "1")
  throw new Error("COFORGE_E2E_ALLOW_RESET=1 is required for destructive E2E cleanup");
const workspaceId = "10000000-0000-4000-8000-000000000001";
const workspaceRoot = join(import.meta.dir, "../../../.amp/e2e/workspace-root");

test("Agent direct message crosses PostgreSQL, Redis, Centrifugo, Daemon, and Agent HTTPS identity", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const redis = new Bun.RedisClient(requireEnvironment("REDIS_URL"));
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "AgentApiKey", "AgentMessageDelivery", "Message", "ConversationMember", "Conversation", "Agent", "WorkspaceComputer", "Computer", "WorkspaceMembership", "UserIdentity", "User", "Workspace" CASCADE',
  );
  await redis.send("FLUSHDB", []);
  await rm(workspaceRoot, { recursive: true, force: true });
  await mkdir(workspaceRoot, { recursive: true });

  await db.workspace.create({
    data: {
      id: workspaceId,
      slug: "e2e-workspace",
      name: "E2E Workspace",
      members: {
        create: {
          user: {
            create: { id: DEV_BROWSER_USER.id, username: DEV_BROWSER_USER.username },
          },
        },
      },
    },
  });

  const registration = await new ComputerRegistrar({
    workspaceAccess: new PrismaWorkspaceAccess(db),
    computers: new PrismaComputerConnectionRepository(db),
    tokenIssuer: createWorkspaceWorkerTokenIssuer(),
  }).register(
    {
      protocolMajor: 1,
      requestId: crypto.randomUUID(),
      workspaceSlug: "e2e-workspace",
      machineId: "e2e-machine",
      platform: "linux",
      osVersion: "e2e",
      computerVersion: "0.1.0",
      runtimes: [{ provider: "pi", kind: "builtin", version: "0.1.0" }],
      registrationIdempotencyKey: "e2e-registration",
    },
    { userId: DEV_BROWSER_USER.id },
  );

  const agents = new PrismaAgentRepository(db);
  expect(await verifyWorkspaceWorkerToken(registration.workspaceWorkerToken)).toEqual({
    userId: DEV_BROWSER_USER.id,
    workspaceId,
    computerId: registration.computerId,
  });
  const created = await new AgentCollection(agents, { start: async () => undefined }).create(
    { userId: DEV_BROWSER_USER.id, workspaceId },
    { name: "e2e-agent", displayName: "E2E Agent", provider: "pi" },
  );
  const keyProbe = await fetch("http://127.0.0.1:8789/api/agent-api-keys", {
    method: "POST",
    headers: {
      authorization: `Bearer ${registration.workspaceWorkerToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ agentId: created.agent.id, workspaceId }),
  });
  expect(keyProbe.status).toBe(200);
  await keyProbe.body?.cancel();
  await db.agentApiKey.deleteMany({ where: { apiKeyHash: { not: "" } } });

  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(workspaceId, registration.computerId, registration.workspaceWorkerToken);
  let runtime: DaemonRuntime | undefined;
  const proxy = startAgentProxy({
    runtime: {
      agentMessage: (...args) => runtime!.agentMessage(...args),
      issueAgentContext: (agentId, context) => runtime!.issueAgentContext(agentId, context),
    },
  });
  runtime = new DaemonRuntime(
    {
      workspaceId,
      computerId: registration.computerId,
      workspaceRoot,
      serverHttpUrl: "http://127.0.0.1:8789",
    },
    () =>
      new PiAgentAdapter({
        command: [
          process.execPath,
          join(import.meta.dir, "../../coforge-daemon/test/fixtures/agent-message-e2e-runtime.ts"),
        ],
      }),
    credentials,
    { create: () => new CentrifugoWorkspaceTransport("ws://127.0.0.1:8000/connection/websocket") },
    proxy,
  );

  try {
    await runtime.start({
      workspaceId,
      computerId: registration.computerId,
      workspaceRoot,
      serverHttpUrl: "http://127.0.0.1:8789",
    });
    await waitFor(() => runtime!.agentProcessManager.size === 1);
    const pidPath = join(workspaceRoot, workspaceId, "agents", created.agent.id, ".e2e-agent-pid");
    await waitFor(async () => Bun.file(pidPath).exists());
    expect(Number(await Bun.file(pidPath).text())).not.toBe(process.pid);
    const completionPath = join(
      workspaceRoot,
      workspaceId,
      "agents",
      created.agent.id,
      ".e2e-agent-complete.json",
    );

    const conversations = new PrismaDirectConversationRepository(db);
    const opened = await conversations.openForUser(
      workspaceId,
      DEV_BROWSER_USER.id,
      created.agent.id,
    );
    const sender = new SendDirectMessage(
      conversations,
      new RedisMessageRequestIdempotency(redis),
      createCentrifugoServerApi(),
    );
    const requestId = crypto.randomUUID();
    const input = {
      requestId,
      workspaceId,
      conversationId: opened.conversationId,
      senderMemberId: opened.senderMemberId,
      senderUserId: DEV_BROWSER_USER.id,
      body: "E2E User message",
    };
    const first = await sender.execute(input);
    const retried = await sender.execute(input);
    expect(retried.id).toBe(first.id);

    await waitFor(async () => Bun.file(completionPath).exists());
    const completion = (await Bun.file(completionPath).json()) as {
      firstMessageId: string;
      retriedMessageId: string;
    };
    expect(completion.retriedMessageId).toBe(completion.firstMessageId);
    const messages = await db.message.findMany({ orderBy: { sequence: "asc" } });
    expect(messages.map(({ body }) => body)).toEqual(["E2E User message", "E2E Agent reply"]);
    expect(await db.agentMessageDelivery.count()).toBe(1);
    expect((await db.agentMessageDelivery.findFirst())?.receivedAt).toBeInstanceOf(Date);

    const page = await fetch(`http://127.0.0.1:8789/messages/${created.agent.id}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("E2E User message");
    expect(html).toContain("E2E Agent reply");
  } finally {
    await runtime.stop();
    proxy.close();
    redis.close();
    await db.$disconnect();
  }
}, 30_000);

function requireEnvironment(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required; run scripts/e2e/run-agent-direct-message.sh`);
  return value;
}

async function waitFor(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for E2E state");
    await Bun.sleep(50);
  }
}
