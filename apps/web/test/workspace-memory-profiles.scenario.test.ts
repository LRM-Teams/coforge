/**
 * F5 deterministic Workspace Memory Profile scenarios.
 * Fake/synthetic OpenViking seams; no real runtime.
 * PostgreSQL is required; skipIf is explicit when no connection string is set.
 */
import { expect, test } from "bun:test";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import {
  OPENVIKING_AGENT_PROTOCOL,
  OPENVIKING_CITATION_KIND,
  OPENVIKING_TOOL_NAMES,
  toolsForMemoryFence,
  workspaceProfileToToolFence,
} from "@lrm/coforge-sdk/agent";
import { PrismaOpenVikingBindingStore } from "../src/server/db/repositories/openviking-binding.repositories.server";
import { PrismaWorkspaceMemoryAdmissionStore } from "../src/server/db/repositories/workspace-memory-admission.repositories.server";
import { PrismaWorkspaceMemoryCitationStore } from "../src/server/db/repositories/workspace-memory-citation.repositories.server";
import { PrismaWorkspaceMemoryCleanupStore } from "../src/server/db/repositories/workspace-memory-cleanup.repositories.server";
import { PrismaWorkspaceMemoryProfileStore } from "../src/server/db/repositories/workspace-memory-profile.repositories.server";
import { createMemoryCitationBindings } from "../src/server/workspace-memory/memory-citations";
import { createMemoryAgentBudgetLedger } from "../src/server/workspace-memory/memory-agent-budget";
import { createMemoryOffers } from "../src/server/workspace-memory/memory-offers";
import { createOpenVikingMemoryReads } from "../src/server/openviking/openviking-memory-reads";
import { createMemoryAgentCommands } from "../src/server/workspace-memory/memory-agent-route";
import type { CoforgeMemoryActor } from "../src/server/openviking/contract";
import { createOpenVikingPolicyGateway } from "../src/server/openviking/policy-gateway.server";
import { createOpenVikingRuntimeClient } from "../src/server/openviking/runtime-client.server";
import { sanitizeOpenVikingTransportFailure } from "../src/server/openviking/route-policy";
import { detectAdmittedPublicChannelSegments } from "../src/server/workspace-memory/detect-segments";
import {
  createAdmissionDispatcher,
  type AdmissionSink,
  type AdmissionSinkDelivery,
} from "../src/server/workspace-memory/dispatch";
import { createWorkspaceMemoryProfiles } from "../src/server/workspace-memory/profiles";
import {
  createFakeMemoryRuntimeProvisioner,
  createWorkspaceMemoryProfileReconciler,
} from "../src/server/workspace-memory/reconciler";
import { createWorkspaceMemorySwitching } from "../src/server/workspace-memory/switching";
import {
  createFakeWorkspaceMemoryCleanupRemotes,
  createWorkspaceMemoryCleanup,
} from "../src/server/workspace-memory/cleanup.server";
import {
  WORKSPACE_MEMORY_PG_URL,
  applyWorkspaceMemoryPgStub,
  warnIfWorkspaceMemoryPgSkipped,
} from "./helpers/workspace-memory-pg";

const connectionString = WORKSPACE_MEMORY_PG_URL;
warnIfWorkspaceMemoryPgSkipped("workspace-memory profile scenarios");

const now = new Date("2026-09-21T12:00:00.000Z");
const later = new Date("2026-09-21T13:00:00.000Z");
const afterOff = new Date("2026-09-21T14:00:00.000Z");
const enabled = { prototypeEnabled: true };
const SERVER_AUTHORIZATION = "Bearer server-held-ov-key";
const ATTACKER_AUTHORIZATION = "Bearer attacker-key";

const OWNER: CoforgeMemoryActor = { kind: "owner", userId: "u-1" };
const MEMBER: CoforgeMemoryActor = { kind: "member", userId: "u-3" };
const MEMORY_AGENT: CoforgeMemoryActor = { kind: "memory_agent", agentId: "mem-1" };
const PROJECTION_WORKER: CoforgeMemoryActor = { kind: "projection_worker" };

