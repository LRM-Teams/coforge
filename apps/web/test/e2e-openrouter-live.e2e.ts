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
import { PublishAgentRuntimeControl } from "#src/server/agents/agent-runtime-control.server";
import { RepositoryAgentAuthorization } from "#src/server/db/repositories/agent.repositories.server";
import { createAgentSessions } from "#src/server/db/repositories/agent-session.repositories.server";
import { PrismaAgentControlStore } from "#src/server/db/repositories/agent-control.repositories.server";
import { AgentControl } from "#src/server/agents/agent-control.server";
import { getAgentRuntimeLock } from "#src/server/agents/agent-runtime-lock.server";
import {
  AgentRuntimeCredentials,
  readAgentRuntimeCredentialEncryptionKey,
} from "#src/server/agents/agent-runtime-credentials.server";
import { RedisMessageRequestIdempotency } from "#src/server/conversations/redis-message-request-idempotency.server";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import {
  DaemonConnection,
  DaemonRuntime,
  InMemoryDaemonCredentialStore,
  defaultCentrifugeWorkspaceClientFactory,
  startAgentProxy,
} from "@lrm/coforge-daemon";
import { PiProvider } from "@lrm/coforge-daemon";

const dbUrl = required("DATABASE_URL");
const webOrigin = Bun.env.COFORGE_E2E_WEB_ORIGIN ?? "http://127.0.0.1:8789";
const wssOrigin = Bun.env.COFORGE_E2E_CENTRIFUGO_ORIGIN ?? "ws://127.0.0.1:8000";
const apiKey = required("OPENROUTER_API_KEY");

class DiagnosticPiProvider extends PiProvider {
  creationFailure: string | undefined;
  created = false;

  override async createAgentSession(options: Parameters<PiProvider["createAgentSession"]>[0]) {
    diagnostic("pi_session_create", {
      modelProvider: options.runtime?.modelProvider,
      model: options.runtime?.model,
      hasProviderCredential: Boolean(
        options.runtime?.providerConfig?.kind === "coforge" &&
        options.runtime.providerConfig.apiKey,
      ),
      instructionsRequireSend: options.instructions.includes("coforge message send"),
    });
    let session;
    try {
      session = await super.createAgentSession(options);
    } catch (error) {
      this.creationFailure = error instanceof Error ? error.constructor.name : typeof error;
      diagnostic("pi_session_create_failed", {
        errorType: this.creationFailure,
        modelUnavailable: error instanceof Error && error.message.startsWith("Pi model not found:"),
      });
      throw error;
    }
    this.created = true;
    diagnostic("pi_session_created", { outcome: "ok" });
    session.subscribe((event) => {
      diagnostic("pi_event", {
        type: event.type,
        ...(event.type === "tool-start" ? { tool: event.name } : {}),
        ...(event.type === "tool-end" ? { error: event.isError } : {}),
        ...(event.type === "completed" ? { status: event.status } : {}),
        ...(event.type === "tool-output" ? { text: event.text.slice(-2000) } : {}),
        ...(event.type === "text-delta" ? { textLength: event.text.length } : {}),
      });
    });
    return session;
  }
}

