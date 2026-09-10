// Opt-in after the managed E2E setup; requires authenticated kiro-cli and consumes usage.
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/client";
import { DEV_BROWSER_USER } from "../src/server/auth/dev-skip-auth.server";
import { ComputerRegistrar } from "../src/server/computers/registration.server";
import {
  PrismaComputerRegistrationRepository,
  PrismaWorkspaceAccess,
} from "../src/server/db/repositories/setup.repositories.server";
import { PrismaAgentRepository } from "../src/server/db/repositories/agent.repositories.server";
import { ManageAgents } from "../src/server/agents/manage-agents.server";
import { PrismaDirectConversationRepository } from "../src/server/db/repositories/direct-conversation.repositories.server";
import { SendDirectMessage } from "../src/server/conversations/direct-message.server";
import { RedisMessageRequestIdempotency } from "../src/server/conversations/redis-message-request-idempotency.server";
import {
  createCentrifugoServerApi,
  createUsageScan,
} from "../src/server/centrifugo/server-api.server";
import { RedisUsageCache } from "../src/server/centrifugo/usage-cache.server";
import {
  DaemonConnection,
  DaemonRuntime,
  InMemoryDaemonCredentialStore,
  defaultCentrifugeWorkspaceClientFactory,
  startAgentProxy,
} from "../../../packages/daemon";
import { createAgentDriver } from "../../../packages/daemon/src/code-agent/registry";