const FIND = {
  method: "POST",
  path: "/api/v1/search/find",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ query: "standup", limit: 10 }),
};
const RESOURCES_WRITE = {
  method: "POST",
  path: "/api/v1/resources",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ path: "notes/alpha.md", content: "hello" }),
};
const SMUGGLED_HEADERS = {
  Authorization: ATTACKER_AUTHORIZATION,
  "X-API-Key": "stolen-key",
  "X-OpenViking-Account": "acct-evil",
  "X-OpenViking-User": "root",
  "X-OpenViking-Role": "root",
  "X-OpenViking-Actor-Peer": "peer-user",
  "Content-Type": "application/json",
};

type Harness = {
  db: PrismaClient;
  client: import("pg").PoolClient;
  workspaceA: string;
  workspaceB: string;
  profiles: PrismaWorkspaceMemoryProfileStore;
  bindings: PrismaOpenVikingBindingStore;
  admission: PrismaWorkspaceMemoryAdmissionStore;
  citations: PrismaWorkspaceMemoryCitationStore;
  cleanupStore: PrismaWorkspaceMemoryCleanupStore;
  provisioner: ReturnType<typeof createFakeMemoryRuntimeProvisioner>;
  persistedMessages: string[];
};

async function openHarness(): Promise<Harness & { dispose: () => Promise<void> }> {
  const pool = new Pool({ connectionString });
  const schema = `wmp_scen_${crypto.randomUUID().replaceAll("-", "")}`;
  const client = await pool.connect();
  await client.query(`CREATE SCHEMA "${schema}"`);
  await client.query(`SET search_path TO "${schema}"`);
  const workspaceA = crypto.randomUUID();
  const workspaceB = crypto.randomUUID();
  await applyWorkspaceMemoryPgStub(client, { workspaceIds: [workspaceA, workspaceB] });
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }, { schema }) });
  return {
    db,
    client,
    workspaceA,
    workspaceB,
    profiles: new PrismaWorkspaceMemoryProfileStore(db),
    bindings: new PrismaOpenVikingBindingStore(db),
    admission: new PrismaWorkspaceMemoryAdmissionStore(db),
    citations: new PrismaWorkspaceMemoryCitationStore(db),
    cleanupStore: new PrismaWorkspaceMemoryCleanupStore(db),
    provisioner: createFakeMemoryRuntimeProvisioner(),
    persistedMessages: [],
    async dispose() {
      await db.$disconnect();
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      client.release();
      await pool.end();
    },
  };
}

async function unwrap<T extends { ok: boolean }>(result: T): Promise<Extract<T, { ok: true }>> {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("expected ok result");
  return result as Extract<T, { ok: true }>;
}

function recordingSink() {
  const deliveries: AdmissionSinkDelivery[] = [];
  const sink: AdmissionSink = {
    async deliver(input) {
      deliveries.push(input);
      return { outcome: "delivered" };
    },
  };
  return { sink, deliveries };
}

function liveDetected(workspaceId: string, closedAt: Date, messageId: string) {
  return detectAdmittedPublicChannelSegments({
    conversations: [{ id: "ch-eng", workspaceId, channelName: "eng" }],
    messages: [
      {
        id: messageId,
        conversationId: "ch-eng",
        workspaceId,
        sequence: 1,
        createdAt: closedAt,
        body: "standup",
        senderKind: "human",
        senderHandle: "ada",
      },
    ],
    tasks: [],
    admittedMessageIds: new Set(),
    now: new Date(closedAt.getTime() + 25 * 60 * 1000),
    quietAfterMs: 15 * 60 * 1000,
  })[0]!;
}

function persistMessage(harness: Harness, body: string) {
  harness.persistedMessages.push(body);
  return { messageId: `local-${harness.persistedMessages.length}` };
}

function createSwitching(harness: Harness, sinks: { openviking: AdmissionSink }) {
  const profileApi = createWorkspaceMemoryProfiles({
    store: harness.profiles,
    gate: enabled,
  });
  const inner = createWorkspaceMemoryProfileReconciler({
    store: harness.profiles,
    provisioner: harness.provisioner,
  });
  const reconciler = {
    async reconcile(workspaceId: string) {
      const result = await inner.reconcile(workspaceId);
      if (result.ok) {
        const snap = harness.provisioner.snapshot(workspaceId);
        if (snap.openviking) {
          const current = await harness.bindings.get(workspaceId);
          await harness.bindings.compareAndSet({
            workspaceId,
            expectedGeneration: current?.generation ?? 0,
            binding: {
              workspaceId,
              accountId: snap.openviking.resourceId,
              serviceIdentityId: `svc-projection-${workspaceId}`,
              credentialRef: `secret:ov-${workspaceId}`,
              generation: snap.openviking.generation,
            },
          });
        }
      }
      return result;
    },
  };
  return createWorkspaceMemorySwitching({
    profiles: profileApi,
    reconciler,
    dispatcher: createAdmissionDispatcher({
      admission: harness.admission,
      sinks,
    }),
    getBinding: (workspaceId) => harness.bindings.get(workspaceId),
    snapshotRuntimes: (workspaceId) => harness.provisioner.snapshot(workspaceId),
  });
}

