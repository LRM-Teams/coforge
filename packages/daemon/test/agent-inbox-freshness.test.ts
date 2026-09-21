import { expect, test } from "bun:test";
import {
  HELD_SEND_AVAILABLE_ACTIONS,
  locallyHeldSend,
  planAgentInboxFreshness,
} from "../src/daemon-runtime/agent-inbox-freshness";

const base = {
  continueAnyway: false,
  modelSeenSequence: 0,
  pendingMessageCount: 0,
  latestSequence: 0,
};

test("an explicit --anyway short-circuits every hold, including one the daemon would take", () => {
  expect(
    planAgentInboxFreshness({
      continueAnyway: true,
      modelSeenSequence: 0,
      pendingMessageCount: 3,
      latestSequence: 9,
    }),
  ).toEqual({ decision: "bypass", reason: "continue_anyway" });
});

test("unreviewed messages on the exact target are held locally, with the count and frontier", () => {
  expect(
    planAgentInboxFreshness({
      ...base,
      modelSeenSequence: 4,
      pendingMessageCount: 2,
      latestSequence: 9,
    }),
  ).toEqual({
    decision: "local_hold",
    reason: "exact_target_pending",
    newMessageCount: 2,
    seenUpToSeq: 9,
  });
});

test("a target the Agent is caught up on forwards under Raft's model-seen-boundary reason", () => {
  expect(planAgentInboxFreshness({ ...base, modelSeenSequence: 7, latestSequence: 7 })).toEqual({
    decision: "forward",
    reason: "model_seen_boundary",
  });
});

test("a first touch forwards: the daemon has nothing to hold from, so the server decides", () => {
  // Deliberate: `syncing_hold` (`target_first_touch_recent_context`) is the server's call, because
  // only the server can see history the daemon was never delivered. Planning a hold here would
  // withhold sends the server would have forwarded.
  expect(planAgentInboxFreshness({ ...base, modelSeenSequence: 0, latestSequence: 12 })).toEqual({
    decision: "forward",
    reason: "no_exact_target_pending_or_recent_context",
  });
});

test("a target the daemon has never seen forwards", () => {
  expect(planAgentInboxFreshness(base)).toEqual({
    decision: "forward",
    reason: "no_exact_target_pending_or_recent_context",
  });
});

test("a locally held send is transport-shaped, counted, and terminal by construction", () => {
  const plan = planAgentInboxFreshness({
    ...base,
    modelSeenSequence: 1,
    pendingMessageCount: 3,
    latestSequence: 6,
  });
  if (plan.decision !== "local_hold") throw new Error("expected a hold");
  const held = locallyHeldSend(plan, { requestId: "send-1", draftReholdCount: 0 });
  expect(held.state).toBe("held");
  expect(held.decision).toBe("local_hold");
  expect(held.reason).toBe("exact_target_pending");
  expect(held.accepted).toBe(false);
  expect(held.attentionCount).toBe(3);
  expect(held.newMessageCount).toBe(3);
  expect(held.shownMessageCount).toBe(0);
  expect(held.omittedMessageCount).toBe(3);
  expect(held.messages).toEqual([]);
  expect(held.availableActions).toEqual([...HELD_SEND_AVAILABLE_ACTIONS]);
  // The daemon takes no message id: nothing was sent, so there is nothing to report.
  expect(held.messageId).toBeUndefined();
});

test("a draft that has already been held once is told it may be forced with --anyway", () => {
  const plan = planAgentInboxFreshness({ ...base, pendingMessageCount: 1, latestSequence: 2 });
  if (plan.decision !== "local_hold") throw new Error("expected a hold");
  expect(
    locallyHeldSend(plan, { requestId: "send-1", draftReholdCount: 0 }).continueAnywaySuggested,
  ).toBe(false);
  expect(
    locallyHeldSend(plan, { requestId: "send-2", draftReholdCount: 1 }).continueAnywaySuggested,
  ).toBe(true);
});

test("a withheld send keeps its mode so the caller reports a withheld count, not a window", () => {
  const plan = planAgentInboxFreshness({ ...base, pendingMessageCount: 2, latestSequence: 5 });
  if (plan.decision !== "local_hold") throw new Error("expected a hold");
  expect(
    locallyHeldSend(plan, {
      requestId: "send-3",
      draftReholdCount: 0,
      freshnessContextMode: "withheld",
    }).freshnessContextMode,
  ).toBe("withheld");
});
