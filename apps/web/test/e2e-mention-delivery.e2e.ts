import { expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { ComputerRegistrar } from "#src/server/computers/registration.server";
import { PublicChannels } from "#src/server/conversations/public-channels.server";
import { PrismaAgentRepository } from "#src/server/db/repositories/agent.repositories.server";
import {
  PrismaComputerRegistrationRepository,
  PrismaWorkspaceAccess,
} from "#src/server/db/repositories/setup.repositories.server";
import { ManageAgents } from "#src/server/agents/manage-agents.server";
import { RedisMessageRequestIdempotency } from "#src/server/conversations/redis-message-request-idempotency.server";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import {
  DaemonConnection,
  DaemonRuntime,
  InMemoryDaemonCredentialStore,
  defaultCentrifugeWorkspaceClientFactory,
  startAgentProxy,
} from "@lrm/coforge-daemon";
import { PiJsonlFixtureProvider } from "@lrm/coforge-daemon/test/fixtures/pi-jsonl-fixture-provider";

/**
 * End-to-end coverage of tracked @mention delivery (server #1236/#1270/#1274, daemon #1283): a
 * sending Agent's @mention of a running Agent carries a `MentionDeliveryEnvelope`; the daemon
 * tells its running session and, once drained, ACKs with the envelope echoed, which the server
 * records as `delivered` — reachable only through an echoed-envelope ACK
 * (`MentionDeliveryReports.settleDrained`), never through an ACK without one (`settleUnechoed`
 * settles `unknown` instead). An @mention of an Agent nothing may wake (stopped by a person) is
 * never issued an envelope at all and settles at send time to `lost`/`not_launched`
 * (`MentionDeliveryIssuer.issue`). Both outcomes are read back exactly as the sending Agent reads
 * them, through the #1274 public query (`coforge mention delivery --message <id>`), never the
 * database directly.
 *
 * The read is scoped to the messages the querying Agent itself sent
 * (`readSenderDeliveries`'s `sender: { agentId }`), so the mentioning message here is sent by an
 * Agent (alpha), not a human; alpha is itself woken by an ordinary human mention first. A personal
 * @mention of an Agent from another Agent follows the same wake rule as one from a person
 * (`channelAgentRecipients`), so this is the same tracked-delivery mechanism a human's @mention
 * would exercise.
 */
const databaseUrl = requireEnvironment("DATABASE_URL");
const workspaceRoot = join(import.meta.dir, `../../../.amp/e2e/mention-${crypto.randomUUID()}`);
const daemonStateDirectory = `${workspaceRoot}-state`;

test("a tracked @mention is delivered to a running Agent and refused for a stopped one, read back through the sender's public query", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const redis = new Bun.RedisClient(requireEnvironment("REDIS_URL"));
  const suffix = crypto.randomUUID();
  const user = await db.user.create({ data: { username: `e2emd${suffix.slice(0, 8)}` } });
  const workspace = await db.workspace.create({
    data: {
      slug: `e2e-mention-${suffix}`,
      name: "E2E mention delivery",
      members: { create: { userId: user.id } },
    },
  });
  await mkdir(workspaceRoot, { recursive: true });
  let runtime: DaemonRuntime | undefined;
  const proxy = startAgentProxy({
    runtime: {
      agentMessage: (...args) => runtime!.agentMessage(...args),
      agentTask: (...args) => runtime!.agentTask(...args),
      agentAttachment: (...args) => runtime!.agentAttachment(...args),
      inbox: (...args) => runtime!.inbox(...args),
      mentionDelivery: (...args) => runtime!.mentionDelivery(...args),
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
        workspaceSlug: workspace.slug,
        name: `e2e-${suffix}`,
        displayName: "Mention delivery E2E Computer",
        machineId: `e2e-${suffix}`,
        platform: "linux",
        osVersion: "e2e",
        computerVersion: "0.1.0",
        registrationIdempotencyKey: suffix,
      },
      { userId: user.id },
    );
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(workspace.id, registration.computerId, registration.daemonApiKey);
    const agents = new PrismaAgentRepository(db);
    const manage = new ManageAgents(
      agents,
      { start: async () => undefined, stop: async () => undefined },
      { canRun: async () => true },
      { run: async (_agentId, callback) => callback() },
    );
    const alpha = await createAgent(
      manage,
      user.id,
      workspace.id,
      registration.computerId,
      "alpha",
    );
    const beta = await createAgent(manage, user.id, workspace.id, registration.computerId, "beta");
    const gamma = await createAgent(
      manage,
      user.id,
      workspace.id,
      registration.computerId,
      "gamma",
    );
    // gamma is stopped before the daemon starts, so the server never launches it and never issues
    // it an envelope: nothing may wake it, and its mention settles at send time.
    await db.agent.update({
      where: { id: gamma.agent.id },
      data: { stoppedAt: new Date() },
    });

    runtime = new DaemonRuntime(
      {
        workspaceId: workspace.id,
        computerId: registration.computerId,
        workspaceRoot,
        serverHttpUrl: "http://127.0.0.1:8789",
      },
      () =>
        new PiJsonlFixtureProvider([
          process.execPath,
          join(import.meta.dir, "fixtures/channel-thread-e2e-runtime.ts"),
        ]),
      credentials,
      {
        create: () =>
          new DaemonConnection(
            "ws://127.0.0.1:8000/connection/websocket",
            defaultCentrifugeWorkspaceClientFactory,
          ),
      },
      proxy,
      {
        runtimes: async () => [
          { provider: "pi", version: "fixture", displayName: "Mention delivery fixture" },
        ],
        cachedCatalogs: async () => ({ catalogs: [], needsRefresh: false }),
        catalogs: async () => [],
      },
      daemonStateDirectory,
    );
    await runtime.start({
      workspaceId: workspace.id,
      computerId: registration.computerId,
      workspaceRoot,
      serverHttpUrl: "http://127.0.0.1:8789",
    });
    const alphaRoot = agentRoot(workspace.id, alpha.agent.id);
    const betaRoot = agentRoot(workspace.id, beta.agent.id);
    await waitForFiles(join(alphaRoot, ".e2e-channel-ready"), join(betaRoot, ".e2e-channel-ready"));

    const channels = new PublicChannels(
      db,
      new RedisMessageRequestIdempotency(redis),
      createCentrifugoServerApi(),
    );
    const general = (await channels.list(workspace.id, user.id))[0]!;
    for (const agentId of [alpha.agent.id, beta.agent.id, gamma.agent.id])
      await channels.setAgentMuted(workspace.id, agentId, "#general", true);

    // Alpha, once woken by a human @mention, sends the tracked mention of beta (running) and
    // gamma (stopped) itself — the message this test later reads mention-delivery outcomes for.
    await Bun.write(
      join(alphaRoot, ".e2e-channel-plan.json"),
      JSON.stringify({
        result: ".e2e-mention-first.json",
        operations: [
          {
            operation: "send",
            target: "#general",
            body: `@${beta.agent.name} please handle this @${gamma.agent.name} please handle this too`,
          },
        ],
      }),
    );
    await send(
      channels,
      workspace.id,
      user.id,
      general.id,
      `@${alpha.agent.name} please forward these mentions`,
    );
    const first = await waitForJson<[{ accepted: boolean; messageId: string }]>(
      join(alphaRoot, ".e2e-mention-first.json"),
    );
    expect(first[0]).toMatchObject({ accepted: true, messageId: expect.any(String) });
    const mentionMessageId = first[0]!.messageId;

    // Beta is running and tracked: the envelope reaches its session, and the fixture provider
    // settles the turn on its own, which drains the delivery and ACKs it with the envelope
    // echoed.
    await waitFor(() => promptCount(betaRoot).then((count) => count === 1));

    const result = await readMentionDelivery({
      channels,
      workspaceId: workspace.id,
      userId: user.id,
      channelId: general.id,
      alphaAgentName: alpha.agent.name,
      alphaRoot,
      messageId: mentionMessageId,
    });
    expect(result.messageId).toBe(mentionMessageId);
    const betaDelivery = result.deliveries.find(
      (delivery) => delivery.targetHandle === `@${beta.agent.name}`,
    );
    const gammaDelivery = result.deliveries.find(
      (delivery) => delivery.targetHandle === `@${gamma.agent.name}`,
    );
    // Reachable only through an ACK that echoes the envelope (`settleDrained`); an ACK without one
    // settles `unknown` instead, so this proves the envelope round-trip, not just any ACK.
    expect(betaDelivery).toEqual({ targetHandle: `@${beta.agent.name}`, outcome: "delivered" });
    // gamma was never launched (stopped before the daemon started), so the server never issued an
    // envelope at all: this settles synchronously at send time, not through any daemon report.
    expect(gammaDelivery).toEqual({
      targetHandle: `@${gamma.agent.name}`,
      outcome: "lost",
      reasonCategory: "not_launched",
    });

    await mkdir(join(import.meta.dir, "../../../.amp/in/artifacts"), { recursive: true });
    const artifactPath = join(
      import.meta.dir,
      `../../../.amp/in/artifacts/mention-delivery-${suffix}.json`,
    );
    await Bun.write(
      artifactPath,
      JSON.stringify({ messageId: result.messageId, deliveries: result.deliveries }, undefined, 2),
    );
    console.log(
      `Verified: tracked @mention delivered (envelope echoed) and refused (stopped, not launched). Artifact: ${artifactPath}`,
    );
  } finally {
    await runtime?.stop();
    proxy.close();
    await db.workspace.delete({ where: { id: workspace.id } }).catch(() => undefined);
    await db.user.delete({ where: { id: user.id } }).catch(() => undefined);
    await redis.send("EVAL", [
      'local keys = redis.call("KEYS", ARGV[1]); if #keys > 0 then return redis.call("DEL", unpack(keys)) end return 0',
      "0",
      `*${workspace.id}*`,
    ]);
    redis.close();
    await db.$disconnect();
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(daemonStateDirectory, { recursive: true, force: true });
  }
}, 45_000);