function headersFrom(init: RequestInit | undefined): Record<string, string> {
  const headers = new Headers(init?.headers);
  const out: Record<string, string> = {};
  headers.forEach((value, name) => {
    out[name.toLowerCase()] = value;
  });
  return out;
}

function jsonStream(body: unknown, extraHeaders: Record<string, string> = {}) {
  return {
    ok: true as const,
    response: {
      status: 200,
      headers: { "content-type": "application/json", ...extraHeaders },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(JSON.stringify(body)));
          controller.close();
        },
      }),
    },
  };
}

test.skipIf(!connectionString)(
  "1. authorized OpenViking read/write through the gateway strips identity headers and isolates workspaces",
  async () => {
    const harness = await openHarness();
    try {
      const openviking = recordingSink();
      const switching = createSwitching(harness, { openviking: openviking.sink });
      await unwrap(
        await switching.selectDesired({
          workspaceId: harness.workspaceA,
          desired: "openviking",
          at: now,
        }),
      );
      await unwrap(await switching.reconcile(harness.workspaceA));

      let captured: { url: string; headers: Record<string, string>; body: string } | undefined;
      const gateway = createOpenVikingPolicyGateway({
        profiles: harness.profiles,
        bindings: harness.bindings,
        runtime: createOpenVikingRuntimeClient({
          baseUrl: "http://ov.internal:1933",
          fetchImpl: async (input, init) => {
            captured = {
              url: String(input),
              headers: headersFrom(init),
              body: String(init?.body ?? ""),
            };
            return Response.json({ results: [{ uri: "viking://resources/doc.md" }] });
          },
        }),
        resolveAuthorization: async () => SERVER_AUTHORIZATION,
      });

      const matrix: Array<{ actor: CoforgeMemoryActor; find: boolean; write: boolean }> = [
        { actor: OWNER, find: true, write: true },
        { actor: MEMBER, find: true, write: true },
        { actor: MEMORY_AGENT, find: true, write: false },
        { actor: PROJECTION_WORKER, find: false, write: false },
      ];
      const recordingCalls: string[] = [];
      const matrixGateway = createOpenVikingPolicyGateway({
        profiles: harness.profiles,
        bindings: harness.bindings,
        runtime: {
          async request(input) {
            recordingCalls.push(`${input.method} ${input.path}`);
            return jsonStream({ results: [] });
          },
        },
        resolveAuthorization: async () => SERVER_AUTHORIZATION,
      });
      for (const row of matrix) {
        const find = await matrixGateway.forward(row.actor, {
          ...FIND,
          workspaceId: harness.workspaceA,
        });
        expect(find.ok).toBe(row.find);
        const write = await matrixGateway.forward(row.actor, {
          ...RESOURCES_WRITE,
          workspaceId: harness.workspaceA,
        });
        expect(write.ok).toBe(row.write);
        if (!row.write && !write.ok) expect(write.failure.code).toBe("capability_denied");
      }

      const stripped = await gateway.forward(MEMBER, {
        ...FIND,
        workspaceId: harness.workspaceA,
        headers: SMUGGLED_HEADERS,
      });
      expect(stripped.ok).toBe(true);
      expect(captured?.url).toBe("http://ov.internal:1933/api/v1/search/find");
      expect(captured?.headers.authorization).toBe(SERVER_AUTHORIZATION);
      expect(captured?.headers.authorization).not.toBe(ATTACKER_AUTHORIZATION);
      expect(captured?.headers["x-openviking-account"]).toBe(`acct-${harness.workspaceA}`);
      expect(captured?.headers["x-openviking-user"]).toBe("user:u-3");
      expect(captured?.headers["x-openviking-user"]).not.toBe("root");
      if (stripped.ok) {
        expect(JSON.stringify(stripped.response.headers)).not.toContain(SERVER_AUTHORIZATION);
      }

      const isolated = await gateway.forward(OWNER, {
        ...FIND,
        workspaceId: harness.workspaceB,
      });
      expect(isolated.ok).toBe(false);
      if (!isolated.ok) expect(isolated.failure.code).toBe("workspace_not_ready");
      expect(await harness.bindings.get(harness.workspaceB)).toBeNull();
      expect(JSON.stringify({ stripped, isolated })).not.toContain(SERVER_AUTHORIZATION);
      expect(JSON.stringify({ stripped, isolated })).not.toContain(ATTACKER_AUTHORIZATION);
    } finally {
      await harness.dispose();
    }
  },
);

