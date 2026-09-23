import { expect, test } from "bun:test";
import {
  heldFreshnessActivity,
  heldFreshnessMessageCount,
} from "#src/daemon-runtime/agent-inbox-freshness-activity";
import { stableNormalizeFreshnessFact, freshnessDecisionFactId } from "@lrm/coforge-sdk/internal";

test("a held send narrates Raft's working status row, title, count line and decision line", () => {
  expect(
    heldFreshnessActivity({
      action: "send",
      decision: "local_hold",
      target: "@ada",
      messageCount: 2,
      producerFactId: "freshness_decision_fact:abc",
    }),
  ).toEqual({
    activityKind: "working",
    detailKind: "freshness_hold",
    detail: "Send held by freshness check",
    entries: [
      {
        kind: "system",
        title: "Send held by freshness check",
        text: [
          "target: @ada",
          "new messages: 2 newer messages",
          "decision: local hold; review the newer context before retrying",
        ].join("\n"),
      },
    ],
    producerFactId: "freshness_decision_fact:abc",
  });
});

test("a single message is counted in the singular, as Raft's notice does", () => {
  const activity = heldFreshnessActivity({
    action: "send",
    decision: "local_hold",
    target: "#general",
    messageCount: 1,
    producerFactId: "freshness_decision_fact:abc",
  });
  expect(activity.entries[0]).toMatchObject({
    text: expect.stringContaining("new messages: 1 newer message"),
  });
});

test("a syncing hold uses Raft's own synced-context wording and both decision lines", () => {
  const activity = heldFreshnessActivity({
    action: "send",
    decision: "syncing_hold",
    target: "@ada",
    messageCount: 3,
    producerFactId: "freshness_decision_fact:abc",
  });
  expect(activity.entries[0]?.kind).toBe("system");
  expect(activity.entries[0]?.kind === "system" ? activity.entries[0].text : "").toBe(
    [
      "target: @ada",
      "unreviewed synced context for this target: 3 messages",
      "reason: this target's latest synced context was not yet in your reviewed context",
      "action: review the synced context before sending",
    ].join("\n"),
  );
});

test("a local hold counts what is pending; a syncing hold counts what it showed", () => {
  expect(
    heldFreshnessMessageCount({ decision: "local_hold", newMessageCount: 5, shownMessageCount: 3 }),
  ).toBe(5);
  expect(heldFreshnessMessageCount({ decision: "local_hold", shownMessageCount: 3 })).toBe(3);
  expect(
    heldFreshnessMessageCount({
      decision: "syncing_hold",
      newMessageCount: 5,
      shownMessageCount: 3,
    }),
  ).toBe(3);
  expect(heldFreshnessMessageCount({ decision: "syncing_hold", newMessageCount: 5 })).toBe(5);
});

test("the shared fact id sorts keys recursively and hashes the full stable input", async () => {
  expect(stableNormalizeFreshnessFact({ b: 1, a: { d: 2, c: undefined } })).toEqual({
    a: { d: 2 },
    b: 1,
  });
  const first = await freshnessDecisionFactId({
    agentId: "agent-a",
    decision: "local_hold",
    reason: "exact_target_pending",
    target: "@ada",
    pendingMaxSeq: 9,
    heldMessageCount: 3,
    omittedMessageCount: 1,
  });
  // Full sha256 hex, and the same decision always yields the same id.
  expect(first).toMatch(/^freshness_decision_fact:[0-9a-f]{64}$/);
  expect(
    await freshnessDecisionFactId({
      agentId: "agent-a",
      action: "send",
      decision: "local_hold",
      reason: "exact_target_pending",
      target: "@ada",
      pendingMaxSeq: 9,
      heldMessageCount: 3,
      omittedMessageCount: 1,
    }),
  ).toBe(first);
  // A different Agent never shares a fact id with the same decision.
  expect(
    await freshnessDecisionFactId({
      agentId: "agent-b",
      decision: "local_hold",
      reason: "exact_target_pending",
      target: "@ada",
      pendingMaxSeq: 9,
      heldMessageCount: 3,
      omittedMessageCount: 1,
    }),
  ).not.toBe(first);
});
