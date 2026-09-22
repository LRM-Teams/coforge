/**
 * F5 deterministic Workspace Memory Profile scenarios.
 * Fake/synthetic OpenViking + injected Causal Memory seams; no real runtime.
 * PostgreSQL is required; skipIf is explicit when no connection string is set.
 */
import { expect, test } from "bun:test";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/client";
import {
  CAUSAL_AGENT_PROTOCOL,
  CAUSAL_MEMORY_CITATION_KIND,
  CAUSAL_TOOL_NAMES,
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
import {
  createInMemoryCausalMemoryCitationBindings,
  createMemoryCitationBindings,
} from "../src/server/causal-memory/memory-citations";
import { createMemoryAgentBudgetLedger } from "../src/server/causal-memory/memory-agent-budget";
import { createMemoryOffers } from "../src/server/causal-memory/memory-offers";
import { createOpenVikingMemoryReads } from "../src/server/causal-memory/openviking-memory-reads";
import { createMemoryAgentCommands } from "../src/server/causal-memory/memory-agent-route";
import type { CoforgeMemoryActor } from "../src/server/openviking/contract";
import { createOpenVikingPolicyGateway } from "../src/server/openviking/policy-gateway.server";
import { createOpenVikingRuntimeClient } from "../src/server/openviking/runtime-client.server";
import { sanitizeOpenVikingTransportFailure } from "../src/server/openviking/route-policy";
import { detectAdmittedPublicChannelSegments } from "../src/server/workspace-memory/detect-segments";
import {
  createAdmissionDispatcher,
  createCausalOpenVikingSink,
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

type DesiredProfile = "openviking" | "causal_openviking";

type RetrievalCandidate = {
  factId: string;
  factVersion: number;
  tenantId: string;
  status: "active" | "superseded" | "unknown";
  currentVersion?: number;
};

type FakeCausalRetrieval = {
  calls: string[];
  ovUnavailable: boolean;
  searchHits: RetrievalCandidate[];
  deltaHits: RetrievalCandidate[];
  retrieve(input: { workspaceId: string; query: string }): Promise<{
    source: "openviking" | "local";
    watermark: number;
    accepted: RetrievalCandidate[];
    rejected: RetrievalCandidate[];
  }>;
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

function acceptCausalCandidates(
  tenantId: string,
  candidates: readonly RetrievalCandidate[],
): { accepted: RetrievalCandidate[]; rejected: RetrievalCandidate[] } {
  const accepted: RetrievalCandidate[] = [];
  const rejected: RetrievalCandidate[] = [];
  for (const candidate of candidates) {
    const stale =
      candidate.currentVersion !== undefined && candidate.factVersion < candidate.currentVersion;
    const bad = candidate.tenantId !== tenantId || candidate.status !== "active" || stale;
    if (bad) rejected.push(candidate);
    else accepted.push(candidate);
  }
  return { accepted, rejected };
}

function createFakeCausalRetrieval(): FakeCausalRetrieval {
  const calls: string[] = [];
  const retrieval: FakeCausalRetrieval = {
    calls,
    ovUnavailable: false,
    searchHits: [],
    deltaHits: [],
    async retrieve({ workspaceId }) {
      const tenantId = `tenant-${workspaceId}`;
      calls.push("search");
      if (retrieval.ovUnavailable) {
        calls.push("fallback");
        const local = acceptCausalCandidates(tenantId, retrieval.deltaHits);
        return { source: "local", watermark: 0, ...local };
      }
      const watermark = 7;
      calls.push("delta");
      calls.push("merge");
      return {
        source: "openviking",
        watermark,
        ...acceptCausalCandidates(tenantId, [...retrieval.searchHits, ...retrieval.deltaHits]),
      };
    },
  };
  return retrieval;
}

function createSwitching(
  harness: Harness,
  sinks: { openviking: AdmissionSink; causal_openviking: AdmissionSink },
  retrieveCausal?: FakeCausalRetrieval,
) {
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
    retrieveCausal: retrieveCausal
      ? (input) => retrieveCausal.retrieve(input)
      : async () => ({ hits: [] }),
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
      const causal = recordingSink();
      const switching = createSwitching(harness, {
        openviking: openviking.sink,
        causal_openviking: causal.sink,
      });
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
  "2. profile activation does not backfill history; each era stays on its own sink",
  async () => {
    const harness = await openHarness();
    try {
      const openviking = recordingSink();
      const causal = recordingSink();
      const switching = createSwitching(harness, {
        openviking: openviking.sink,
        causal_openviking: causal.sink,
      });
      const historical = liveDetected(
        harness.workspaceA,
        new Date("2026-09-21T11:00:00.000Z"),
        "m-old",
      );
      const ovLive = liveDetected(harness.workspaceA, new Date("2026-09-21T12:05:00.000Z"), "m-ov");
      const causalLive = liveDetected(
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
          desired: "causal_openviking",
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
        await switching.dispatch({ workspaceId: harness.workspaceA, detected: causalLive }),
      ).toMatchObject({
        outcome: { outcome: "dispatched", sinkProfile: "causal_openviking" },
      });
      expect(openviking.deliveries.map((row) => row.segment.sourceMessageIds)).toEqual([["m-ov"]]);
      expect(causal.deliveries.map((row) => row.segment.sourceMessageIds)).toEqual([["m-cm"]]);
    } finally {
      await harness.dispose();
    }
  },
);

test.skipIf(!connectionString)(
  "3. both profiles share one PublicChannel detector and exclude DirectConversation",
  async () => {
    const harness = await openHarness();
    try {
      const openviking = recordingSink();
      const causal = recordingSink();
      const switching = createSwitching(harness, {
        openviking: openviking.sink,
        causal_openviking: causal.sink,
      });
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
      const forOpenviking = detectAdmittedPublicChannelSegments(input);
      const forCausal = detectAdmittedPublicChannelSegments(input);
      expect(forOpenviking).toEqual(forCausal);
      expect(forOpenviking).toHaveLength(1);
      expect(forOpenviking[0]?.sourceMessageIds).toEqual(["m-pub"]);
      expect(forOpenviking[0]?.conversationKind).toBe("public_channel");

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
          detected: forOpenviking[0]!,
        }),
      ).toMatchObject({ outcome: { outcome: "dispatched", sinkProfile: "openviking" } });
      expect(causal.deliveries).toEqual([]);
      expect(openviking.deliveries).toHaveLength(1);

      await unwrap(
        await switching.selectDesired({
          workspaceId: harness.workspaceB,
          desired: "causal_openviking",
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
        outcome: { outcome: "dispatched", sinkProfile: "causal_openviking" },
      });
      expect(openviking.deliveries).toHaveLength(1);
      expect(causal.deliveries.map((row) => row.segment.workspace.workspaceId)).toEqual([
        harness.workspaceB,
      ]);
    } finally {
      await harness.dispose();
    }
  },
);

test.skipIf(!connectionString)(
  "4. admitted causal commit reaches the injected CM sink as L0/L1/L2 projection work",
  async () => {
    const harness = await openHarness();
    try {
      const projectionApplies: Array<{
        levels: readonly string[];
        segmentId: string;
        workspaceId: string;
      }> = [];
      const openviking = recordingSink();
      const switching = createSwitching(harness, {
        openviking: openviking.sink,
        causal_openviking: createCausalOpenVikingSink({
          async ingest(delivery) {
            projectionApplies.push({
              levels: ["L0", "L1", "L2"],
              segmentId: delivery.segment.segmentId,
              workspaceId: delivery.segment.workspace.workspaceId,
            });
            return { state: "succeeded" };
          },
        }),
      });
      await unwrap(
        await switching.selectDesired({
          workspaceId: harness.workspaceA,
          desired: "causal_openviking",
          at: now,
        }),
      );
      await unwrap(await switching.reconcile(harness.workspaceA));
      const live = liveDetected(harness.workspaceA, new Date("2026-09-21T12:05:00.000Z"), "m-proj");
      expect(
        await switching.dispatch({ workspaceId: harness.workspaceA, detected: live }),
      ).toMatchObject({
        outcome: { outcome: "dispatched", sinkProfile: "causal_openviking" },
      });
      expect(projectionApplies).toEqual([
        {
          levels: ["L0", "L1", "L2"],
          segmentId: live.segmentId,
          workspaceId: harness.workspaceA,
        },
      ]);
      expect(openviking.deliveries).toEqual([]);
      expect(await harness.admission.getDispatch(harness.workspaceA, live.segmentId)).toMatchObject(
        {
          state: "delivered",
          sinkProfile: "causal_openviking",
        },
      );
    } finally {
      await harness.dispose();
    }
  },
);

test.skipIf(!connectionString)(
  "5. watermark plus local-delta retrieval records search → delta → merge and read-your-writes",
  async () => {
    const harness = await openHarness();
    try {
      const retrieval = createFakeCausalRetrieval();
      retrieval.searchHits = [
        {
          factId: "fact-projected",
          factVersion: 2,
          tenantId: `tenant-${harness.workspaceA}`,
          status: "active",
          currentVersion: 2,
        },
      ];
      retrieval.deltaHits = [
        {
          factId: "fact-unprojected",
          factVersion: 1,
          tenantId: `tenant-${harness.workspaceA}`,
          status: "active",
          currentVersion: 1,
        },
      ];
      const switching = createSwitching(
        harness,
        { openviking: recordingSink().sink, causal_openviking: recordingSink().sink },
        retrieval,
      );
      await unwrap(
        await switching.selectDesired({
          workspaceId: harness.workspaceA,
          desired: "causal_openviking",
          at: now,
        }),
      );
      await unwrap(await switching.reconcile(harness.workspaceA));
      const found = await switching.retrieveCausal({
        workspaceId: harness.workspaceA,
        query: "deploy",
      });
      expect(found).toMatchObject({ allowed: true });
      expect(retrieval.calls).toEqual(["search", "delta", "merge"]);
      expect(found.allowed && found.result).toMatchObject({
        source: "openviking",
        watermark: 7,
        accepted: [
          expect.objectContaining({ factId: "fact-projected" }),
          expect.objectContaining({ factId: "fact-unprojected" }),
        ],
      });
    } finally {
      await harness.dispose();
    }
  },
);

test.skipIf(!connectionString)(
  "6. stale, superseded, and cross-tenant candidates are all rejected",
  async () => {
    const harness = await openHarness();
    try {
      const retrieval = createFakeCausalRetrieval();
      retrieval.searchHits = [
        {
          factId: "stale",
          factVersion: 1,
          currentVersion: 3,
          tenantId: `tenant-${harness.workspaceA}`,
          status: "active",
        },
        {
          factId: "superseded",
          factVersion: 4,
          tenantId: `tenant-${harness.workspaceA}`,
          status: "superseded",
        },
        {
          factId: "foreign",
          factVersion: 1,
          tenantId: `tenant-${harness.workspaceB}`,
          status: "active",
          currentVersion: 1,
        },
        {
          factId: "unknown",
          factVersion: 1,
          tenantId: `tenant-${harness.workspaceA}`,
          status: "unknown",
        },
      ];
      const switching = createSwitching(
        harness,
        { openviking: recordingSink().sink, causal_openviking: recordingSink().sink },
        retrieval,
      );
      await unwrap(
        await switching.selectDesired({
          workspaceId: harness.workspaceA,
          desired: "causal_openviking",
          at: now,
        }),
      );
      await unwrap(await switching.reconcile(harness.workspaceA));
      await unwrap(
        await switching.selectDesired({
          workspaceId: harness.workspaceB,
          desired: "causal_openviking",
          at: now,
        }),
      );
      await unwrap(await switching.reconcile(harness.workspaceB));

      const rejected = await switching.retrieveCausal({
        workspaceId: harness.workspaceA,
        query: "deploy",
      });
      expect(rejected.allowed).toBe(true);
      if (!rejected.allowed) throw new Error("expected allowed retrieval");
      expect(rejected.result).toMatchObject({
        accepted: [],
        rejected: [
          expect.objectContaining({ factId: "stale" }),
          expect.objectContaining({ factId: "superseded" }),
          expect.objectContaining({ factId: "foreign" }),
          expect.objectContaining({ factId: "unknown" }),
        ],
      });

      const isolated = await switching.retrieveCausal({
        workspaceId: harness.workspaceB,
        query: "deploy",
      });
      expect(isolated.allowed).toBe(true);
      if (!isolated.allowed) throw new Error("expected allowed retrieval");
      expect(isolated.result).toMatchObject({
        accepted: [expect.objectContaining({ factId: "foreign" })],
      });
    } finally {
      await harness.dispose();
    }
  },
);

test.skipIf(!connectionString)(
  "7. OpenViking outage degrades retrieval without blocking ordinary messages",
  async () => {
    const harness = await openHarness();
    try {
      const retrieval = createFakeCausalRetrieval();
      retrieval.deltaHits = [
        {
          factId: "local-only",
          factVersion: 1,
          tenantId: `tenant-${harness.workspaceA}`,
          status: "active",
          currentVersion: 1,
        },
      ];
      const switching = createSwitching(
        harness,
        { openviking: recordingSink().sink, causal_openviking: recordingSink().sink },
        retrieval,
      );
      await unwrap(
        await switching.selectDesired({
          workspaceId: harness.workspaceA,
          desired: "causal_openviking",
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

      retrieval.ovUnavailable = true;
      const fallback = await switching.retrieveCausal({
        workspaceId: harness.workspaceA,
        query: "deploy",
      });
      expect(fallback.allowed).toBe(true);
      if (!fallback.allowed) throw new Error("expected fallback retrieval");
      expect(retrieval.calls).toEqual(["search", "fallback"]);
      expect(fallback.result).toMatchObject({
        source: "local",
        accepted: [expect.objectContaining({ factId: "local-only" })],
      });

      harness.provisioner.setHealth("degraded");
      const degraded = await unwrap(await switching.reconcile(harness.workspaceA));
      expect(degraded.observation.observed).toBe("degraded");
      expect(degraded.observation.surfaces.admission.open).toBe(true);
      expect(degraded.observation.surfaces.causalRetrieval.open).toBe(true);
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
        outcome: { outcome: "dispatched", sinkProfile: "causal_openviking" },
      });
    } finally {
      await harness.dispose();
    }
  },
);

function memoryAgentCommands(desired: DesiredProfile) {
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
    causal: createInMemoryCausalMemoryCitationBindings(),
  });
  const handler = createMemoryAgentCommands({
    fence: {
      async resolve() {
        return workspaceProfileToToolFence(desired);
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
      corrections: {
        async propose(input) {
          return { accepted: true, duplicate: false, proposalId: input.operationId };
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
    causalRuntime: {
      async request<T>() {
        return {
          duplicate: false,
          items: [
            {
              citationId: "cm:decision-1",
              causalItemId: "decision-1",
              factVersion: 3,
              admittedSegmentId: "segment-1",
              sourceMessageIds: ["11111111-1111-1111-1111-111111111111"],
              displayContent: "skipping tests caused a rollback",
            },
          ],
        } as T;
      },
    },
    async tenantToken() {
      return "tok";
    },
  });
  return { handler, offerRows };
}

test.skipIf(!connectionString)(
  "8. profile-specific Memory Agent fences deny a fourth OpenViking read and keep dual causal tools",
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
      expect(toolsForMemoryFence(workspaceProfileToToolFence("causal_openviking")!)).toEqual([
        CAUSAL_TOOL_NAMES.search,
        CAUSAL_TOOL_NAMES.trace,
        CAUSAL_TOOL_NAMES.intervene,
        CAUSAL_TOOL_NAMES.proposeCorrection,
        CAUSAL_TOOL_NAMES.offer,
        OPENVIKING_TOOL_NAMES.find,
        OPENVIKING_TOOL_NAMES.searchContext,
        OPENVIKING_TOOL_NAMES.read,
      ]);

      const ov = memoryAgentCommands("openviking");
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

      const blocked = await ov.handler.handle({
        workspaceId: harness.workspaceA,
        agentId: "mem-1",
        triggerMessageId: "msg-ov-causal",
        command: {
          protocol: CAUSAL_AGENT_PROTOCOL,
          op: "search",
          operationId: "search-1",
          query: "deploy",
        },
      });
      expect(blocked.ok).toBe(false);
      if (blocked.ok) throw new Error("expected causal fence");
      expect(blocked.code).toBe("causal-unauthorized");

      const mixed = memoryAgentCommands("causal_openviking");
      const causalRead = await mixed.handler.handle({
        workspaceId: harness.workspaceA,
        agentId: "mem-1",
        triggerMessageId: "msg-cm",
        command: {
          protocol: CAUSAL_AGENT_PROTOCOL,
          op: "search",
          operationId: "search-1",
          query: "deploy",
        },
      });
      const ovRead = await mixed.handler.handle({
        workspaceId: harness.workspaceA,
        agentId: "mem-1",
        triggerMessageId: "msg-cm",
        command: {
          protocol: OPENVIKING_AGENT_PROTOCOL,
          op: "find",
          operationId: "find-1",
          query: "deploy",
        },
      });
      expect(causalRead.ok).toBe(true);
      expect(ovRead.ok).toBe(true);
    } finally {
      await harness.dispose();
    }
  },
);

test.skipIf(!connectionString)(
  "9. mixed citation Offers persist both kinds and correction rejects OpenViking evidence",
  async () => {
    const harness = await openHarness();
    try {
      const causal = createInMemoryCausalMemoryCitationBindings();
      const bindings = createMemoryCitationBindings({
        openviking: harness.citations,
        causal,
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
      await bindings.bindCausalHits(harness.workspaceA, "search-1", [
        {
          citationId: "cm:decision-1",
          causalItemId: "decision-1",
          factVersion: 3,
          admittedSegmentId: "segment-1",
          sourceMessageIds: ["11111111-1111-1111-1111-111111111111"],
          displayContent: "skipping tests caused a rollback",
        },
      ]);
      await harness.client.query(
        `INSERT INTO "causal_citation_records" ("id", "workspace_id", "citation_id") VALUES ($1, $2, 'cm:decision-1')`,
        [crypto.randomUUID(), harness.workspaceA],
      );

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
        corrections: {
          async propose(input) {
            return { accepted: true, duplicate: false, proposalId: input.operationId };
          },
        },
      });
      const mixed = await offers.publish({
        workspaceId: harness.workspaceA,
        operationId: "offer-1",
        conversationId: "conv-1",
        targetAgentId: "agent-1",
        recipientRationale: "owns the task",
        citationRefs: ["ov:wiki/deploy", "cm:decision-1"],
        body: "mixed evidence",
        memoryAgentId: "memory-1",
      });
      expect(mixed.citations.map((citation) => citation.kind)).toEqual([
        OPENVIKING_CITATION_KIND,
        CAUSAL_MEMORY_CITATION_KIND,
      ]);
      expect((await harness.citations.getOffer(harness.workspaceA, "offer-1"))?.citations).toEqual([
        { kind: CAUSAL_MEMORY_CITATION_KIND, citationId: "cm:decision-1" },
        { kind: OPENVIKING_CITATION_KIND, citationId: "ov:wiki/deploy" },
      ]);
      expect(await harness.citations.getOffer(harness.workspaceB, "offer-1")).toBeNull();

      await expect(
        offers.proposeCorrection({
          workspaceId: harness.workspaceA,
          operationId: "fix-ov",
          causalItemId: "decision-1",
          contradictoryCitationRefs: ["ov:wiki/deploy"],
          rationale: "OV is not admitted provenance",
        }),
      ).rejects.toThrow("openviking citation cannot satisfy causal correction");
    } finally {
      await harness.dispose();
    }
  },
);

test.skipIf(!connectionString)(
  "10. off→openviking→causal→off retains data until workspace deletion is enqueued",
  async () => {
    const harness = await openHarness();
    try {
      const remotes = createFakeWorkspaceMemoryCleanupRemotes();
      const cleanup = createWorkspaceMemoryCleanup({
        store: harness.cleanupStore,
        remotes,
      });
      const switching = createSwitching(harness, {
        openviking: recordingSink().sink,
        causal_openviking: recordingSink().sink,
      });

      await unwrap(
        await switching.selectDesired({
          workspaceId: harness.workspaceA,
          desired: "openviking",
          at: now,
        }),
      );
      await unwrap(await switching.reconcile(harness.workspaceA));
      await unwrap(
        await switching.selectDesired({
          workspaceId: harness.workspaceA,
          desired: "causal_openviking",
          at: later,
        }),
      );
      const causalReady = await unwrap(await switching.reconcile(harness.workspaceA));
      expect(causalReady.retained).toMatchObject({
        openviking: { resourceId: `acct-${harness.workspaceA}` },
        causalTenant: { resourceId: `tenant-${harness.workspaceA}` },
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
      expect(off.retained.causalTenant?.resourceId).toBe(`tenant-${harness.workspaceA}`);
      expect(harness.provisioner.deleted).toEqual([]);
      expect(remotes.calls).toEqual([]);
      expect(await harness.bindings.get(harness.workspaceA)).toMatchObject({
        accountId: `acct-${harness.workspaceA}`,
      });
      expect(
        await harness.cleanupStore.get(harness.workspaceA, "del-1", "causal_tenant"),
      ).toBeNull();

      await cleanup.enqueueWorkspaceDeletion({
        workspaceId: harness.workspaceA,
        operationId: "del-1",
      });
      expect(
        await harness.cleanupStore.get(harness.workspaceA, "del-1", "causal_tenant"),
      ).toMatchObject({ state: "pending" });
      const completed = await cleanup.run({
        workspaceId: harness.workspaceA,
        operationId: "del-1",
        owner: "worker-1",
        now: afterOff,
        ttlMs: 60_000,
      });
      expect(completed.status).toBe("completed");
      expect(remotes.calls).toEqual([
        "causal_tenant",
        "openviking_account",
        "managed_causal_projection",
        "pending_projection_work",
        "openviking_binding",
      ]);
    } finally {
      await harness.dispose();
    }
  },
);