async function createAgent(
  manage: ManageAgents,
  userId: string,
  workspaceId: string,
  computerId: string,
  name: string,
) {
  return manage.create(
    { userId, workspaceId, role: "admin" },
    {
      name,
      description: `${name} E2E Agent`,
      provider: "pi",
      computerId,
      model: "e2e",
      modelProvider: "e2e",
      reasoning: "balanced",
    },
  );
}

function send(
  channels: PublicChannels,
  workspaceId: string,
  userId: string,
  channelId: string,
  body: string,
) {
  return channels.send({
    workspaceId,
    userId,
    channelId,
    idempotencyKey: crypto.randomUUID(),
    body,
  });
}

function agentRoot(workspaceId: string, agentId: string) {
  return join(workspaceRoot, workspaceId, "agents", agentId);
}

async function promptCount(root: string) {
  let count = 0;
  while (await Bun.file(join(root, `.e2e-channel-prompt-${count + 1}.json`)).exists()) count++;
  return count;
}

/**
 * Drives the sending Agent's own `coforge mention delivery --message <id> --json` through the
 * existing plan/CLI mechanism (`channel-thread-e2e-runtime.ts`), retrying against fresh Agent
 * turns until the tracked mention this test cares about (beta's) leaves `pending`. Never sleeps
 * without observing the read's own result.
 */