test.skipIf(!connectionString)(
  "2. profile activation does not backfill history; each era stays behind its own activation cursor",
  async () => {
    const harness = await openHarness();
    try {
      const openviking = recordingSink();
      const switching = createSwitching(harness, { openviking: openviking.sink });
      const historical = liveDetected(
        harness.workspaceA,
        new Date("2026-09-21T11:00:00.000Z"),
        "m-old",
      );
      const ovLive = liveDetected(harness.workspaceA, new Date("2026-09-21T12:05:00.000Z"), "m-ov");
      const laterLive = liveDetected(
        harness.workspaceA,
        new Date("2026-09-21T13:05:00.000Z"),
        "m-cm",
      );

      await unwrap(
        await switching.selectDesired({
          workspaceId: harness.workspaceA,
          desired: "openviking",
          at: now,
        }),
      );
      await unwrap(await switching.reconcile(harness.workspaceA));
      expect(
        await switching.dispatch({ workspaceId: harness.workspaceA, detected: historical }),
      ).toMatchObject({ outcome: { outcome: "skipped", reason: "before_activation_cursor" } });
      expect(
        await switching.dispatch({ workspaceId: harness.workspaceA, detected: ovLive }),
      ).toMatchObject({ outcome: { outcome: "dispatched", sinkProfile: "openviking" } });

      await unwrap(
        await switching.selectDesired({
          workspaceId: harness.workspaceA,
          desired: "off",
          at: later,
        }),
      );
      await unwrap(await switching.reconcile(harness.workspaceA));
      await unwrap(
        await switching.selectDesired({
          workspaceId: harness.workspaceA,
          desired: "openviking",
          at: later,
          afterMessageId: "msg-100",
        }),
      );
      await unwrap(await switching.reconcile(harness.workspaceA));
      expect(
        await switching.dispatch({ workspaceId: harness.workspaceA, detected: historical }),
      ).toMatchObject({ outcome: { outcome: "skipped", reason: "before_activation_cursor" } });
      expect(
        await switching.dispatch({ workspaceId: harness.workspaceA, detected: ovLive }),
      ).toMatchObject({ outcome: { outcome: "skipped", reason: "before_activation_cursor" } });
      expect(
        await switching.dispatch({ workspaceId: harness.workspaceA, detected: laterLive }),
      ).toMatchObject({ outcome: { outcome: "dispatched", sinkProfile: "openviking" } });
      expect(openviking.deliveries.map((row) => row.segment.sourceMessageIds)).toEqual([
        ["m-ov"],
        ["m-cm"],
      ]);
    } finally {
      await harness.dispose();
    }
  },
);

