import { expect, test } from "bun:test";
import type {
  OpenVikingAdmittedSessionWrite,
  OpenVikingTypedSessionExtract,
} from "../openviking/typed-session-extract.server";
import { detectAdmittedPublicChannelSegments } from "./detect-segments";
import {
  createAdmissionDispatcher,
  createCausalOpenVikingSink,
  createInMemoryWorkspaceMemoryAdmissionStore,
  type AdmissionSink,
  type AdmissionSinkDelivery,
} from "./dispatch";
import {
  admittedSessionLineageFromDelivery,
  admittedSessionWriteFromDelivery,
  createOpenVikingAdmittedDeliverySink,
  openVikingSessionIdForSegment,
} from "./ov-sink.server";
import { applyWorkspaceMemoryCommand, createDefaultWorkspaceMemoryProfile } from "./profile";

const activatedAt = new Date("2026-09-21T12:00:00.000Z");
const enabled = { prototypeEnabled: true };

function readyProfile(desired: "openviking" | "causal_openviking", workspaceId = "ws-a") {
  const selected = applyWorkspaceMemoryCommand(
    createDefaultWorkspaceMemoryProfile(workspaceId),
    {
      type: "select_desired",
      desired,
      at: activatedAt,
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
  return ready.profile;
}

function liveDetected(overrides: { closedAt?: Date; conversationId?: string } = {}) {
  const conversationId = overrides.conversationId ?? "ch-eng";
  const createdAt = overrides.closedAt ?? new Date("2026-09-21T12:05:00.000Z");
  return detectAdmittedPublicChannelSegments({
    conversations: [{ id: conversationId, workspaceId: "ws-a", channelName: "eng" }],
    messages: [
      {
        id: "m-live",
        conversationId,
        workspaceId: "ws-a",
        sequence: 1,
        createdAt,
        body: "standup note",
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

function deliveryFrom(detected = liveDetected()): AdmissionSinkDelivery {
  return {
    operationId: `ingest-${detected.segmentId}`,
    turns: detected.turns,
    segment: {
      segmentId: detected.segmentId,
      sourceMessageIds: detected.sourceMessageIds,
      workspace: detected.workspace,
      kind: detected.kind,
      conversationKind: detected.conversationKind,
      sourcePayloadHash: detected.sourcePayloadHash,
      profileGeneration: 1,
      closedAt: detected.closedAt,
    },
  };
}

function recordingChannel() {
  const writes: OpenVikingAdmittedSessionWrite[] = [];
  const channel: OpenVikingTypedSessionExtract = {
    async writeCommitAndExtract(input) {
      writes.push(input.write);
      return { ok: true, sessionId: input.write.sessionId };
    },
  };
  return { channel, writes };
}

test("OV sink metadata keeps segment, source IDs, and workspace lineage without causal claims", () => {
  const delivery = deliveryFrom();
  const lineage = admittedSessionLineageFromDelivery(delivery);
  const write = admittedSessionWriteFromDelivery(delivery);
  expect(lineage).toEqual({
    segmentId: delivery.segment.segmentId,
    sourceMessageIds: ["m-live"],
    workspaceId: "ws-a",
    channelId: "ch-eng",
    kind: "quiet_window",
    conversationKind: "public_channel",
    sourcePayloadHash: delivery.segment.sourcePayloadHash,
  });
  expect(write.sessionId).toBe(openVikingSessionIdForSegment(delivery.segment.segmentId));
  expect(write.workspaceId).toBe("ws-a");
  expect(write.tags).toEqual([
    `coforge_segment=${delivery.segment.segmentId}`,
    "coforge_workspace=ws-a",
    "coforge_channel=ch-eng",
    "coforge_kind=quiet_window",
    "coforge_source_message_ids=m-live",
  ]);
  expect(write.messages).toEqual([
    {
      role: "user",
      content: "standup note",
      createdAt: delivery.turns[0]!.occurredAt,
      sourceMessageIds: ["m-live"],
    },
  ]);
  expect(JSON.stringify({ lineage, write })).not.toMatch(
    /causal|cm_fact|cm_ver|provenance|audit_id|fact_id/,
  );
});

test("OV sink delivers through the typed channel and retries as retryable_failure", async () => {
  const { channel, writes } = recordingChannel();
  const sink = createOpenVikingAdmittedDeliverySink({
    sessions: channel,
    owner: "sink-owner",
  });
  const delivery = deliveryFrom();
  expect(await sink.deliver(delivery)).toEqual({ outcome: "delivered" });
  expect(writes).toHaveLength(1);
  expect(writes[0]?.sessionId).toBe(openVikingSessionIdForSegment(delivery.segment.segmentId));

  const failing: OpenVikingTypedSessionExtract = {
    async writeCommitAndExtract() {
      return { ok: false, sanitizedError: "openviking session extract failed" };
    },
  };
  const retryable = createOpenVikingAdmittedDeliverySink({
    sessions: failing,
    owner: "sink-owner",
  });
  expect(await retryable.deliver(delivery)).toEqual({
    outcome: "retryable_failure",
    sanitizedError: "openviking session extract failed",
  });
});

test("both profiles share the detector and a segment reaches exactly one sink", async () => {
  const admission = createInMemoryWorkspaceMemoryAdmissionStore();
  const { channel, writes } = recordingChannel();
  const ingested: string[] = [];
  const dispatcher = createAdmissionDispatcher({
    admission,
    sinks: {
      openviking: createOpenVikingAdmittedDeliverySink({
        sessions: channel,
        owner: "sink-owner",
      }),
      causal_openviking: createCausalOpenVikingSink({
        async ingest(input) {
          ingested.push(input.segment.segmentId);
          return { state: "succeeded" };
        },
      }),
    },
  });
  const detected = liveDetected();
  expect(detected.conversationKind).toBe("public_channel");
  expect(
    await dispatcher.dispatch({ profile: readyProfile("openviking"), detected }),
  ).toMatchObject({ outcome: "dispatched", sinkProfile: "openviking" });
  expect(
    await dispatcher.dispatch({
      profile: readyProfile("causal_openviking"),
      detected,
    }),
  ).toEqual({ outcome: "skipped", reason: "replay_conflict" });
  expect(writes).toHaveLength(1);
  expect(ingested).toEqual([]);
  expect(await admission.getDispatch("ws-a", detected.segmentId)).toMatchObject({
    sinkProfile: "openviking",
    state: "delivered",
  });
});

test("DirectConversation stays excluded while the activation cursor blocks backfill", async () => {
  const admission = createInMemoryWorkspaceMemoryAdmissionStore();
  const { channel, writes } = recordingChannel();
  const ingested: string[] = [];
  const dispatcher = createAdmissionDispatcher({
    admission,
    sinks: {
      openviking: createOpenVikingAdmittedDeliverySink({
        sessions: channel,
        owner: "sink-owner",
      }),
      causal_openviking: createCausalOpenVikingSink({
        async ingest(input) {
          ingested.push(input.segment.segmentId);
          return { state: "succeeded" };
        },
      }),
    },
  });
  const dm = detectAdmittedPublicChannelSegments({
    conversations: [{ id: "dm-1", workspaceId: "ws-a", channelName: null }],
    messages: [
      {
        id: "m-dm",
        conversationId: "dm-1",
        workspaceId: "ws-a",
        sequence: 1,
        createdAt: new Date("2026-09-21T12:05:00.000Z"),
        body: "private",
        senderKind: "human",
        senderHandle: "ada",
      },
    ],
    tasks: [],
    admittedMessageIds: new Set(),
    now: new Date("2026-09-21T12:30:00.000Z"),
    quietAfterMs: 1,
  });
  expect(dm).toEqual([]);
  const historical = liveDetected({ closedAt: new Date("2026-09-21T11:00:00.000Z") });
  const live = liveDetected();
  expect(
    await dispatcher.dispatch({
      profile: readyProfile("openviking"),
      detected: historical,
    }),
  ).toEqual({ outcome: "skipped", reason: "before_activation_cursor" });
  expect(
    await dispatcher.dispatch({
      profile: readyProfile("causal_openviking"),
      detected: historical,
    }),
  ).toEqual({ outcome: "skipped", reason: "before_activation_cursor" });
  expect(writes).toEqual([]);
  expect(ingested).toEqual([]);
  expect(
    await dispatcher.dispatch({ profile: readyProfile("openviking"), detected: live }),
  ).toEqual({
    outcome: "dispatched",
    sinkProfile: "openviking",
    replay: false,
  });
  expect(writes).toHaveLength(1);
});

test("a retryable OV sink failure keeps the admitted segment for later replay", async () => {
  const admission = createInMemoryWorkspaceMemoryAdmissionStore();
  let attempts = 0;
  const flaky: OpenVikingTypedSessionExtract = {
    async writeCommitAndExtract(input) {
      attempts += 1;
      if (attempts === 1) {
        return { ok: false, sanitizedError: "openviking session extract failed" };
      }
      return { ok: true, sessionId: input.write.sessionId };
    },
  };
  const dispatcher = createAdmissionDispatcher({
    admission,
    sinks: {
      openviking: createOpenVikingAdmittedDeliverySink({
        sessions: flaky,
        owner: "sink-owner",
      }),
      causal_openviking: {
        async deliver() {
          throw new Error("causal sink must not receive this segment");
        },
      } satisfies AdmissionSink,
    },
  });
  const live = liveDetected();
  const profile = readyProfile("openviking");
  expect(await dispatcher.dispatch({ profile, detected: live })).toEqual({
    outcome: "retryable_failure",
    sanitizedError: "openviking session extract failed",
  });
  expect(await admission.getSegment("ws-a", live.segmentId)).not.toBeNull();
  expect(await admission.getDispatch("ws-a", live.segmentId)).toMatchObject({
    state: "retryable_failure",
    sinkProfile: "openviking",
    attemptCount: 1,
  });
  expect(await admission.listRetryableDispatches("ws-a")).toHaveLength(1);
  expect(await dispatcher.dispatch({ profile, detected: live })).toEqual({
    outcome: "dispatched",
    sinkProfile: "openviking",
    replay: true,
  });
  expect(await admission.getDispatch("ws-a", live.segmentId)).toMatchObject({
    state: "delivered",
    sinkProfile: "openviking",
  });
  expect(attempts).toBe(2);
});
