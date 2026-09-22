import { expect, test } from "bun:test";
import {
  canAdmitSegment,
  decodeAdmittedPublicChannelSegment,
  isAfterActivationCursor,
} from "./admission";
import { applyWorkspaceMemoryCommand, createDefaultWorkspaceMemoryProfile } from "./profile";

const activatedAt = new Date("2026-09-21T12:00:00.000Z");
const enabled = { prototypeEnabled: true };

function readyOpenviking() {
  const selected = applyWorkspaceMemoryCommand(
    createDefaultWorkspaceMemoryProfile("ws-a"),
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

function segment(overrides: Record<string, unknown> = {}) {
  return {
    segmentId: "seg-1",
    sourceMessageIds: ["m-1", "m-2"],
    workspace: { workspaceId: "ws-a", channelId: "ch-eng" },
    kind: "quiet_window",
    conversationKind: "public_channel",
    sourcePayloadHash: "sha256:abc",
    profileGeneration: 1,
    closedAt: "2026-09-21T12:05:00.000Z",
    ...overrides,
  };
}

test("an admitted segment keeps immutable source lineage and Workspace metadata", () => {
  const decoded = decodeAdmittedPublicChannelSegment(segment());
  expect("segmentId" in decoded && decoded.segmentId === "seg-1").toBe(true);
  if ("code" in decoded) throw new Error(decoded.code);
  expect(decoded.sourceMessageIds).toEqual(["m-1", "m-2"]);
  expect(Object.isFrozen(decoded.sourceMessageIds)).toBe(true);
  expect(Object.isFrozen(decoded.workspace)).toBe(true);
  expect(decoded.workspace).toEqual({ workspaceId: "ws-a", channelId: "ch-eng" });
  expect(decoded.profileGeneration).toBe(1);
  expect(() => {
    (decoded.sourceMessageIds as string[]).push("m-3");
  }).toThrow();
});

test("DirectConversation and incomplete lineage never become admitted segments", () => {
  expect(
    decodeAdmittedPublicChannelSegment(segment({ conversationKind: "direct_conversation" })),
  ).toEqual({
    code: "invalid_segment",
    message: "admitted segment is invalid",
  });
  expect(decodeAdmittedPublicChannelSegment(segment({ sourceMessageIds: [] }))).toEqual({
    code: "invalid_segment",
    message: "admitted segment is invalid",
  });
  expect(
    decodeAdmittedPublicChannelSegment(segment({ workspace: { workspaceId: "ws-a" } })),
  ).toEqual({
    code: "invalid_segment",
    message: "admitted segment is invalid",
  });
  expect(decodeAdmittedPublicChannelSegment(segment({ kind: "every_message" }))).toEqual({
    code: "invalid_segment",
    message: "admitted segment is invalid",
  });
});

test("activating openviking does not admit PublicChannel history at or before the activation cursor", () => {
  const profile = readyOpenviking();
  const cursor = profile.activationCursor;
  expect(cursor).toEqual({
    kind: "message",
    occurredAt: activatedAt.toISOString(),
    messageId: "msg-boundary",
  });
  expect(isAfterActivationCursor(cursor, activatedAt.toISOString())).toBe(false);
  expect(isAfterActivationCursor(cursor, "2026-09-21T11:59:59.000Z")).toBe(false);
  expect(isAfterActivationCursor(cursor, "2026-09-21T12:00:01.000Z")).toBe(true);

  const historical = decodeAdmittedPublicChannelSegment(
    segment({ closedAt: "2026-09-21T11:00:00.000Z" }),
  );
  const live = decodeAdmittedPublicChannelSegment(segment());
  if ("code" in historical || "code" in live) throw new Error("segment should decode");
  expect(canAdmitSegment(profile, historical)).toEqual({
    admit: false,
    reason: "before_activation_cursor",
  });
  expect(canAdmitSegment(profile, live)).toEqual({ admit: true });
});

test("off, provisioning, and a stale segment generation do not ingest", () => {
  const off = createDefaultWorkspaceMemoryProfile("ws-a");
  const provisioning = applyWorkspaceMemoryCommand(
    off,
    { type: "select_desired", desired: "openviking", at: activatedAt },
    enabled,
  );
  if (!provisioning.ok) throw new Error(provisioning.failure.code);
  const live = decodeAdmittedPublicChannelSegment(segment({ profileGeneration: 0 }));
  if ("code" in live) throw new Error("segment should decode");
  expect(canAdmitSegment(off, live)).toEqual({ admit: false, reason: "profile_off" });
  expect(canAdmitSegment(provisioning.profile, { ...live, profileGeneration: 1 })).toEqual({
    admit: false,
    reason: "not_ready",
  });

  const ready = applyWorkspaceMemoryCommand(provisioning.profile, {
    type: "observe_ready",
    generation: 1,
  });
  if (!ready.ok) throw new Error(ready.failure.code);
  expect(canAdmitSegment(ready.profile, live)).toEqual({
    admit: false,
    reason: "stale_generation",
  });
});