test.skipIf(!connectionString)(
  "3. the PublicChannel detector excludes DirectConversation and dispatch stays workspace-isolated",
  async () => {
    const harness = await openHarness();
    try {
      const openviking = recordingSink();
      const switching = createSwitching(harness, { openviking: openviking.sink });
      const input = {
        conversations: [
          { id: "ch-eng", workspaceId: harness.workspaceA, channelName: "eng" },
          { id: "dm-1", workspaceId: harness.workspaceA, channelName: null },
        ],
        messages: [
          {
            id: "m-pub",
            conversationId: "ch-eng",
            workspaceId: harness.workspaceA,
            sequence: 1,
            createdAt: new Date("2026-09-21T12:05:00.000Z"),
            body: "channel note",
            senderKind: "human" as const,
            senderHandle: "ada",
          },
          {
            id: "m-dm",
            conversationId: "dm-1",
            workspaceId: harness.workspaceA,
            sequence: 1,
            createdAt: new Date("2026-09-21T12:05:00.000Z"),
            body: "private",
            senderKind: "human" as const,
            senderHandle: "ada",
          },
        ],
        tasks: [
          {
            messageId: "m-dm",
            conversationId: "dm-1",
            workspaceId: harness.workspaceA,
            status: "done",
            updatedAt: new Date("2026-09-21T12:06:00.000Z"),
          },
        ],
        admittedMessageIds: new Set<string>(),
        now: new Date("2026-09-21T12:30:00.000Z"),
        quietAfterMs: 15 * 60 * 1000,
      };
      const detected = detectAdmittedPublicChannelSegments(input);
      expect(detected).toHaveLength(1);
      expect(detected[0]?.sourceMessageIds).toEqual(["m-pub"]);
      expect(detected[0]?.conversationKind).toBe("public_channel");

      await unwrap(
        await switching.selectDesired({
          workspaceId: harness.workspaceA,
          desired: "openviking",
          at: now,
        }),
      );
      await unwrap(await switching.reconcile(harness.workspaceA));
      expect(
        await switching.dispatch({
          workspaceId: harness.workspaceA,
          detected: detected[0]!,
        }),
      ).toMatchObject({ outcome: { outcome: "dispatched", sinkProfile: "openviking" } });
      expect(openviking.deliveries).toHaveLength(1);

      await unwrap(
        await switching.selectDesired({
          workspaceId: harness.workspaceB,
          desired: "openviking",
          at: now,
        }),
      );
      await unwrap(await switching.reconcile(harness.workspaceB));
      const isolated = detectAdmittedPublicChannelSegments({
        ...input,
        conversations: [{ id: "ch-eng", workspaceId: harness.workspaceB, channelName: "eng" }],
        messages: input.messages.map((message) => ({
          ...message,
          workspaceId: harness.workspaceB,
        })),
        tasks: [],
      });
      expect(
        await switching.dispatch({ workspaceId: harness.workspaceB, detected: isolated[0]! }),
      ).toMatchObject({
        outcome: { outcome: "dispatched", sinkProfile: "openviking" },
      });
      expect(openviking.deliveries.map((row) => row.segment.workspace.workspaceId)).toEqual([
        harness.workspaceA,
        harness.workspaceB,
      ]);
    } finally {
      await harness.dispose();
    }
  },
);

test.skipIf(!connectionString)(
  "4. OpenViking outage degrades the gateway without blocking ordinary messages",
  async () => {
    const harness = await openHarness();
    try {
      const openviking = recordingSink();
      const switching = createSwitching(harness, { openviking: openviking.sink });
      await unwrap(
        await switching.selectDesired({
          workspaceId: harness.workspaceA,
          desired: "openviking",
          at: now,
        }),
      );
      await unwrap(await switching.reconcile(harness.workspaceA));

      const gateway = createOpenVikingPolicyGateway({
        profiles: harness.profiles,
        bindings: harness.bindings,
        runtime: {
          async request() {
            return {
              ok: false as const,
              failure: sanitizeOpenVikingTransportFailure("runtime_unavailable"),
            };
          },
        },
        resolveAuthorization: async () => SERVER_AUTHORIZATION,
      });
      const outage = await gateway.forward(OWNER, {
        ...FIND,
        workspaceId: harness.workspaceA,
      });
      expect(outage.ok).toBe(false);
      if (!outage.ok) expect(outage.failure.code).toBe("runtime_unavailable");

      persistMessage(harness, "ordinary standup still lands");
      expect(harness.persistedMessages).toEqual(["ordinary standup still lands"]);

      harness.provisioner.setHealth("degraded");
      const degraded = await unwrap(await switching.reconcile(harness.workspaceA));
      expect(degraded.observation.observed).toBe("degraded");
      expect(degraded.observation.surfaces.admission.open).toBe(true);
      expect(degraded.observation.surfaces.openvikingGateway.open).toBe(false);
      expect(
        await switching.dispatch({
          workspaceId: harness.workspaceA,
          detected: liveDetected(
            harness.workspaceA,
            new Date("2026-09-21T12:05:00.000Z"),
            "m-degraded",
          ),
        }),
      ).toMatchObject({
        outcome: { outcome: "dispatched", sinkProfile: "openviking" },
      });
    } finally {
      await harness.dispose();
    }
  },
);

