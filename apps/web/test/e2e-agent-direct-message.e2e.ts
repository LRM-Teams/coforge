import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { encodeAgentActivity } from "@coforge/protocol";
import { PrismaClient } from "../generated/client";
import { DEV_BROWSER_USER } from "../src/server/auth/dev-skip-auth.server";
import { createDaemonTokenIssuer, verifyDaemonToken } from "../src/server/auth/daemon-token.server";
import { ComputerRegistrar } from "../src/server/computers/registration.server";
import {
  PrismaComputerConnectionRepository,
  PrismaWorkspaceAccess,
} from "../src/server/db/repositories/setup.repositories.server";
import {
  PrismaAgentRepository,
  RepositoryAgentAuthorization,
} from "../src/server/db/repositories/agent.repositories.server";
import { AgentCollection } from "../src/server/agents/agent-collection.server";
import { CloudAgentUseCase } from "../src/server/agents/cloud-agent.server";
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
    tokenIssuer: createDaemonTokenIssuer(),
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
  expect(await verifyDaemonToken(registration.daemonToken)).toEqual({
    userId: DEV_BROWSER_USER.id,
    workspaceId,
    computerId: registration.computerId,
  });
  const created = await new AgentCollection(
    agents,
    { start: async () => undefined },
    { canRun: async () => true },
  ).create(
    { userId: DEV_BROWSER_USER.id, workspaceId },
    {
      name: "e2e-agent",
      displayName: "E2E Agent",
      provider: "pi",
      computerId: registration.computerId,
      model: "e2e-model",
      modelProvider: "e2e-provider",
      reasoning: "balanced",
    },
  );
  const keyProbe = await fetch("http://127.0.0.1:8789/api/agent-api-keys", {
    method: "POST",
    headers: {
      authorization: `Bearer ${registration.daemonToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ agentId: created.agent.id, workspaceId }),
  });
  expect(keyProbe.status).toBe(200);
  await keyProbe.body?.cancel();
  await db.agentApiKey.deleteMany({ where: { apiKeyHash: { not: "" } } });

  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(workspaceId, registration.computerId, registration.daemonToken);
  let runtime: DaemonRuntime | undefined;
  const proxy = startAgentProxy({
    runtime: {
      agentMessage: (...args) => runtime!.agentMessage(...args),
      agentAttachment: (...args) => runtime!.agentAttachment(...args),
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
    const agentWorkspace = join(workspaceRoot, workspaceId, "agents", created.agent.id);
    const pidPath = join(agentWorkspace, ".e2e-agent-pid");
    const processesPath = join(agentWorkspace, ".e2e-agent-processes.json");
    const runtimeConfigPath = join(agentWorkspace, ".e2e-runtime-config.json");
    await waitFor(async () => Bun.file(pidPath).exists());
    await waitFor(async () => Bun.file(runtimeConfigPath).exists());
    expect(await Bun.file(runtimeConfigPath).json()).toEqual({
      modelProvider: "e2e-provider",
      model: "e2e-model",
      reasoning: "balanced",
    });
    expect(Number(await Bun.file(pidPath).text())).not.toBe(process.pid);
    const firstProcesses = await readProcesses(processesPath);
    expect(firstProcesses.directPid).not.toBe(process.pid);
    expect(firstProcesses.descendantPid).not.toBe(firstProcesses.directPid);
    expect(pidExists(firstProcesses.directPid)).toBe(true);
    expect(pidExists(firstProcesses.descendantPid)).toBe(true);
    const completionPath = join(
      workspaceRoot,
      workspaceId,
      "agents",
      created.agent.id,
      ".e2e-agent-complete.json",
    );
    const errorPath = join(
      workspaceRoot,
      workspaceId,
      "agents",
      created.agent.id,
      ".e2e-agent-error",
    );

    const conversations = new PrismaDirectConversationRepository(db);
    const opened = await conversations.openForUser(
      workspaceId,
      DEV_BROWSER_USER.id,
      created.agent.id,
    );
    const upload = new FormData();
    upload.set("conversationId", opened.conversationId);
    upload.set(
      "file",
      new File(["E2E attachment content"], "e2e-attachment.txt", { type: "text/plain" }),
    );
    const uploaded = await fetch("http://127.0.0.1:8789/api/attachments", {
      method: "POST",
      body: upload,
    });
    expect(uploaded.status).toBe(200);
    const attachment = (await uploaded.json()) as { id: string };
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
      attachmentId: attachment.id,
    };
    const first = await sender.execute(input);
    const retried = await sender.execute(input);
    expect(retried.id).toBe(first.id);
    const browserAttachment = await fetch(`http://127.0.0.1:8789/api/attachments/${attachment.id}`);
    expect(browserAttachment.status).toBe(200);
    expect(browserAttachment.headers.get("content-type")).toBe("application/octet-stream");
    expect(browserAttachment.headers.get("content-disposition")).toContain("attachment");
    expect(browserAttachment.headers.get("x-content-type-options")).toBe("nosniff");

    await waitFor(async () => Bun.file(completionPath).exists() || Bun.file(errorPath).exists());
    if (await Bun.file(errorPath).exists()) throw new Error(await Bun.file(errorPath).text());
    const completion = (await Bun.file(completionPath).json()) as {
      firstMessageId: string;
      retriedMessageId: string;
    };
    expect(completion.retriedMessageId).toBe(completion.firstMessageId);
    const messages = await db.message.findMany({ orderBy: { sequence: "asc" } });
    expect(messages.map(({ body }) => body)).toEqual(["E2E User message", "E2E Agent reply"]);
    expect(await db.agentMessageDelivery.count()).toBe(1);
    expect((await db.agentMessageDelivery.findFirst())?.receivedAt).toBeInstanceOf(Date);

    await waitFor(
      async () => (await db.agentActivity.count({ where: { agentId: created.agent.id } })) >= 7,
    );
    const firstLaunchActivity = await db.agentActivity.findMany({
      where: { agentId: created.agent.id },
      orderBy: { clientSeq: "asc" },
    });
    const firstLaunchId = firstLaunchActivity[0]!.launchId;
    expect(firstLaunchActivity.map(({ launchId }) => launchId)).toEqual([
      firstLaunchId,
      firstLaunchId,
      firstLaunchId,
      firstLaunchId,
      firstLaunchId,
      firstLaunchId,
      firstLaunchId,
    ]);
    expect(firstLaunchActivity.map(({ clientSeq }) => clientSeq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(firstLaunchActivity.map(({ activity }) => activity)).toEqual([
      "starting",
      "running_command",
      "reading_file",
      "writing_file",
      "editing_file",
      "using_tool",
      "turn_completed",
    ]);
    expect(firstLaunchActivity[1]!.message).toBe("printf e2e-activity");
    expect(firstLaunchActivity.slice(2, 6).map(({ message }) => message)).toEqual([
      "/workspace/e2e-read.ts",
      "/workspace/e2e-write.ts",
      "/workspace/e2e-edit.ts",
      "web_search",
    ]);
    expect(
      firstLaunchActivity.every(({ computerId }) => computerId === registration.computerId),
    ).toBe(true);

    await runtime.stopAgent(created.agent.id);
    await waitFor(
      () => !pidExists(firstProcesses.directPid) && !pidExists(firstProcesses.descendantPid),
    );
    expect(runtime.agentProcessManager.size).toBe(0);
    await rm(processesPath, { force: true });

    await new CloudAgentUseCase(
      new RepositoryAgentAuthorization(agents),
      createCentrifugoServerApi(),
      async () => undefined,
    ).start(
      {
        protocolMajor: 1,
        requestId: crypto.randomUUID(),
        workspaceId,
        agentId: created.agent.id,
        provider: "pi",
        model: "e2e-model",
        modelProvider: "e2e-provider",
        reasoning: "balanced",
      },
      DEV_BROWSER_USER.id,
    );
    await waitFor(async () => Bun.file(processesPath).exists());
    const replacementProcesses = await readProcesses(processesPath);
    expect(replacementProcesses.directPid).not.toBe(firstProcesses.directPid);
    expect(replacementProcesses.descendantPid).not.toBe(firstProcesses.descendantPid);
    expect(pidExists(replacementProcesses.directPid)).toBe(true);
    expect(pidExists(replacementProcesses.descendantPid)).toBe(true);
    await waitFor(
      async () =>
        (await db.agentActivity.count({
          where: { agentId: created.agent.id, launchId: { not: firstLaunchId } },
        })) >= 1,
    );
    const replacementActivity = await db.agentActivity.findFirstOrThrow({
      where: { agentId: created.agent.id, launchId: { not: firstLaunchId } },
      orderBy: { createdAt: "desc" },
    });
    expect(replacementActivity.clientSeq).toBe(1);
    expect(replacementActivity.activity).toBe("starting");

    const errorMessage = "E2E provider failure shown without hiding runtime configuration.";
    const errorActivity = encodeAgentActivity({
      protocolMajor: 1,
      requestId: crypto.randomUUID(),
      workspaceId,
      agentId: created.agent.id,
      activity: "error",
      level: "error",
      message: errorMessage,
      occurredAt: new Date().toISOString(),
      launchId: replacementActivity.launchId,
      clientSeq: 50,
    });
    const activityProbe = await fetch(
      "http://127.0.0.1:8789/api/internal/centrifugo-agent-activity",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-coforge-centrifugo-proxy-secret": requireEnvironment(
            "COFORGE_CENTRIFUGO_PROXY_SECRET",
          ),
        },
        body: JSON.stringify({
          user: registration.computerId,
          channel: `activity:${workspaceId}`,
          b64data: bytesToBase64(errorActivity),
          meta: { workspace_id: workspaceId, computer_id: registration.computerId },
        }),
      },
    );
    expect(activityProbe.status).toBe(200);
    await waitFor(
      async () =>
        (await db.agentActivity.count({
          where: { agentId: created.agent.id, message: errorMessage },
        })) === 1,
    );

    const page = await fetch(`http://127.0.0.1:8789/messages/${created.agent.id}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("E2E User message");
    expect(html).toContain("E2E Agent reply");

    const profile = await fetch(`http://127.0.0.1:8789/agents/${created.agent.id}?tab=profile`);
    expect(profile.status).toBe(200);
    const profileHtml = await profile.text();
    expect(profileHtml).toContain("E2E Agent");
    expect(profileHtml).toContain(registration.computerId.slice(0, 8));
    expect(profileHtml).toContain("e2e-model");
    expect(profileHtml).toContain("balanced");
    expect(profileHtml).toContain(errorMessage);

    const activityPage = await fetch(
      `http://127.0.0.1:8789/agents/${created.agent.id}?tab=activity`,
    );
    expect(activityPage.status).toBe(200);
    const activityHtml = await activityPage.text();
    expect(activityHtml).toContain(errorMessage);
    expect(activityHtml).toContain("Running command");
    expect(activityHtml).toContain("Reading file");
    expect(activityHtml).toContain("Writing file");
    expect(activityHtml).toContain("Editing file");
    expect(activityHtml).toContain("Using tool");
    expect(activityHtml).toContain("printf e2e-activity");
    expect(activityHtml).toContain("/workspace/e2e-read.ts");
    expect(activityHtml).toContain("/workspace/e2e-write.ts");
    expect(activityHtml).toContain("/workspace/e2e-edit.ts");
    expect(activityHtml).toContain("web_search");
  } finally {
    await runtime.stop();
    proxy.close();
    redis.close();
    await db.$disconnect();
  }
}, 40_000);

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

async function readProcesses(path: string) {
  await waitFor(async () => Bun.file(path).exists());
  return (await Bun.file(path).json()) as { directPid: number; descendantPid: number };
}

function pidExists(pid: number) {
  try {
    process.kill(pid, 0);
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
    }
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === "ESRCH") return false;
    throw error;
  }
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