test("live OpenRouter Pi delivery writes an Agent reply to canonical DB", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: dbUrl }) });
  const redis = new Bun.RedisClient(required("REDIS_URL"));
  const suffix = crypto.randomUUID();
  const root = join(import.meta.dir, `../../../.amp/e2e/openrouter-${suffix}`);
  const state = `${root}-state`;
  let runtime: DaemonRuntime | undefined;
  let workspace: { id: string; slug: string } | undefined;
  let user: { id: string } | undefined;
  const proxyRequests: Array<{ method: string; path: string }> = [];
  const proxy = startAgentProxy({
    onRequest: (request) => {
      proxyRequests.push(request);
      diagnostic("proxy_request", request);
    },
    runtime: {
      agentMessage: (...args) => runtime!.agentMessage(...args),
      agentTask: (...args) => runtime!.agentTask(...args),
      agentAttachment: (...args) => runtime!.agentAttachment(...args),
      inbox: (...args) => runtime!.inbox(...args),
      workspaceInfo: (...args) => runtime!.workspaceInfo(...args),
      issueAgentContext: (agentId, context) => runtime!.issueAgentContext(agentId, context),
    },
  });
  const piProvider = new DiagnosticPiProvider();
  try {
    user = await db.user.create({ data: { username: `e2e-${suffix.slice(0, 8)}` } });
    workspace = await db.workspace.create({
      data: {
        slug: `e2e-${suffix}`,
        name: "Live OpenRouter E2E",
        members: { create: { userId: user.id, role: "owner" } },
      },
    });
    const registration = await new ComputerRegistrar({
      workspaceAccess: new PrismaWorkspaceAccess(db),
      registrations: new PrismaComputerRegistrationRepository(db),
    }).register(
      {
        protocolMajor: 1,
        requestId: crypto.randomUUID(),
        workspaceSlug: workspace.slug,
        name: `computer-${suffix}`,
        displayName: "Live E2E Computer",
        machineId: suffix,
        platform: "linux",
        osVersion: "e2e",
        computerVersion: "0.1.0",
        registrationIdempotencyKey: suffix,
      },
      { userId: user.id },
    );
    const agents = new PrismaAgentRepository(db);
    const credentialEncryption = new AgentRuntimeCredentials(
      { findOwnedAgent: async () => undefined, updateRuntimeConfig: async () => undefined },
      await readAgentRuntimeCredentialEncryptionKey(process.env),
    );
    const sessions = createAgentSessions(db);
    const centrifugo = createCentrifugoServerApi();
    const runtimeControl = new PublishAgentRuntimeControl(
      new RepositoryAgentAuthorization(agents),
      centrifugo,
      async () => undefined,
      sessions,
      new AgentControl(
        new PrismaAgentControlStore(db),
        centrifugo,
        getAgentRuntimeLock(),
        undefined,
        sessions,
      ),
    );
    const manage = new ManageAgents(
      agents,
      runtimeControl,
      { canRun: async () => true },
      { run: async (_id, callback) => callback() },
      () => credentialEncryption,
    );
    const agent = await manage.create(
      { userId: user.id, workspaceId: workspace.id, role: "owner" },
      {
        name: `openrouter-${suffix.slice(0, 8)}`,
        description: "Live OpenRouter E2E Agent",
        provider: "pi",
        computerId: registration.computerId,
        model: "deepseek/deepseek-v4.1-flash",
        modelProvider: "openrouter",
        apiKey,
        reasoning: "balanced",
      },
    );
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(workspace.id, registration.computerId, registration.daemonApiKey);
    runtime = new DaemonRuntime(
      {
        workspaceId: workspace.id,
        computerId: registration.computerId,
        workspaceRoot: root,
        serverHttpUrl: webOrigin,
      },
      () => piProvider,
      credentials,
      {
        create: () =>
          new DaemonConnection(
            `${wssOrigin}/connection/websocket`,
            defaultCentrifugeWorkspaceClientFactory,
          ),
      },
      proxy,
      {
        runtimes: async () => [{ provider: "pi", version: "live", displayName: "Pi" }],
        cachedCatalogs: async () => ({ catalogs: [], needsRefresh: false }),
        catalogs: async () => [],
      },
      state,
    );
    await mkdir(root, { recursive: true });
    await runtime.start({
      workspaceId: workspace.id,
      computerId: registration.computerId,
      workspaceRoot: root,
      serverHttpUrl: webOrigin,
    });
    // Agent creation publishes the owner-authorized agent:start intent. Let the
    // daemon's normal WSS ready/recovery path consume that intent exactly once;
    // do not call the internal start seam again from this test.
    await waitFor(async () => {
      if (piProvider.creationFailure)
        throw new Error(`Pi session creation failed: ${piProvider.creationFailure}`);
      // A newly created session is empty until the first message is sent below.
      return piProvider.created;
    }, 30_000);
    const channels = new PublicChannels(
      db,
      new RedisMessageRequestIdempotency(redis),
      createCentrifugoServerApi(),
    );
    const channel = (await channels.list(workspace.id, user.id))[0]!;
    const membership = await db.conversationMember.findUnique({
      where: { conversationId_agentId: { conversationId: channel.id, agentId: agent.agent.id } },
      select: { id: true, channelMuted: true },
    });
    expect(membership).not.toBeNull();
    expect(membership?.channelMuted).toBe(true);
    await channels.setAgentMuted(workspace.id, agent.agent.id, `#${channel.name}`, false);
    diagnostic("channel_eligibility_verified", {
      channelId: channel.id,
      agentJoined: Boolean(membership),
      muted: membership?.channelMuted ?? null,
    });
    const sent = await channels.send({
      workspaceId: workspace.id,
      userId: user.id,
      channelId: channel.id,
      requestId: crypto.randomUUID(),
      body: "Reply with exactly: live OpenRouter E2E confirmed.",
    });
    diagnostic("message_sent", { messageId: sent.id, target: channel.name });
    const initialDeliveries = await db.agentMessageDelivery.findMany({
      where: { messageId: sent.id },
      select: { deliveryId: true, agentId: true, agent: { select: { computerId: true } } },
    });
    diagnostic("delivery_records_created", {
      messageId: sent.id,
      channel: `#${channel.name}`,
      deliveryCount: initialDeliveries.length,
      deliveries: initialDeliveries.map((delivery) => ({
        deliveryId: delivery.deliveryId,
        agentId: delivery.agentId,
        hasComputerId: Boolean(delivery.agent.computerId),
      })),
    });
    await waitFor(
      async () =>
        Boolean(
          await db.agentMessageDelivery.findFirst({
            where: { messageId: sent.id, agentId: agent.agent.id, receivedAt: { not: null } },
          }),
        ),
      30_000,
      `delivery ${sent.id} for agent ${agent.agent.id}`,
    );
    const delivery = await db.agentMessageDelivery.findFirst({
      where: { messageId: sent.id, agentId: agent.agent.id },
      select: { receivedAt: true },
    });
    expect(delivery?.receivedAt).not.toBeNull();
    diagnostic("delivery_received_acknowledged", {
      received: true,
      acknowledged: Boolean(delivery?.receivedAt),
      delivery,
    });
    const reply = await waitFor(
      async () =>
        db.message.findFirst({
          where: {
            conversationId: channel.id,
            sender: { agentId: agent.agent.id },
            // Pi's public-channel send target is #channel for this root
            // message, so the canonical reply is top-level (not necessarily
            // a thread reply). The previous predicate waited on the wrong
            // relationship and hid successful Agent sends.
            createdAt: { gte: sent.createdAt },
            body: { contains: "live OpenRouter E2E confirmed" },
          },
        }),
      60_000,
    );
    diagnostic("canonical_agent_reply_persisted", {
      received: Boolean(reply),
      replyThreadRoot: reply?.threadRootId ?? null,
    });
    expect(reply?.body).toContain("live OpenRouter E2E confirmed");
    expect(
      await db.agentMessageDelivery.count({
        where: { messageId: sent.id, agentId: agent.agent.id },
      }),
    ).toBe(1);

    // Keep every Raft eligibility case on a distinct canonical message.  The
    // same live Agent session remains connected, but no assertion below can
    // be satisfied by the first message's delivery or reply.
    await channels.setAgentMuted(workspace.id, agent.agent.id, `#${channel.name}`, true);
    const muted = await channels.send({
      workspaceId: workspace.id,
      userId: user.id,
      channelId: channel.id,
      requestId: crypto.randomUUID(),
      body: "ordinary muted message: do not answer",
    });
    await waitForQuiet(
      async () =>
        (await db.agentMessageDelivery.count({ where: { messageId: muted.id } })) === 0 &&
        (await db.message.count({
          where: {
            conversationId: channel.id,
            sender: { agentId: agent.agent.id },
            createdAt: { gte: muted.createdAt },
          },
        })) === 0,
      5_000,
    );
    const mutedDelivery = await db.agentMessageDelivery.findFirst({
      where: { messageId: muted.id, agentId: agent.agent.id },
    });
    const mutedReply = await db.message.findFirst({
      where: {
        conversationId: channel.id,
        sender: { agentId: agent.agent.id },
        createdAt: { gte: muted.createdAt },
      },
    });
    expect(mutedDelivery).toBeNull();
    expect(mutedReply).toBeNull();
    diagnostic("muted_ordinary_suppressed", {
      messageId: muted.id,
      delivery: false,
      openRouterReply: false,
    });

    const mention = await channels.send({
      workspaceId: workspace.id,
      userId: user.id,
      channelId: channel.id,
      requestId: crypto.randomUUID(),
      body: `@${agent.agent.name} Reply with exactly: muted mention pierced.`,
    });
    const mentionDelivery = await waitFor(
      async () =>
        db.agentMessageDelivery.findFirst({
          where: { messageId: mention.id, agentId: agent.agent.id, receivedAt: { not: null } },
        }),
      30_000,
    );
    const mentionReply = await waitFor(
      async () =>
        db.message.findFirst({
          where: {
            conversationId: channel.id,
            sender: { agentId: agent.agent.id },
            createdAt: { gte: mention.createdAt },
            body: { contains: "muted mention pierced" },
          },
        }),
      60_000,
    );
    expect(mentionDelivery.receivedAt).not.toBeNull();
    expect(mentionReply.body).toContain("muted mention pierced");
    diagnostic("muted_mention_delivered_openrouter_replied", {
      messageId: mention.id,
      received: true,
      acknowledged: true,
      openRouterReply: mentionReply.id,
    });

    const threadRoot = await channels.send({
      workspaceId: workspace.id,
      userId: user.id,
      channelId: channel.id,
      requestId: crypto.randomUUID(),
      body: "Follow this thread. For the next ordinary reply, respond with exactly: followed thread pierced.",
    });
    await channels.setAgentThreadFollowed(
      workspace.id,
      agent.agent.id,
      `#${channel.name}:${threadRoot.id}`,
      true,
    );
    const followed = await channels.send({
      workspaceId: workspace.id,
      userId: user.id,
      channelId: channel.id,
      requestId: crypto.randomUUID(),
      threadRootId: threadRoot.id,
      body: "Reply with exactly: followed thread pierced.",
    });
    const followedDelivery = await waitFor(
      async () =>
        db.agentMessageDelivery.findFirst({
          where: { messageId: followed.id, agentId: agent.agent.id, receivedAt: { not: null } },
        }),
      30_000,
    );
    const followedReply = await waitFor(
      async () =>
        db.message.findFirst({
          where: {
            conversationId: channel.id,
            sender: { agentId: agent.agent.id },
            threadRootId: threadRoot.id,
            body: { contains: "followed thread pierced" },
          },
        }),
      60_000,
    );
    expect(followedDelivery.receivedAt).not.toBeNull();
    expect(followedReply.body).toContain("followed thread pierced");
    diagnostic("followed_thread_reply_delivered_openrouter_replied", {
      messageId: followed.id,
      received: true,
      acknowledged: true,
      openRouterReply: followedReply.id,
    });
  } finally {
    await runtime?.stop();
    proxy.close();
    if (workspace)
      await db.workspace.delete({ where: { id: workspace.id } }).catch(() => undefined);
    if (user) await db.user.delete({ where: { id: user.id } }).catch(() => undefined);
    redis.close();
    await db.$disconnect();
    await rm(root, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  }
}, 120_000);