function memoryAgentCommands() {
  const ovRows = new Map<string, { workspaceId: string; citationId: string }>();
  const offerRows = new Map<string, { citations: Array<{ kind: string; citationId: string }> }>();
  const citations = createMemoryCitationBindings({
    openviking: {
      async putOpenVikingCitation(record) {
        ovRows.set(`${record.workspaceId}:${record.citationId}`, record);
        return record;
      },
      async getOpenVikingCitation(workspaceId, citationId) {
        const row = ovRows.get(`${workspaceId}:${citationId}`);
        return row
          ? {
              workspaceId,
              citationId,
              accountId: "acct-a",
              uri: "viking://resources/docs/deploy.md",
              contentHash: "sha256:abc",
              matchedLevel: "L2",
              excerpt: "skipped tests",
              boundOperationId: "find-1",
            }
          : null;
      },
    },
  });
  const handler = createMemoryAgentCommands({
    fence: {
      async resolve() {
        return workspaceProfileToToolFence("openviking");
      },
    },
    directory: {
      async isDesignated() {
        return true;
      },
    },
    budgets: createMemoryAgentBudgetLedger(),
    citations,
    offers: createMemoryOffers({
      citations,
      offers: {
        async getOffer(workspaceId, operationId) {
          return (offerRows.get(`${workspaceId}:${operationId}`) as never) ?? null;
        },
        async putOffer(input) {
          offerRows.set(`${input.workspaceId}:${input.operationId}`, input);
          return { outcome: "saved" as const, offer: input };
        },
      },
      publisher: {
        async publish() {
          return { messageId: "offer-msg" };
        },
      },
      channels: {
        async isActiveChannelAgent() {
          return true;
        },
      },
    }),
    openviking: createOpenVikingMemoryReads({
      client: {
        async invoke() {
          return {
            results: [
              {
                uri: "viking://resources/docs/deploy.md",
                accountId: "acct-a",
                contentHash: "sha256:abc",
                matchedLevel: "L2",
                excerpt: "skipped tests",
              },
            ],
          };
        },
      },
      citations,
    }),
  });
  return { handler, offerRows };
}

test.skipIf(!connectionString)(
  "5. the Memory Agent fence allows three OpenViking reads per trigger and rejects foreign protocols",
  async () => {
    const harness = await openHarness();
    try {
      expect(workspaceProfileToToolFence("openviking")).toBeDefined();
      expect(toolsForMemoryFence(workspaceProfileToToolFence("openviking")!)).toEqual([
        OPENVIKING_TOOL_NAMES.find,
        OPENVIKING_TOOL_NAMES.searchContext,
        OPENVIKING_TOOL_NAMES.read,
        OPENVIKING_TOOL_NAMES.offer,
      ]);
      expect(workspaceProfileToToolFence("off")).toBeUndefined();

      const ov = memoryAgentCommands();
      for (const index of [1, 2, 3]) {
        const read = await ov.handler.handle({
          workspaceId: harness.workspaceA,
          agentId: "mem-1",
          triggerMessageId: "msg-ov",
          command: {
            protocol: OPENVIKING_AGENT_PROTOCOL,
            op: "find",
            operationId: `find-${index}`,
            query: "deploy",
          },
        });
        expect(read.ok).toBe(true);
      }
      const fourth = await ov.handler.handle({
        workspaceId: harness.workspaceA,
        agentId: "mem-1",
        triggerMessageId: "msg-ov",
        command: {
          protocol: OPENVIKING_AGENT_PROTOCOL,
          op: "find",
          operationId: "find-4",
          query: "deploy",
        },
      });
      expect(fourth.ok).toBe(false);
      if (fourth.ok) throw new Error("expected fourth-read denial");
      expect(fourth.code).toBe("openviking-budget-exhausted");

      const foreign = await ov.handler.handle({
        workspaceId: harness.workspaceA,
        agentId: "mem-1",
        triggerMessageId: "msg-ov-foreign",
        command: {
          protocol: "coforge.causal.agent.v1",
          op: "search",
          operationId: "search-1",
          query: "deploy",
        },
      });
      expect(foreign.ok).toBe(false);
      if (foreign.ok) throw new Error("expected foreign protocol rejection");
      expect(foreign.code).toBe("openviking-request-invalid");
    } finally {
      await harness.dispose();
    }
  },
);

