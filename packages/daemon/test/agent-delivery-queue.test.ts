import { expect, test } from "bun:test";
import type { AgentMessageDelivery } from "@lrm/coforge-sdk/internal";
import { AgentDeliveryQueue } from "../src/daemon-runtime/agent-delivery-queue";

const delivery = (id: string): AgentMessageDelivery => ({
  protocolMajor: 1,
  requestId: `request-${id}`,
  messageId: `message-${id}`,
  deliveryId: `delivery-${id}`,
  sequence: 1,
  workspaceId: "workspace-1",
  conversationId: "conversation-1",
  agentId: "agent-1",
  body: "body",
  method: "agent:deliver",
  target: "@ada",
});

test("a queue_until_idle provider only holds while busy", () => {
  const queue = new AgentDeliveryQueue();
  queue.setProvider("agent-1", "kiro");
  expect(queue.shouldHold("agent-1")).toBe(false);
  queue.busy("agent-1");
  expect(queue.shouldHold("agent-1")).toBe(true);
  const held = queue.idle("agent-1");
  expect(held).toEqual([]);
  expect(queue.shouldHold("agent-1")).toBe(false);
});

test("a steer provider never holds, even while busy", () => {
  const queue = new AgentDeliveryQueue();
  for (const provider of ["pi", "codex", "claude-code", "cursor", "coforge"] as const) {
    queue.setProvider("agent-1", provider);
    queue.busy("agent-1");
    expect(queue.shouldHold("agent-1")).toBe(false);
    queue.idle("agent-1");
  }
});

test("idle drains everything enqueued while busy, oldest first", () => {
  const queue = new AgentDeliveryQueue();
  queue.setProvider("agent-1", "kiro");
  queue.busy("agent-1");
  queue.enqueue("agent-1", delivery("one"));
  queue.enqueue("agent-1", delivery("two"));
  expect(queue.hasQueued("agent-1")).toBe(true);
  expect(queue.pending("agent-1").map((message) => message.deliveryId)).toEqual([
    "delivery-one",
    "delivery-two",
  ]);
  const held = queue.idle("agent-1");
  expect(held.map((message) => message.deliveryId)).toEqual(["delivery-one", "delivery-two"]);
  expect(queue.hasQueued("agent-1")).toBe(false);
  expect(queue.pending("agent-1")).toEqual([]);
});

test("an explicit hold gates delivery independent of busy/idle and blocks idle draining", () => {
  const queue = new AgentDeliveryQueue();
  queue.setProvider("agent-1", "pi");
  expect(queue.shouldHold("agent-1")).toBe(false);
  queue.hold("agent-1", Date.now() + 60_000);
  expect(queue.shouldHold("agent-1")).toBe(true);
  queue.enqueue("agent-1", delivery("one"));
  // Idle would ordinarily drain; the explicit hold keeps it queued.
  expect(queue.idle("agent-1")).toEqual([]);
  expect(queue.hasQueued("agent-1")).toBe(true);
  const held = queue.release("agent-1");
  expect(held.map((message) => message.deliveryId)).toEqual(["delivery-one"]);
  expect(queue.shouldHold("agent-1")).toBe(false);
});

test("release while still busy clears the explicit hold but does not drain", () => {
  const queue = new AgentDeliveryQueue();
  queue.setProvider("agent-1", "kiro");
  queue.busy("agent-1");
  queue.hold("agent-1");
  queue.enqueue("agent-1", delivery("one"));
  const released = queue.release("agent-1");
  expect(released).toEqual([]);
  // The explicit hold is gone, but busy-gating for the queue_until_idle provider still holds.
  expect(queue.shouldHold("agent-1")).toBe(true);
  expect(queue.hasQueued("agent-1")).toBe(true);
});

test("an unexpected process exit clears busy but keeps what was held for the next launch", () => {
  const queue = new AgentDeliveryQueue();
  queue.setProvider("agent-1", "kiro");
  queue.busy("agent-1");
  queue.enqueue("agent-1", delivery("one"));
  queue.onProcessExit("agent-1");
  expect(queue.hasQueued("agent-1")).toBe(true);
  expect(queue.pending("agent-1").map((message) => message.deliveryId)).toEqual(["delivery-one"]);
  // The next launch starts idle: nothing is held back by busy-gating any more.
  expect(queue.shouldHold("agent-1")).toBe(false);
});

test("an explicit Stop discards everything held, unlike an unexpected exit", () => {
  const queue = new AgentDeliveryQueue();
  queue.setProvider("agent-1", "kiro");
  queue.busy("agent-1");
  queue.enqueue("agent-1", delivery("one"));
  queue.clearAgent("agent-1");
  expect(queue.hasQueued("agent-1")).toBe(false);
  expect(queue.pending("agent-1")).toEqual([]);
  expect(queue.shouldHold("agent-1")).toBe(false);
});

test("discardPending unconditionally drains, ignoring busy and an explicit hold", () => {
  const queue = new AgentDeliveryQueue();
  queue.setProvider("agent-1", "kiro");
  queue.busy("agent-1");
  queue.hold("agent-1");
  queue.enqueue("agent-1", delivery("one"));
  queue.enqueue("agent-1", delivery("two"));
  const dropped = queue.discardPending("agent-1");
  expect(dropped.map((message) => message.deliveryId)).toEqual(["delivery-one", "delivery-two"]);
  expect(queue.hasQueued("agent-1")).toBe(false);
  // Both the busy gate and the explicit hold are untouched — only the held list was drained.
  expect(queue.shouldHold("agent-1")).toBe(true);
});

test("holdAppItem/releaseAppItems track app-item ids separately from the message queue", () => {
  const queue = new AgentDeliveryQueue();
  queue.setProvider("agent-1", "kiro");
  queue.holdAppItem("agent-1", "item-1");
  queue.holdAppItem("agent-1", "item-2");
  // Re-holding the same id is idempotent.
  queue.holdAppItem("agent-1", "item-1");
  expect(queue.releaseAppItems("agent-1").sort()).toEqual(["item-1", "item-2"]);
  // Draining clears it.
  expect(queue.releaseAppItems("agent-1")).toEqual([]);
  // Never affects the message-delivery held list.
  expect(queue.hasQueued("agent-1")).toBe(false);
});

test("an unexpected exit keeps held app items; explicit Stop discards them", () => {
  const queue = new AgentDeliveryQueue();
  queue.setProvider("agent-1", "kiro");
  queue.holdAppItem("agent-1", "item-1");
  queue.onProcessExit("agent-1");
  expect(queue.releaseAppItems("agent-1")).toEqual(["item-1"]);

  queue.holdAppItem("agent-1", "item-2");
  queue.clearAgent("agent-1");
  expect(queue.releaseAppItems("agent-1")).toEqual([]);
});

test("per-Agent state is independent", () => {
  const queue = new AgentDeliveryQueue();
  queue.setProvider("agent-1", "kiro");
  queue.setProvider("agent-2", "kiro");
  queue.busy("agent-1");
  queue.enqueue("agent-1", delivery("one"));
  expect(queue.shouldHold("agent-2")).toBe(false);
  expect(queue.hasQueued("agent-2")).toBe(false);
});