async function waitFor<T>(
  read: () => Promise<T>,
  timeout: number,
  label = "state",
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeout;
  let last: T | undefined;
  let loggedAt = 0;
  while (Date.now() < deadline) {
    const value = (last = await read());
    if (value) return value as NonNullable<T>;
    if (Date.now() - loggedAt >= 5_000) {
      diagnostic("polling", { label, status: summarize(value) });
      loggedAt = Date.now();
    }
    await Bun.sleep(250);
  }
  diagnostic("polling_timeout", { label, status: summarize(last) });
  throw new Error(`timed out after ${timeout}ms waiting for ${label}`);
}

function summarize(value: unknown): unknown {
  if (value === undefined || value === null || typeof value === "boolean") return value;
  if (typeof value !== "object") return typeof value;
  const record = value as Record<string, unknown>;
  return {
    keys: Object.keys(record).sort(),
    ...(typeof record.id === "string" ? { id: record.id } : {}),
  };
}

async function waitForQuiet(check: () => Promise<boolean>, timeout: number): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (!(await check())) throw new Error("unexpected delivery or OpenRouter reply while muted");
    await Bun.sleep(250);
  }
}
function required(name: string): string {
  const value = Bun.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function diagnostic(event: string, fields: Record<string, unknown> = {}): void {
  console.info(JSON.stringify({ event: `live_openrouter_e2e:${event}`, ...fields }));
}