test("real Kiro v3 reads and replies through Web, Centrifugo and Daemon", async () => {
  const databaseUrl = process.env.DATABASE_URL;
  if (
    !databaseUrl ||
    new URL(databaseUrl).hostname !== "127.0.0.1" ||
    process.env.COFORGE_E2E_ALLOW_RESET !== "1"
  )
    throw new Error("Requires disposable managed local E2E environment");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const redis = new Bun.RedisClient(process.env.REDIS_URL!);
  const root = await mkdtemp(join(tmpdir(), "coforge-kiro-e2e-"));
  const workspaceId = "10000000-0000-4000-8000-000000000001";
  let runtime: DaemonRuntime | undefined;
  let launchError: unknown;
  const proxy = startAgentProxy({
    runtime: {
      agentMessage: (...args) => runtime!.agentMessage(...args),
      agentAttachment: (...args) => runtime!.agentAttachment(...args),
      inbox: (...args) => runtime!.inbox(...args),
      issueAgentContext: (agentId, context) => runtime!.issueAgentContext(agentId, context),
    },
  });
  try {
    const registration = await new ComputerRegistrar({
      workspaceAccess: new PrismaWorkspaceAccess(db),
      registrations: new PrismaComputerRegistrationRepository(db),
    }).register(
      {
        protocolMajor: 1,
        requestId: crypto.randomUUID(),
        workspaceSlug: "e2e-workspace",
        name: `kiro-${crypto.randomUUID().slice(0, 8)}`,
        displayName: "Kiro native E2E",
        machineId: crypto.randomUUID(),
        platform: "linux",
        osVersion: "e2e",
        computerVersion: "0.1.0",
        registrationIdempotencyKey: crypto.randomUUID(),
      },
      { userId: DEV_BROWSER_USER.id },
    );
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(workspaceId, registration.computerId, registration.daemonApiKey);
    const created = await new ManageAgents(
      new PrismaAgentRepository(db),
      { start: async () => undefined, stop: async () => undefined },
      { canRun: async () => true },
      { run: async (_id, callback) => callback() },
    ).create(
      { userId: DEV_BROWSER_USER.id, workspaceId },
      {
        name: `kiro-e2e-${crypto.randomUUID().slice(0, 8)}`,
        description: "Native Kiro end-to-end verification",
        provider: "kiro",
        computerId: registration.computerId,
        model: "auto",
        modelProvider: "",
        reasoning: "",
      },
    );
    const config = {
      workspaceId,
      computerId: registration.computerId,
      workspaceRoot: root,
      serverHttpUrl: "http://127.0.0.1:8789",
    };
    runtime = new DaemonRuntime(
      config,
      (provider) => {
        const driver = createAgentDriver(provider);
        return {
          provider,
          readUsage: driver.readUsage?.bind(driver),
          createAgentSession: async (options) => {
            try {
              return await driver.createAgentSession(options);
            } catch (error) {
              console.error("Kiro E2E launch selection", {
                model: options.runtime?.model,
                reasoning: options.runtime?.reasoning,
              });
              launchError = error;
              throw error;
            }
          },
        };
      },
      credentials,
      {
        create: () =>
          new DaemonConnection(
            "ws://127.0.0.1:8000/connection/websocket",
            defaultCentrifugeWorkspaceClientFactory,
          ),
      },
      proxy,
      async () => ({
        runtimes: [{ provider: "kiro", version: "2.21.2", displayName: "Kiro v3" }],
        catalogs: [],
      }),
      join(root, "state"),
    );
    await runtime.start(config);
    await until(() => {
      if (launchError) throw launchError;
      return runtime!.agentProcessManager.size === 1;
    });
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
    const marker = `KIRO-E2E-${crypto.randomUUID()}`;
    const sent = await sender.execute({
      requestId: crypto.randomUUID(),
      workspaceId,
      conversationId: opened.conversationId,
      senderMemberId: opened.senderMemberId,
      senderUserId: DEV_BROWSER_USER.id,
      body: `This is an end-to-end test. Read this message with the CoForge CLI and send a reply to this same conversation using coforge message send. Reply body must be exactly ${marker}. Do not merely print the reply in your terminal.`,
    });
    await until(
      async () =>
        !!(await db.message.findFirst({
          where: {
            conversationId: opened.conversationId,
            senderMemberId: { not: opened.senderMemberId },
          },
        })),
    );
    const messages = await db.message.findMany({
      where: { conversationId: opened.conversationId },
      orderBy: { sequence: "asc" },
    });
    expect(messages.map((message) => message.body.trimEnd())).toEqual([sent.body, marker]);
    expect(messages[1]!.senderMemberId).not.toBe(opened.senderMemberId);
    await until(
      async () =>
        !!(await db.agentMessageDelivery.findFirst({
          where: { agentId: created.agent.id, receivedAt: { not: null } },
        })),
    );
    const page = await fetch(`http://127.0.0.1:8789/messages/${created.agent.id}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain(marker);
    const usageKey = {
      workspaceId,
      computerId: registration.computerId,
      provider: "kiro" as const,
    };
    const usageCache = new RedisUsageCache(redis);
    const scanId = await createUsageScan(createCentrifugoServerApi(), usageKey, usageCache);
    await until(async () => {
      const record = await usageCache.get(usageKey);
      return record?.scanId === scanId && record.status !== "pending";
    });
    const usage = await usageCache.get(usageKey);
    expect(usage?.status).toBe("available");
    expect(usage?.snapshot?.provider).toBe("kiro");
    expect(usage?.snapshot?.primary?.usedPercent).toBeGreaterThanOrEqual(0);
    expect(usage?.snapshot?.primary?.usedPercent).toBeLessThanOrEqual(100);
    expect(usage?.snapshot?.creditUsage?.used).toBeGreaterThanOrEqual(0);
    expect(usage?.snapshot?.creditUsage?.limit).toBeGreaterThan(0);
    expect(usage?.snapshot?.creditUsage?.overage).toBeGreaterThanOrEqual(0);
    expect(Date.parse(usage!.snapshot!.primary!.resetsAt)).toBeGreaterThan(Date.now());
    console.log(
      `Verified native Kiro reply, delivery ACK and account usage scan; review /messages/${created.agent.id}`,
    );
  } finally {
    await runtime?.stop();
    proxy.close();
    redis.close();
    await db.$disconnect();
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 90_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Native Kiro E2E state did not arrive");
    await Bun.sleep(100);
  }
}
