import { expect, test } from "bun:test";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/client";
import { PrismaWorkspaceMemoryAdmissionStore } from "../src/server/db/repositories/workspace-memory-admission.repositories.server";
import { PrismaWorkspaceMemoryProfileStore } from "../src/server/db/repositories/workspace-memory-profile.repositories.server";
import type {
  OpenVikingAdmittedSessionWrite,
  OpenVikingTypedSessionExtract,
} from "../src/server/openviking/typed-session-extract.server";
import { detectAdmittedPublicChannelSegments } from "../src/server/workspace-memory/detect-segments";
import {
  createAdmissionDispatcher,
  createCausalOpenVikingSink,
} from "../src/server/workspace-memory/dispatch";
import { createOpenVikingAdmittedDeliverySink } from "../src/server/workspace-memory/ov-sink.server";
import {
  applyWorkspaceMemoryCommand,
  createDefaultWorkspaceMemoryProfile,
} from "../src/server/workspace-memory/profile";
import {
  WORKSPACE_MEMORY_PG_URL,
  applyWorkspaceMemoryPgStub,
  warnIfWorkspaceMemoryPgSkipped,
} from "./helpers/workspace-memory-pg";

const connectionString = WORKSPACE_MEMORY_PG_URL;
warnIfWorkspaceMemoryPgSkipped("workspace-memory delivery");

const now = new Date("2026-09-21T12:00:00.000Z");
const enabled = { prototypeEnabled: true };

type Harness = {
  db: PrismaClient;
  workspaceA: string;
  profiles: PrismaWorkspaceMemoryProfileStore;
  admission: PrismaWorkspaceMemoryAdmissionStore;
};

async function openHarness(): Promise<Harness & { dispose: () => Promise<void> }> {
  const pool = new Pool({ connectionString });
  const schema = `wmp_del_${crypto.randomUUID().replaceAll("-", "")}`;
  const client = await pool.connect();
  await client.query(`CREATE SCHEMA "${schema}"`);
  await client.query(`SET search_path TO "${schema}"`);
  const workspaceA = crypto.randomUUID();
  await applyWorkspaceMemoryPgStub(client, { workspaceIds: [workspaceA] });
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }, { schema }) });
  return {
    db,
    workspaceA,
    profiles: new PrismaWorkspaceMemoryProfileStore(db),
    admission: new PrismaWorkspaceMemoryAdmissionStore(db),
    async dispose() {
      await db.$disconnect();
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      client.release();
      await pool.end();
    },
  };
}

function liveDetected(workspaceId: string, closedAt: Date) {
  return detectAdmittedPublicChannelSegments({
    conversations: [{ id: "ch-eng", workspaceId, channelName: "eng" }],
    messages: [
      {
        id: "m-live",
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
    now: new Date("2026-09-21T12:30:00.000Z"),
    quietAfterMs: 15 * 60 * 1000,
  })[0]!;
}

async function readyOpenViking(harness: Harness) {
  const seed = createDefaultWorkspaceMemoryProfile(harness.workspaceA);
  const selected = applyWorkspaceMemoryCommand(
    seed,
    {
      type: "select_desired",
      desired: "openviking",
      at: now,
      afterMessageId: "msg-boundary",
    },
    enabled,
  );
  if (!selected.ok) throw new Error(selected.failure.code);
  const ready = applyWorkspaceMemoryCommand(selected.profile, {
    type: "observe_ready",
    generation: 1,
  });
  if (!ready.ok) throw new Error(ready.failure.code);
  expect(
    await harness.profiles.compareAndSet({
      workspaceId: harness.workspaceA,
      expectedGeneration: 0,
      profile: ready.profile,
    }),
  ).toBe("saved");
  return (await harness.profiles.get(harness.workspaceA))!;
}

test.skipIf(!connectionString)(
  "Prisma dispatch ledger keeps one sink, replays as no-op, and retains retryable failures",
  async () => {
    const harness = await openHarness();
    try {
      const writes: OpenVikingAdmittedSessionWrite[] = [];
      let attempts = 0;
      const channel: OpenVikingTypedSessionExtract = {
        async writeCommitAndExtract(input) {
          attempts += 1;
          writes.push(input.write);
          if (attempts === 1) {
            return { ok: false, sanitizedError: "openviking session extract failed" };
          }
          return { ok: true, sessionId: input.write.sessionId };
        },
      };
      const ingested: string[] = [];
      const dispatcher = createAdmissionDispatcher({
        admission: harness.admission,
        sinks: {
          openviking: createOpenVikingAdmittedDeliverySink({
            sessions: channel,
            owner: "sink-owner",
          }),
          causal_openviking: createCausalOpenVikingSink({
            async ingest(delivery) {
              ingested.push(delivery.segment.segmentId);
              return { state: "succeeded" };
            },
          }),
        },
      });
      const profile = await readyOpenViking(harness);
      const historical = liveDetected(harness.workspaceA, new Date("2026-09-21T11:00:00.000Z"));
      const live = liveDetected(harness.workspaceA, new Date("2026-09-21T12:05:00.000Z"));

      expect(await dispatcher.dispatch({ profile, detected: historical })).toEqual({
        outcome: "skipped",
        reason: "before_activation_cursor",
      });
      expect(await dispatcher.dispatch({ profile, detected: live })).toEqual({
        outcome: "retryable_failure",
        sanitizedError: "openviking session extract failed",
      });
      expect(await harness.admission.getSegment(harness.workspaceA, live.segmentId)).not.toBeNull();
      expect(await harness.admission.getDispatch(harness.workspaceA, live.segmentId)).toMatchObject(
        {
          state: "retryable_failure",
          sinkProfile: "openviking",
          attemptCount: 1,
        },
      );

      expect(await dispatcher.dispatch({ profile, detected: live })).toEqual({
        outcome: "dispatched",
        sinkProfile: "openviking",
        replay: true,
      });
      expect(await dispatcher.dispatch({ profile, detected: live })).toEqual({
        outcome: "replayed",
        sinkProfile: "openviking",
      });
      expect(
        await dispatcher.dispatch({
          profile: { ...profile, desired: "causal_openviking" },
          detected: live,
        }),
      ).toEqual({ outcome: "skipped", reason: "replay_conflict" });
      expect(writes).toHaveLength(2);
      expect(writes[0]?.tags).toContain(`coforge_segment=${live.segmentId}`);
      expect(JSON.stringify(writes)).not.toMatch(/causal|cm_fact|provenance|audit_id/);
      expect(ingested).toEqual([]);
      expect(attempts).toBe(2);
    } finally {
      await harness.dispose();
    }
  },
);