async function readMentionDelivery(params: {
  channels: PublicChannels;
  workspaceId: string;
  userId: string;
  channelId: string;
  alphaAgentName: string;
  alphaRoot: string;
  messageId: string;
}): Promise<{
  messageId: string;
  deliveries: Array<{ targetHandle: string; outcome: string; reasonCategory?: string }>;
}> {
  for (let attempt = 1; attempt <= 30; attempt++) {
    const resultFile = `.e2e-mention-check-${attempt}.json`;
    await Bun.write(
      join(params.alphaRoot, ".e2e-channel-plan.json"),
      JSON.stringify({
        result: resultFile,
        cli: [["mention", "delivery", "--message", params.messageId, "--json"]],
        operations: [],
      }),
    );
    await send(
      params.channels,
      params.workspaceId,
      params.userId,
      params.channelId,
      `@${params.alphaAgentName} check mention delivery ${attempt}`,
    );
    const [parsed] = await waitForJson<
      [
        {
          ok: true;
          messageId: string;
          deliveries: Array<{ targetHandle: string; outcome: string; reasonCategory?: string }>;
        },
      ]
    >(join(params.alphaRoot, resultFile));
    const beta = parsed!.deliveries.find((delivery) => delivery.outcome === "pending");
    if (!beta) return { messageId: parsed!.messageId, deliveries: parsed!.deliveries };
  }
  throw new Error("mention delivery did not settle to a terminal outcome in time");
}

async function waitForFiles(...paths: string[]) {
  await waitFor(async () =>
    (await Promise.all(paths.map((path) => Bun.file(path).exists()))).every(Boolean),
  );
}

async function waitForJson<T>(path: string): Promise<T> {
  await waitFor(async () => Bun.file(path).exists());
  return (await Bun.file(path).json()) as T;
}

async function waitFor(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 20_000;
  while (!(await check())) {
    const error = await findRuntimeError();
    if (error) throw new Error(error);
    if (Date.now() >= deadline) throw new Error("timed out waiting for mention delivery E2E state");
    await Bun.sleep(50);
  }
}

async function findRuntimeError() {
  const glob = new Bun.Glob("**/.e2e-channel-error");
  for await (const path of glob.scan(workspaceRoot))
    return Bun.file(join(workspaceRoot, path)).text();
}

function requireEnvironment(name: string) {
  const value = Bun.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
