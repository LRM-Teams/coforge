import { expect, test } from "bun:test";
import {
  createAdmissionDispatcher,
  createInMemoryWorkspaceMemoryAdmissionStore,
  createOpenVikingNativeSessionSink,
  type AdmissionSink,
  type AdmissionSinkDelivery,
} from "./dispatch";
import { detectAdmittedPublicChannelSegments } from "./detect-segments";
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
  const dispatcher = createAdmissionDispatcher({
    admission,
    sinks: { openviking: openviking.sink },
  });
  const profile = readyProfile();
  const historical = liveDetected({ closedAt: new Date("2026-09-21T11:00:00.000Z") });
  const live = liveDetected();

  expect(await dispatcher.dispatch({ profile, detected: historical })).toEqual({
    outcome: "skipped",
    reason: "before_activation_cursor",
  });
  expect(await dispatcher.dispatch({ profile, detected: live })).toEqual({
    outcome: "dispatched",
    sinkProfile: "openviking",
    replay: false,
  });
  expect(await dispatcher.dispatch({ profile, detected: live })).toEqual({
    outcome: "replayed",
    sinkProfile: "openviking",
  });
  expect(openviking.deliveries).toHaveLength(1);
  expect(openviking.deliveries[0]?.segment.segmentId).toBe(live.segmentId);
  expect(await admission.listAdmittedMessageIds("ws-a")).toEqual(new Set(["m-live"]));
});

test("off, provisioning, switching, and a stale generation do not ingest", async () => {
  const admission = createInMemoryWorkspaceMemoryAdmissionStore();
  const openviking = recordingSink();
  const dispatcher = createAdmissionDispatcher({
    admission,
    sinks: { openviking: openviking.sink },
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

  const ready = readyProfile();
  const switching = applyWorkspaceMemoryCommand(ready, {
    type: "select_desired",
    desired: "off",
    at: new Date("2026-09-21T13:00:00.000Z"),
  });
  if (!switching.ok) throw new Error(switching.failure.code);
  expect(await dispatcher.dispatch({ profile: switching.profile, detected: live })).toEqual({
    outcome: "skipped",
    reason: "profile_off",
  });
  expect(
    await dispatcher.dispatch({
      profile: { ...ready, observed: "switching", generation: ready.generation + 1 },
      detected: live,
    }),
  ).toEqual({ outcome: "skipped", reason: "not_ready" });

  expect(
    await dispatcher.dispatch({
      profile: ready,
      detected: live,
    }),
  ).toMatchObject({ outcome: "dispatched", sinkProfile: "openviking" });
  const stored = await admission.getSegment("ws-a", live.segmentId);
  expect(stored).not.toBeNull();
  expect(
    await dispatcher.dispatch({
      profile: { ...ready, generation: ready.generation + 1 },
      detected: live,
      admitted: stored!,
    }),
  ).toEqual({ outcome: "skipped", reason: "stale_generation" });
  expect(openviking.deliveries).toHaveLength(1);
});

test("the OpenViking sink is a native-session seam", async () => {
  const sessions: string[] = [];
  const dispatcher = createAdmissionDispatcher({
    admission: createInMemoryWorkspaceMemoryAdmissionStore(),
    sinks: {
      openviking: createOpenVikingNativeSessionSink({
        async commitSession(delivery) {
          sessions.push(delivery.segment.segmentId);
        },
      }),
    },
  });
  const live = liveDetected();
  await dispatcher.dispatch({ profile: readyProfile(), detected: live });
  expect(sessions).toEqual([live.segmentId]);
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
    },
  });
  const live = liveDetected();
  const profile = readyProfile();
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
