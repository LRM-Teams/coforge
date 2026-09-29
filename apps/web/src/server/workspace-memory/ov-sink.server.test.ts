import { expect, test } from "bun:test";
import { createOpenVikingRuntimeClient } from "../openviking/runtime-client.server";
import {
  createOpenVikingTypedSessionExtract,
  type OpenVikingAdmittedSessionWrite,
  type OpenVikingTypedSessionExtract,
} from "../openviking/typed-session-extract.server";
import { detectAdmittedPublicChannelSegments } from "./detect-segments";
import {
  createAdmissionDispatcher,
  createInMemoryWorkspaceMemoryAdmissionStore,
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

function readyProfile(workspaceId = "ws-a") {
  const selected = applyWorkspaceMemoryCommand(
    createDefaultWorkspaceMemoryProfile(workspaceId),
    {
      type: "select_desired",
      desired: "openviking",
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

test("agent turns carry a coforge peer id and human turns do not", async () => {
  const delivery = deliveryFrom(
    detectAdmittedPublicChannelSegments({
      conversations: [{ id: "ch-eng", workspaceId: "ws-a", channelName: "eng" }],
      messages: [
        {
          id: "m-human",
          conversationId: "ch-eng",
          workspaceId: "ws-a",
          sequence: 1,
          createdAt: new Date("2026-09-21T12:05:00.000Z"),
          body: "what shipped",
          senderKind: "human",
          senderHandle: "ada",
        },
        {
          id: "m-agent",
          conversationId: "ch-eng",
          workspaceId: "ws-a",
          sequence: 2,
          createdAt: new Date("2026-09-21T12:06:00.000Z"),
          body: "the patch landed",
          senderKind: "agent",
          senderHandle: "helper",
        },
      ],
      tasks: [],
      admittedMessageIds: new Set(),
      now: new Date("2026-09-21T12:30:00.000Z"),
      quietAfterMs: 15 * 60 * 1000,
    })[0]!,
  );
  const write = admittedSessionWriteFromDelivery(delivery);
  expect(write.messages).toEqual([
    {
      role: "user",
      content: "what shipped",
      createdAt: "2026-09-21T12:05:00.000Z",
      sourceMessageIds: ["m-human"],
    },
    {
      role: "assistant",
      content: "the patch landed",
      createdAt: "2026-09-21T12:06:00.000Z",
      sourceMessageIds: ["m-agent"],
      peerId: "coforge__helper",
    },
  ]);

  const batches: unknown[] = [];
  const sessions = createOpenVikingTypedSessionExtract({
    runtime: createOpenVikingRuntimeClient({
      baseUrl: "http://ov.internal:1933",
      fetchImpl: async (input, init) => {
        if (String(input).endsWith("/messages/batch") && typeof init?.body === "string") {
          batches.push(JSON.parse(init.body));
        }
        return new Response(JSON.stringify({ status: "ok", result: {} }), { status: 200 });
      },
    }),
    authorizedOwner: "sink-owner",
    sinkIdentity: {
      accountId: "acct-ws-a",
      userId: "workspace-memory-sink",
      role: "user",
      authorization: "Bearer server-held-sink",
    },
  });
  const sink = createOpenVikingAdmittedDeliverySink({ sessions, owner: "sink-owner" });
  expect(await sink.deliver(delivery)).toEqual({ outcome: "delivered" });
  expect(batches).toEqual([
    {
      messages: [
        {
          role: "user",
          content: "what shipped",
          created_at: "2026-09-21T12:05:00.000Z",
          source_message_ids: ["m-human"],
        },
        {
          role: "assistant",
          content: "the patch landed",
          created_at: "2026-09-21T12:06:00.000Z",
          source_message_ids: ["m-agent"],
          peer_id: "coforge__helper",
        },
      ],
    },
  ]);
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

test("a detected segment reaches exactly one sink and replays without rewriting", async () => {
  const admission = createInMemoryWorkspaceMemoryAdmissionStore();
  const { channel, writes } = recordingChannel();
  const dispatcher = createAdmissionDispatcher({
    admission,
    sinks: {
      openviking: createOpenVikingAdmittedDeliverySink({
        sessions: channel,
        owner: "sink-owner",
      }),
    },
  });
  const detected = liveDetected();
  expect(detected.conversationKind).toBe("public_channel");
  expect(await dispatcher.dispatch({ profile: readyProfile(), detected })).toMatchObject({
    outcome: "dispatched",
    sinkProfile: "openviking",
  });
  expect(await dispatcher.dispatch({ profile: readyProfile(), detected })).toEqual({
    outcome: "replayed",
    sinkProfile: "openviking",
  });
  expect(writes).toHaveLength(1);
  expect(await admission.getDispatch("ws-a", detected.segmentId)).toMatchObject({
    sinkProfile: "openviking",
    state: "delivered",
  });
});

test("DirectConversation stays excluded while the activation cursor blocks backfill", async () => {
  const admission = createInMemoryWorkspaceMemoryAdmissionStore();
  const { channel, writes } = recordingChannel();
  const dispatcher = createAdmissionDispatcher({
    admission,
    sinks: {
      openviking: createOpenVikingAdmittedDeliverySink({
        sessions: channel,
        owner: "sink-owner",
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
      profile: readyProfile(),
      detected: historical,
    }),
  ).toEqual({ outcome: "skipped", reason: "before_activation_cursor" });
  expect(writes).toEqual([]);
  expect(await dispatcher.dispatch({ profile: readyProfile(), detected: live })).toEqual({
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
    },
  });
  const live = liveDetected();
  const profile = readyProfile();
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
