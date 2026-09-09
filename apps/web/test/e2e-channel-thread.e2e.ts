import { expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/client";
import { ComputerRegistrar } from "../src/server/computers/registration.server";
import { PublicChannels } from "../src/server/conversations/public-channels.server";
import { TaskBoard } from "../src/server/tasks/task-board.server";
import { PrismaAgentRepository } from "../src/server/db/repositories/agent.repositories.server";
import {
  PrismaComputerRegistrationRepository,
  PrismaWorkspaceAccess,
} from "../src/server/db/repositories/setup.repositories.server";
import { ManageAgents } from "../src/server/agents/manage-agents.server";
import { RedisMessageRequestIdempotency } from "../src/server/conversations/redis-message-request-idempotency.server";
import { createCentrifugoServerApi } from "../src/server/centrifugo/server-api.server";
import {
  DaemonConnection,
  DaemonRuntime,
  InMemoryDaemonCredentialStore,
  defaultCentrifugeWorkspaceClientFactory,
  startAgentProxy,
} from "../../../packages/daemon";
import { PiJsonlFixtureDriver } from "../../../packages/daemon/test/fixtures/pi-jsonl-fixture-driver";

const databaseUrl = requireEnvironment("DATABASE_URL");
const workspaceRoot = join(import.meta.dir, `../../../.amp/e2e/channel-${crypto.randomUUID()}`);
const daemonStateDirectory = `${workspaceRoot}-state`;

test("channel threads cross real WSS and Agent HTTP transport without notification crosstalk", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const redis = new Bun.RedisClient(requireEnvironment("REDIS_URL"));
  const suffix = crypto.randomUUID();
  const user = await db.user.create({ data: { username: `e2ect${suffix.slice(0, 8)}` } });
  const workspace = await db.workspace.create({
    data: {
      slug: `e2e-channel-${suffix}`,
      name: "E2E channel transport",
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
        displayName: "Channel E2E Computer",
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
    runtime = new DaemonRuntime(
      {
        workspaceId: workspace.id,
        computerId: registration.computerId,
        workspaceRoot,
        serverHttpUrl: "http://127.0.0.1:8789",
      },
      () =>
        new PiJsonlFixtureDriver([
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
      async () => ({
        runtimes: [{ provider: "pi", version: "fixture", displayName: "Channel fixture" }],
        catalogs: [],
      }),
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
    const other = await channels.create(workspace.id, user.id, "other");
    await db.conversationMember.createMany({
      data: [alpha.agent.id, beta.agent.id].map((agentId) => ({
        workspaceId: workspace.id,
        conversationId: other.id,
        agentId,
      })),
    });
    for (const agentId of [alpha.agent.id, beta.agent.id]) {
      await channels.setAgentMuted(workspace.id, agentId, "#general", true);
      await channels.setAgentMuted(workspace.id, agentId, "#other", true);
    }
    const root = await send(channels, workspace.id, user.id, general.id, "thread root");
    const shortTarget = `#general:${root.id.slice(0, 8)}`;
    const canonicalTarget = `#general:${root.id}`;
    await send(channels, workspace.id, user.id, general.id, "quiet before follow", root.id);

    await Bun.write(
      join(alphaRoot, ".e2e-channel-plan.json"),
      JSON.stringify({
        result: ".e2e-channel-first.json",
        operations: [
          { operation: "read", target: shortTarget },
          { operation: "send", target: shortTarget, body: "alpha transport reply" },
          { operation: "thread-unfollow", target: shortTarget },
        ],
      }),
    );
    await send(
      channels,
      workspace.id,
      user.id,
      general.id,
      `@${alpha.agent.name} inspect this thread`,
      root.id,
    );
    const first = await waitForJson(join(alphaRoot, ".e2e-channel-first.json"));
    expect(first[0]?.accepted).toBe(true);
    expect(first[0]?.messages.map((message) => message.target)).toEqual([
      canonicalTarget,
      canonicalTarget,
    ]);
    expect(first[1]).toMatchObject({ accepted: true, messageId: expect.any(String) });
    expect(first[2]?.accepted).toBe(true);
    expect(await promptCount(alphaRoot)).toBe(1);
    expect(await promptCount(betaRoot)).toBe(0);

    await send(channels, workspace.id, user.id, general.id, "ordinary after unfollow", root.id);
    await send(
      channels,
      workspace.id,
      user.id,
      general.id,
      `@${alpha.agent.name} restore follow`,
      root.id,
    );
    await waitFor(() => promptCount(alphaRoot).then((count) => count === 2));
    // This later mention is an ordering barrier: the prior unfollowed reply crossed the
    // Workspace connection without producing another provider prompt.
    expect(await promptCount(alphaRoot)).toBe(2);
    await send(
      channels,
      workspace.id,
      user.id,
      general.id,
      "followed despite parent mute",
      root.id,
    );
    await waitFor(() => promptCount(alphaRoot).then((count) => count === 3));
    expect(await promptCount(betaRoot)).toBe(0);

    await Bun.write(
      join(betaRoot, ".e2e-channel-plan.json"),
      JSON.stringify({
        result: ".e2e-channel-beta.json",
        operations: [
          {
            operation: "send",
            target: shortTarget,
            body: `@${alpha.agent.name} Agent-originated mention must stay quiet`,
          },
        ],
      }),
    );
    const otherRoot = await send(channels, workspace.id, user.id, other.id, "other root");
    await send(
      channels,
      workspace.id,
      user.id,
      other.id,
      `@${beta.agent.name} run isolated transport plan`,
      otherRoot.id,
    );
    await waitForJson(join(betaRoot, ".e2e-channel-beta.json"));
    await send(
      channels,
      workspace.id,
      user.id,
      other.id,
      `@${beta.agent.name} ordering barrier`,
      otherRoot.id,
    );
    await waitFor(() => promptCount(betaRoot).then((count) => count === 2));
    // Beta's later prompt is an ordering barrier after its Agent-originated mention.
    expect(await promptCount(alphaRoot)).toBe(3);
    expect(await promptCount(betaRoot)).toBe(2);

    const replies = await db.message.findMany({
      where: { conversationId: general.id, threadRootId: root.id },
      orderBy: { sequence: "asc" },
    });
    expect(replies.map(({ body }) => body)).toContain("alpha transport reply");
    expect(replies.at(-1)?.body).toBe(
      `@${alpha.agent.name} Agent-originated mention must stay quiet`,
    );

    const board = new TaskBoard(db);
    const created = await board.execute(
      { workspaceId: workspace.id, userId: user.id },
      {
        operation: "create",
        requestId: crypto.randomUUID(),
        conversationId: general.id,
        title: "Verify Task transport",
      },
    );
    const task = created.tasks[0]!;
    const taskTarget = `#general:${task.messageId}`;
    await Bun.write(
      join(alphaRoot, ".e2e-channel-plan.json"),
      JSON.stringify({
        result: ".e2e-task-review.json",
        cli: [
          ["message", "read", "--target", taskTarget],
          ["task", "claim", "--target", "#general", "--message-id", task.messageId.slice(0, 8)],
          ["task", "create", "--target", "#general", "--title", "Independent follow-up"],
          [
            "task",
            "update",
            "--target",
            "#general",
            "--number",
            String(task.number),
            "--status",
            "in_review",
          ],
        ],
        operations: [{ operation: "send", target: taskTarget, body: "Ready for your acceptance" }],
      }),
    );
    await send(
      channels,
      workspace.id,
      user.id,
      general.id,
      `@${alpha.agent.name} please verify this Task`,
      task.messageId,
    );
    await waitForFiles(join(alphaRoot, ".e2e-task-review.json"));
    const reviewOutputs = await Bun.file(join(alphaRoot, ".e2e-task-review.json")).json();
    expect(reviewOutputs[0]).toContain("please verify this Task");
    expect(reviewOutputs[1]).toContain("in_progress");
    expect(reviewOutputs[2]).toContain("Independent follow-up");
    expect(reviewOutputs[3]).toContain("in_review");
    expect(reviewOutputs[4]).toMatchObject({ accepted: true });

    await Bun.write(
      join(betaRoot, ".e2e-channel-plan.json"),
      JSON.stringify({
        result: ".e2e-task-conflict.json",
        cli: [["task", "claim", "--target", "#general", "--number", String(task.number)]],
        operations: [],
      }),
    );
    await send(
      channels,
      workspace.id,
      user.id,
      other.id,
      `@${beta.agent.name} check ownership`,
      otherRoot.id,
    );
    await waitForFiles(join(betaRoot, ".e2e-task-conflict.json"));
    expect((await Bun.file(join(betaRoot, ".e2e-task-conflict.json")).json())[0]).toMatchObject({
      error: "Task changed concurrently; read the Task list again before updating",
    });

    await Bun.write(
      join(alphaRoot, ".e2e-channel-plan.json"),
      JSON.stringify({
        result: ".e2e-task-done.json",
        cli: [
          ["message", "read", "--target", taskTarget],
          [
            "task",
            "update",
            "--target",
            "#general",
            "--number",
            String(task.number),
            "--status",
            "done",
          ],
        ],
        operations: [],
      }),
    );
    await send(
      channels,
      workspace.id,
      user.id,
      general.id,
      "Verified, approved. Please mark this done.",
      task.messageId,
    );
    await waitForFiles(join(alphaRoot, ".e2e-task-done.json"));
    const doneOutputs = await Bun.file(join(alphaRoot, ".e2e-task-done.json")).json();
    expect(doneOutputs[0]).toContain("Verified, approved");
    expect(doneOutputs[1]).toContain("done");
    const final = await board.execute(
      { workspaceId: workspace.id, userId: user.id },
      { operation: "list", requestId: crypto.randomUUID(), conversationId: general.id },
    );
    expect(final.tasks.map(({ status }) => status)).toEqual(["done", "todo"]);
    expect(final.tasks[0]?.owner?.kind).toBe("agent");
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
}, 30_000);

async function createAgent(
  manage: ManageAgents,
  userId: string,
  workspaceId: string,
  computerId: string,
  name: string,
) {
  return manage.create(
    { userId, workspaceId },
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
  threadRootId?: string,
) {
  return channels.send({
    workspaceId,
    userId,
    channelId,
    requestId: crypto.randomUUID(),
    body,
    threadRootId,
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

async function waitForFiles(...paths: string[]) {
  await waitFor(async () =>
    (await Promise.all(paths.map((path) => Bun.file(path).exists()))).every(Boolean),
  );
}

async function waitForJson(path: string) {
  await waitFor(async () => Bun.file(path).exists());
  return (await Bun.file(path).json()) as Array<{
    accepted: boolean;
    messageId?: string;
    messages: Array<{ target: string }>;
  }>;
}

async function waitFor(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    const error = await findRuntimeError();
    if (error) throw new Error(error);
    if (Date.now() >= deadline)
      throw new Error("timed out waiting for channel transport E2E state");
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
