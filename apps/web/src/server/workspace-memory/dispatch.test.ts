import { expect, test } from "bun:test";
import {
  createAdmissionDispatcher,
  createCausalOpenVikingSink,
  createInMemoryWorkspaceMemoryAdmissionStore,
  createOpenVikingNativeSessionSink,
  type AdmissionSink,
  type AdmissionSinkDelivery,
} from "./dispatch";
import { detectAdmittedPublicChannelSegments } from "./detect-segments";
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

test("activation cursor history is not dispatched and a live segment reaches exactly one sink", async () => {
  const admission = createInMemoryWorkspaceMemoryAdmissionStore();
  const openviking = recordingSink();
  const causal = recordingSink();
  const dispatcher = createAdmissionDispatcher({
    admission,
    sinks: { openviking: openviking.sink, causal_openviking: causal.sink },
  });
  const profile = readyProfile("causal_openviking");
  const historical = liveDetected({ closedAt: new Date("2026-09-21T11:00:00.000Z") });
  const live = liveDetected();

  expect(await dispatcher.dispatch({ profile, detected: historical })).toEqual({
    outcome: "skipped",
    reason: "before_activation_cursor",
  });
  expect(await dispatcher.dispatch({ profile, detected: live })).toEqual({
    outcome: "dispatched",
    sinkProfile: "causal_openviking",
    replay: false,
  });
  expect(await dispatcher.dispatch({ profile, detected: live })).toEqual({
    outcome: "replayed",
    sinkProfile: "causal_openviking",
  });
  expect(openviking.deliveries).toEqual([]);
  expect(causal.deliveries).toHaveLength(1);
  expect(causal.deliveries[0]?.segment.segmentId).toBe(live.segmentId);
  expect(await admission.listAdmittedMessageIds("ws-a")).toEqual(new Set(["m-live"]));
});

test("off, provisioning, switching, and a stale generation do not ingest", async () => {
  const admission = createInMemoryWorkspaceMemoryAdmissionStore();
  const openviking = recordingSink();
  const causal = recordingSink();
  const dispatcher = createAdmissionDispatcher({
    admission,
    sinks: { openviking: openviking.sink, causal_openviking: causal.sink },
  });
  const live = liveDetected();
  const off = createDefaultWorkspaceMemoryProfile("ws-a");
  const provisioning = applyWorkspaceMemoryCommand(
    off,
    { type: "select_desired", desired: "openviking", at: activatedAt },
    enabled,
  );
  if (!provisioning.ok) throw new Error(provisioning.failure.code);

  expect(await dispatcher.dispatch({ profile: off, detected: live })).toEqual({
    outcome: "skipped",
    reason: "profile_off",
  });
  expect(
    await dispatcher.dispatch({
      profile: provisioning.profile,
      detected: live,
    }),
  ).toEqual({ outcome: "skipped", reason: "not_ready" });

  const ready = readyProfile("openviking");
  const switching = applyWorkspaceMemoryCommand(
    ready,
    {
      type: "select_desired",
      desired: "causal_openviking",
      at: new Date("2026-09-21T13:00:00.000Z"),
    },
    enabled,
  );
  if (!switching.ok) throw new Error(switching.failure.code);
  expect(await dispatcher.dispatch({ profile: switching.profile, detected: live })).toEqual({
    outcome: "skipped",
    reason: "not_ready",
  });

  expect(
    await dispatcher.dispatch({
      profile: ready,
      detected: live,
    }),
  ).toMatchObject({ outcome: "dispatched", sinkProfile: "openviking" });
  const stored = await admission.getSegment("ws-a", live.segmentId);
  expect(stored).not.toBeNull();
  const advanced = applyWorkspaceMemoryCommand(
    ready,
    {
      type: "select_desired",
      desired: "causal_openviking",
      at: new Date("2026-09-21T14:00:00.000Z"),
    },
    enabled,
  );
  if (!advanced.ok) throw new Error(advanced.failure.code);
  const readyNext = applyWorkspaceMemoryCommand(advanced.profile, {
    type: "observe_ready",
    generation: 2,
  });
  if (!readyNext.ok) throw new Error(readyNext.failure.code);
  expect(
    await dispatcher.dispatch({
      profile: readyNext.profile,
      detected: live,
      admitted: stored!,
    }),
  ).toEqual({ outcome: "skipped", reason: "stale_generation" });
  expect(openviking.deliveries).toHaveLength(1);
  expect(causal.deliveries).toEqual([]);
});

test("openviking and causal_openviking never share a segment", async () => {
  const admission = createInMemoryWorkspaceMemoryAdmissionStore();
  const openviking = recordingSink();
  const causal = recordingSink();
  const dispatcher = createAdmissionDispatcher({
    admission,
    sinks: { openviking: openviking.sink, causal_openviking: causal.sink },
  });
  const live = liveDetected();
  expect(
    await dispatcher.dispatch({ profile: readyProfile("openviking"), detected: live }),
  ).toMatchObject({ outcome: "dispatched", sinkProfile: "openviking" });
  expect(
    await dispatcher.dispatch({
      profile: readyProfile("causal_openviking"),
      detected: live,
    }),
  ).toEqual({ outcome: "skipped", reason: "replay_conflict" });
  expect(openviking.deliveries).toHaveLength(1);
  expect(causal.deliveries).toEqual([]);
});

test("the OpenViking sink is a native-session seam and the causal sink reuses ingest", async () => {
  const sessions: string[] = [];
  const ingested: string[] = [];
  const dispatcher = createAdmissionDispatcher({
    admission: createInMemoryWorkspaceMemoryAdmissionStore(),
    sinks: {
      openviking: createOpenVikingNativeSessionSink({
        async commitSession(delivery) {
          sessions.push(delivery.segment.segmentId);
        },
      }),
      causal_openviking: createCausalOpenVikingSink({
        async ingest(delivery) {
          ingested.push(delivery.segment.segmentId);
          return { state: "succeeded" };
        },
      }),
    },
  });
  const live = liveDetected();
  await dispatcher.dispatch({ profile: readyProfile("openviking"), detected: live });
  await dispatcher.dispatch({
    profile: readyProfile("causal_openviking", "ws-b"),
    detected: {
      ...live,
      workspace: { workspaceId: "ws-b", channelId: "ch-eng" },
    },
  });
  expect(sessions).toEqual([live.segmentId]);
  expect(ingested).toEqual([live.segmentId]);
});

test("a retryable sink failure keeps the segment and a later replay can deliver", async () => {
  const admission = createInMemoryWorkspaceMemoryAdmissionStore();
  let attempts = 0;
  const dispatcher = createAdmissionDispatcher({
    admission,
    sinks: {
      openviking: {
        async deliver() {
          attempts += 1;
          if (attempts === 1) {
            return {
              outcome: "retryable_failure",
              sanitizedError: "openviking native session unavailable",
            };
          }
          return { outcome: "delivered" };
        },
      },
      causal_openviking: {
        async deliver() {
          throw new Error("causal sink must stay unused");
        },
      },
    },
  });
  const live = liveDetected();
  const profile = readyProfile("openviking");
  expect(await dispatcher.dispatch({ profile, detected: live })).toEqual({
    outcome: "retryable_failure",
    sanitizedError: "openviking native session unavailable",
  });
  expect(await admission.getSegment("ws-a", live.segmentId)).not.toBeNull();
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
});