test.skipIf(!connectionString)(
  "6. citation Offers persist OpenViking citations and stay workspace-scoped",
  async () => {
    const harness = await openHarness();
    try {
      const bindings = createMemoryCitationBindings({
        openviking: harness.citations,
      });
      const [ov] = await bindings.bindOpenVikingHits(harness.workspaceA, "find-1", [
        {
          citationId: "ov:wiki/deploy",
          workspaceId: harness.workspaceA,
          accountId: "acct-a",
          uri: "viking://resources/docs/deploy.md",
          contentHash: "sha256:abc",
          matchedLevel: "L2",
          excerpt: "skipped tests",
        },
      ]);
      expect(ov?.kind).toBe(OPENVIKING_CITATION_KIND);

      const offers = createMemoryOffers({
        citations: bindings,
        offers: harness.citations,
        publisher: {
          async publish() {
            return { messageId: "offer-msg" };
          },
        },
        channels: {
          async isActiveChannelAgent() {
            return true;
          },
        },
      });
      const published = await offers.publish({
        workspaceId: harness.workspaceA,
        operationId: "offer-1",
        conversationId: "conv-1",
        targetAgentId: "agent-1",
        recipientRationale: "owns the task",
        citationRefs: ["ov:wiki/deploy"],
        body: "deployment evidence",
        memoryAgentId: "memory-1",
      });
      expect(published.citations.map((citation) => citation.kind)).toEqual([
        OPENVIKING_CITATION_KIND,
      ]);
      expect((await harness.citations.getOffer(harness.workspaceA, "offer-1"))?.citations).toEqual([
        { kind: OPENVIKING_CITATION_KIND, citationId: "ov:wiki/deploy" },
      ]);
      expect(await harness.citations.getOffer(harness.workspaceB, "offer-1")).toBeNull();
    } finally {
      await harness.dispose();
    }
  },
);

test.skipIf(!connectionString)(
  "7. off→openviking→off retains data until workspace deletion is enqueued",
  async () => {
    const harness = await openHarness();
    try {
      const remotes = createFakeWorkspaceMemoryCleanupRemotes();
      const cleanup = createWorkspaceMemoryCleanup({
        store: harness.cleanupStore,
        remotes,
      });
      const switching = createSwitching(harness, { openviking: recordingSink().sink });

      await unwrap(
        await switching.selectDesired({
          workspaceId: harness.workspaceA,
          desired: "openviking",
          at: now,
        }),
      );
      await unwrap(await switching.reconcile(harness.workspaceA));
      const ready = await unwrap(await switching.reconcile(harness.workspaceA));
      expect(ready.retained).toMatchObject({
        openviking: { resourceId: `acct-${harness.workspaceA}` },
      });

      await unwrap(
        await switching.selectDesired({
          workspaceId: harness.workspaceA,
          desired: "off",
          at: afterOff,
        }),
      );
      const off = await unwrap(await switching.reconcile(harness.workspaceA));
      expect(off.observation.desired).toBe("off");
      expect(off.retained.openviking?.resourceId).toBe(`acct-${harness.workspaceA}`);
      expect(harness.provisioner.deleted).toEqual([]);
      expect(remotes.calls).toEqual([]);
      expect(await harness.bindings.get(harness.workspaceA)).toMatchObject({
        accountId: `acct-${harness.workspaceA}`,
      });
      expect(
        await harness.cleanupStore.get(harness.workspaceA, "del-1", "openviking_account"),
      ).toBeNull();

      await cleanup.enqueueWorkspaceDeletion({
        workspaceId: harness.workspaceA,
        operationId: "del-1",
      });
      expect(
        await harness.cleanupStore.get(harness.workspaceA, "del-1", "openviking_account"),
      ).toMatchObject({ state: "pending" });
      const completed = await cleanup.run({
        workspaceId: harness.workspaceA,
        operationId: "del-1",
        owner: "worker-1",
        now: afterOff,
        ttlMs: 60_000,
      });
      expect(completed.status).toBe("completed");
      expect(remotes.calls).toEqual(["openviking_account", "openviking_binding"]);
    } finally {
      await harness.dispose();
    }
  },
);
