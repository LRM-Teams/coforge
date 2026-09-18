import { expect, test } from "bun:test";
import type { AgentMessageDelivery } from "@lrm/coforge-sdk/internal";
import { AgentMessageAttentionIndex } from "../src/daemon-runtime/agent-message-attention-index";

const delivery = (id: string, latestSender?: string): AgentMessageDelivery => ({
  protocolMajor: 1,
  requestId: `request-${id}`,
  messageId: `message-${id}`,
  deliveryId: `delivery-${id}`,
  sequence: 1,
  workspaceId: "workspace-1",
  conversationId: "conversation-1",
  agentId: "agent-1",
  body: "private body",
  method: "agent:deliver",
  target: "@agent",
  latestSender,
});

const session = (notify: (notice: string) => void = () => {}) => ({
  sendMessage: async () => {},
  notify: async (notice: string) => {
    notify(notice);
  },
  subscribe: () => () => {},
  interrupt: async () => {},
  onExit: () => () => {},
  dispose: async () => {},
});
const runtime = { session: () => session() };

test("server-authored assignment attention preserves system identity", async () => {
  const notices: string[] = [];
  const index = new AgentMessageAttentionIndex(
    "workspace-1",
    {
      session: () => session((notice) => notices.push(notice)),
    },
    async () => {},
  );
  await index.receive({ ...delivery("assignment", "system"), target: "#general" });
  expect(index.check("agent-1")[0]).toMatchObject({ latestSender: "system", pendingCount: 1 });
  expect(notices[0]).toContain("latest sender system");
  expect(notices[0]).not.toContain("private body");
});

test("channel delivery and restart recovery notify the same session without injecting history", async () => {
  const notices: string[] = [];
  const shared = session((notice) => {
    notices.push(notice);
  });
  const index = new AgentMessageAttentionIndex(
    "workspace-1",
    { session: () => shared },
    async () => {},
  );
  const message = { ...delivery("channel", "@alice"), target: "#general", latestSender: "@alice" };
  await index.receive(message);
  expect(index.check("agent-1")).toEqual([
    expect.objectContaining({ target: "#general", flags: ["channel"] }),
  ]);
  expect(notices.join("\n")).not.toContain("private body");
  index.clearAgent("agent-1");
  await index.recover("agent-1", [message], { "#general": 1 });
  expect(notices.join("\n")).not.toContain("private body");
  expect(index.modelSeenSequence("agent-1", "#general")).toBe(0);
  expect(index.check("agent-1")[0]?.pendingCount).toBe(1);
  index.recordModelSeen("agent-1", "#general", 1);
  expect(index.check("agent-1")).toEqual([]);
});

test("thread attention counts sparse pending messages and preserves other targets", async () => {
  const notices: string[] = [];
  const sharedSession = session((notice) => {
    notices.push(notice);
  });
  const index = new AgentMessageAttentionIndex(
    "workspace-1",
    { session: () => sharedSession },
    async () => {},
  );
  for (const [id, sequence, target] of [
    ["a", 2, "@alice:12345678"],
    ["b", 9, "@alice:12345678"],
    ["c", 4, "@alice"],
    ["d", 7, "@alice:87654321"],
  ] as const)
    await index.receive({ ...delivery(id, "@alice"), sequence, target });
  index.recordModelSeen("agent-1", "@alice:12345678", 2);
  expect(index.check("agent-1")).toEqual([
    expect.objectContaining({
      target: "@alice:12345678",
      pendingCount: 1,
      firstPendingSequence: 9,
      flags: ["thread"],
    }),
    expect.objectContaining({ target: "@alice", pendingCount: 1 }),
    expect.objectContaining({ target: "@alice:87654321", pendingCount: 1 }),
  ]);
  expect(notices.join("\n")).not.toContain("private body");
});

test("updates attention, sends only a body-free notice, and ACKs takeover", async () => {
  const notices: string[] = [];
  const acks: string[] = [];
  const index = new AgentMessageAttentionIndex(
    "workspace-1",
    {
      session: () =>
        session((notice) => {
          notices.push(notice);
        }),
    },
    async (ack) => {
      acks.push(ack.deliveryId);
    },
  );

  await index.receive({ ...delivery("one", "@ada"), target: "@ada" });
  expect(index.check("agent-1")).toEqual([
    expect.objectContaining({ target: "@ada", pendingCount: 1, latestSender: "@ada" }),
  ]);
  expect(notices).toEqual([
    "[CoForge inbox notice:\nInbox update: 1 message waiting for you\n@ada  new: 1 message · latest sender @ada\nThese messages have not been read. Read them with `coforge message check`, or\n`coforge message read --target <target>`; leaving them unread does not establish that there is\nno work.]",
  ]);
  expect(notices[0]).not.toContain("private body");
  expect(acks).toEqual(["delivery-one"]);
});

test("duplicate delivery is not counted or noticed twice", async () => {
  let notices = 0;
  const index = new AgentMessageAttentionIndex(
    "workspace-1",
    {
      session: () =>
        session(() => {
          notices++;
        }),
    },
    async () => {},
  );
  await index.receive(delivery("one"));
  await index.receive(delivery("one"));
  expect(index.check("agent-1")[0]?.pendingCount).toBe(1);
  expect(notices).toBe(1);
});

test("a replacement session receives the same recovery IDs while duplicates stay deduplicated", async () => {
  const notices: string[] = [];
  const index = new AgentMessageAttentionIndex(
    "workspace-1",
    { session: () => session((notice) => notices.push(notice)) },
    async () => {},
  );
  const message = {
    messageId: "message-recovery",
    deliveryId: "delivery-recovery",
    conversationId: "conversation-1",
    sequence: 1,
    target: "@ada",
    latestSender: "@ada",
    body: "recover this body",
  };

  await index.recover("agent-1", [message], { "@ada": 1 });
  await index.recover("agent-1", [message], { "@ada": 1 });
  index.clearAgent("agent-1");
  await index.recover("agent-1", [message], { "@ada": 1 });

  expect(notices).toHaveLength(2);
  expect(notices.every((notice) => notice.includes("recover this body"))).toBe(true);
});

test("an old notification completion cannot mark a replacement generation notified", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let notices = 0;
  const acks: string[] = [];
  const index = new AgentMessageAttentionIndex(
    "workspace-1",
    {
      session: () => ({
        ...session(),
        notify: async () => {
          notices++;
          if (notices === 1) await gate;
        },
      }),
    },
    async (ack) => {
      acks.push(ack.deliveryId);
    },
  );

  const old = index.receive(delivery("one"));
  await Bun.sleep(0);
  index.clearAgent("agent-1");
  release();
  await old;
  expect(acks).toEqual([]);
  await index.receive(delivery("one"));

  expect(notices).toBe(2);
  expect(acks).toEqual(["delivery-one"]);
});

test("does not expose an internal sender user id", async () => {
  const internalUserId = "2c9d2c18-2a0b-4a95-9e5a-111111111111";
  const index = new AgentMessageAttentionIndex("workspace-1", runtime, async () => {});
  await index.receive(delivery("one", undefined));
  const attention = index.check("agent-1")[0]!;
  expect(attention.latestSender).toBeUndefined();
  expect(JSON.stringify(attention)).not.toContain(internalUserId);
});

test("does not ACK until notification succeeds", async () => {
  let release!: () => void;
  const acked: string[] = [];
  const index = new AgentMessageAttentionIndex(
    "workspace-1",
    { session: () => session(() => undefined) },
    async (ack) => {
      acked.push(ack.deliveryId);
    },
  );
  const notification = new Promise<void>((resolve) => (release = resolve));
  const pending = new AgentMessageAttentionIndex(
    "workspace-1",
    { session: () => ({ ...session(), notify: async () => notification }) },
    async (ack) => {
      acked.push(ack.deliveryId);
    },
  ).receive(delivery("delayed"));
  await Promise.resolve();
  expect(acked).toEqual([]);
  release();
  await pending;
  expect(acked).toEqual(["delivery-delayed"]);
  expect(index.check("agent-1")).toEqual([]);
});

test("notification failure and offline sessions do not ACK, but retries can recover", async () => {
  let online = false;
  let notifications = 0;
  const acks: string[] = [];
  const index = new AgentMessageAttentionIndex(
    "workspace-1",
    { session: () => (online ? session(() => void notifications++) : undefined) },
    async (ack) => {
      acks.push(ack.deliveryId);
    },
  );
  await expect(index.receive(delivery("recover"))).rejects.toThrow("wakeup");
  online = true;
  await index.receive(delivery("recover"));
  expect(notifications).toBe(1);
  expect(acks).toEqual(["delivery-recover"]);
});

test("ACK failure is retryable without repeating notification", async () => {
  let notifications = 0;
  let attempts = 0;
  const index = new AgentMessageAttentionIndex(
    "workspace-1",
    { session: () => session(() => void notifications++) },
    async () => {
      attempts++;
      if (attempts === 1) throw new Error("ack failed");
    },
  );
  await expect(index.receive(delivery("ack-retry"))).rejects.toThrow("ack failed");
  await index.receive(delivery("ack-retry"));
  expect(notifications).toBe(1);
  expect(attempts).toBe(2);
});

test("clearing attention consumes only one Agent target", async () => {
  const index = new AgentMessageAttentionIndex(
    "workspace-1",
    { session: () => session() },
    async () => {},
  );
  await index.receive({ ...delivery("ada"), target: "@ada", latestSender: "@ada" });
  await index.receive({ ...delivery("grace"), target: "@grace", latestSender: "@grace" });
  index.clear("agent-1", "@ada");
  expect(index.check("agent-1")).toEqual([
    {
      target: "@grace",
      pendingCount: 1,
      firstPendingSequence: 1,
      latestSequence: 1,
      latestSender: "@grace",
      flags: ["dm"],
    },
  ]);
});

test("clearing through a read boundary preserves concurrently newer attention", async () => {
  const index = new AgentMessageAttentionIndex(
    "workspace-1",
    { session: () => session(() => undefined) },
    async () => undefined,
  );
  await index.receive({ ...delivery("old"), sequence: 7 });
  await index.receive({ ...delivery("new"), deliveryId: "delivery-new", sequence: 8 });

  index.clearThrough("agent-1", "@alice", 7);

  expect(index.check("agent-1")).toMatchObject([{ latestSequence: 8 }]);
});

test("suppresses a delivery already visible to the model through its sequence cursor", async () => {
  let notices = 0;
  const acks: string[] = [];
  const index = new AgentMessageAttentionIndex(
    "workspace-1",
    { session: () => session(() => notices++) },
    async (ack) => {
      acks.push(ack.deliveryId);
    },
  );

  index.recordModelSeen("agent-1", "@ada", 7);
  await index.receive({ ...delivery("replayed"), target: "@ada", sequence: 7 });

  expect(index.check("agent-1")).toEqual([]);
  expect(notices).toBe(0);
  expect(acks).toEqual(["delivery-replayed"]);
  expect(index.modelSeenSequence("agent-1", "@ada")).toBe(7);
});

test("advances the model cursor while retaining newer attention", async () => {
  const index = new AgentMessageAttentionIndex(
    "workspace-1",
    { session: () => session() },
    async () => {},
  );
  await index.receive({ ...delivery("old"), target: "@ada", sequence: 7 });
  await index.receive({ ...delivery("new"), target: "@ada", sequence: 8 });

  index.recordModelSeen("agent-1", "@ada", 7);

  expect(index.modelSeenSequence("agent-1", "@ada")).toBe(7);
  expect(index.check("agent-1")).toMatchObject([
    { target: "@ada", pendingCount: 1, firstPendingSequence: 8, latestSequence: 8 },
  ]);
});

test("recovery directs every target with messages beyond the batch to canonical unread", async () => {
  const notices: string[] = [];
  const index = new AgentMessageAttentionIndex(
    "workspace-1",
    { session: () => session((notice) => notices.push(notice)) },
    async () => {},
  );

  await index.recover(
    "agent-1",
    [
      {
        messageId: "message-1",
        deliveryId: "delivery-1",
        conversationId: "conversation-1",
        sequence: 1,
        target: "@ada",
        latestSender: "@ada",
        body: "Please resume this work",
      },
    ],
    { "@ada": 2, "@grace": 1 },
  );

  expect(notices).toHaveLength(1);
  expect(notices[0]).toContain("New message received:");
  expect(notices[0]).toContain("[target=@ada msg=message- seq=1] @ada: Please resume this work");
  expect(notices[0]).toContain("Respond as appropriate. Complete all your work before stopping.");
  expect(notices[0]).toContain(
    "Run `coforge message read --target @ada` to read additional messages.",
  );
  expect(notices[0]).toContain("run `coforge message read --target @grace` to read them.");
  expect(index.modelSeenSequence("agent-1", "@ada")).toBe(1);
});

test("recover also marks busy — it is a session.notify call like any other (ADR 0048)", async () => {
  const queue = heldQueue();
  const index = new AgentMessageAttentionIndex(
    "workspace-1",
    { session: () => session() },
    async () => {},
    () => {},
    queue.hold,
  );

  await index.recover(
    "agent-1",
    [
      {
        messageId: "message-1",
        deliveryId: "delivery-1",
        conversationId: "conversation-1",
        sequence: 1,
        target: "@ada",
        latestSender: "@ada",
        body: "Please resume this work",
      },
    ],
    {},
  );

  expect(queue.busyCalls).toEqual(["agent-1"]);
});

test("recovery rejected by the model remains unseen and retryable", async () => {
  let reject = true;
  const notices: string[] = [];
  const index = new AgentMessageAttentionIndex(
    "workspace-1",
    {
      session: () => ({
        ...session(),
        notify: async (notice: string) => {
          notices.push(notice);
          if (reject) throw new Error("model rejected recovery");
        },
      }),
    },
    async () => {},
  );
  const message = {
    messageId: "message-retry",
    deliveryId: "delivery-retry",
    conversationId: "conversation-1",
    sequence: 3,
    target: "@ada",
    latestSender: "@ada",
    body: "Retry this recovery",
  };

  await expect(index.recover("agent-1", [message], { "@ada": 1 })).rejects.toThrow(
    "model rejected recovery",
  );
  expect(index.modelSeenSequence("agent-1", "@ada")).toBe(0);
  expect(index.check("agent-1")).toEqual([]);
  reject = false;
  await index.recover("agent-1", [message], { "@ada": 1 });
  expect(notices).toHaveLength(2);
  expect(index.modelSeenSequence("agent-1", "@ada")).toBe(3);
});

test("forgets the oldest deliveries so a long-lived Agent does not grow without bound", async () => {
  let notices = 0;
  const index = new AgentMessageAttentionIndex(
    "workspace-1",
    { session: () => session(() => notices++) },
    async () => {},
  );
  const remembered = 4096;
  for (let i = 1; i <= remembered + 1; i++)
    await index.receive({ ...delivery(String(i)), sequence: i });
  expect(notices).toBe(remembered + 1);

  // The newest delivery is still remembered: a redelivery acks without a new notice.
  await index.receive({ ...delivery(String(remembered + 1)), sequence: remembered + 1 });
  expect(notices).toBe(remembered + 1);

  // The oldest one was forgotten: its redelivery is treated as new.
  await index.receive({ ...delivery("1"), sequence: 1 });
  expect(notices).toBe(remembered + 2);
});

test("recordReadContext tracks a monotonically increasing per-Agent read order", () => {
  const index = new AgentMessageAttentionIndex(
    "workspace-1",
    { session: () => session() },
    async () => {},
  );
  expect(index.readOrder("agent-1", "#general")).toBeUndefined();
  index.recordReadContext("agent-1", "#general");
  const first = index.readOrder("agent-1", "#general");
  expect(first).toBeDefined();
  index.recordReadContext("agent-1", "#general:11111111");
  const second = index.readOrder("agent-1", "#general:11111111");
  expect(second).toBeDefined();
  expect(second!).toBeGreaterThan(first!);
});

test("latestThreadReadUnderParent finds the most recently read thread rooted under a parent", () => {
  const index = new AgentMessageAttentionIndex(
    "workspace-1",
    { session: () => session() },
    async () => {},
  );
  expect(index.latestThreadReadUnderParent("agent-1", "#general")).toBeUndefined();
  index.recordReadContext("agent-1", "#general:11111111");
  index.recordReadContext("agent-1", "#other:22222222");
  index.recordReadContext("agent-1", "#general:33333333");
  const latest = index.latestThreadReadUnderParent("agent-1", "#general");
  expect(latest?.target).toBe("#general:33333333");
  // A read of the parent target itself is not a thread read under it.
  index.recordReadContext("agent-1", "#general");
  expect(index.latestThreadReadUnderParent("agent-1", "#general")?.target).toBe(
    "#general:33333333",
  );
});

// ADR 0048: a fake `hold` collaborator standing in for `AgentDeliveryQueue`, matching the seam
// `AgentMessageAttentionIndex`'s constructor consumes (`shouldHold`/`enqueue`/`busy`) and what
// `flush` expects back (the drained list).
function heldQueue() {
  const held: AgentMessageDelivery[] = [];
  let holding = false;
  const busyCalls: string[] = [];
  return {
    setHolding: (value: boolean) => (holding = value),
    drain: () => held.splice(0),
    busyCalls,
    hold: {
      shouldHold: () => holding,
      enqueue: (_agentId: string, message: AgentMessageDelivery) => held.push(message),
      busy: (agentId: string) => busyCalls.push(agentId),
    },
  };
}

test("a held delivery updates attention but does not notify or ACK until flush", async () => {
  const notices: string[] = [];
  const acks: string[] = [];
  const queue = heldQueue();
  const index = new AgentMessageAttentionIndex(
    "workspace-1",
    { session: () => session((notice) => notices.push(notice)) },
    async (ack) => {
      acks.push(ack.deliveryId);
    },
    () => {},
    queue.hold,
  );

  queue.setHolding(true);
  await index.receive(delivery("one"));
  await index.receive({ ...delivery("two"), sequence: 2 });
  expect(index.check("agent-1")[0]).toMatchObject({ pendingCount: 2 });
  expect(notices).toEqual([]);
  expect(acks).toEqual([]);

  const held = queue.drain();
  expect(held.map((message) => message.deliveryId)).toEqual(["delivery-one", "delivery-two"]);
  await index.flush("agent-1", held);
  expect(notices).toHaveLength(1);
  expect(notices[0]).toContain("Inbox update: 2 messages waiting for you");
  expect(notices[0]).toContain("new: 2 messages");
  expect(acks).toEqual(["delivery-one", "delivery-two"]);
});

test("flush is a no-op when nothing was held", async () => {
  const notices: string[] = [];
  const index = new AgentMessageAttentionIndex(
    "workspace-1",
    { session: () => session((notice) => notices.push(notice)) },
    async () => {},
  );
  await index.flush("agent-1", []);
  expect(notices).toEqual([]);
});

test("receive marks busy synchronously, before the session accepts the notice it sends", async () => {
  const queue = heldQueue();
  let releaseNotify!: () => void;
  const gate = new Promise<void>((resolve) => (releaseNotify = resolve));
  const index = new AgentMessageAttentionIndex(
    "workspace-1",
    { session: () => ({ ...session(), notify: async () => gate }) },
    async () => {},
    () => {},
    queue.hold,
  );

  // Not held (queue.setHolding was never called), so this delivers immediately: `#notify` marks
  // busy before its own `session.notify()` call has even resolved. A second delivery decided
  // upon in this same tick — before the runtime has emitted any event of its own — must already
  // see the Agent as busy (ADR 0048); this is what `receive`'s pre-existing serialized draining
  // guarantees, and what this assertion protects.
  const receiving = index.receive(delivery("one"));
  expect(queue.busyCalls).toEqual(["agent-1"]);
  releaseNotify();
  await receiving;
});

test("flush also marks busy synchronously, before the coalesced notice it sends resolves", async () => {
  const queue = heldQueue();
  let releaseNotify!: () => void;
  const gate = new Promise<void>((resolve) => (releaseNotify = resolve));
  const index = new AgentMessageAttentionIndex(
    "workspace-1",
    { session: () => ({ ...session(), notify: async () => gate }) },
    async () => {},
    () => {},
    queue.hold,
  );

  const flushing = index.flush("agent-1", [delivery("one")]);
  expect(queue.busyCalls).toEqual(["agent-1"]);
  releaseNotify();
  await flushing;
});

test("a not-yet-notified resend while held stays held instead of notifying again", async () => {
  const notices: string[] = [];
  const queue = heldQueue();
  const index = new AgentMessageAttentionIndex(
    "workspace-1",
    { session: () => session((notice) => notices.push(notice)) },
    async () => {},
    () => {},
    queue.hold,
  );

  queue.setHolding(true);
  await index.receive(delivery("one"));
  await index.receive(delivery("one"));
  expect(notices).toEqual([]);
  const held = queue.drain();
  expect(held).toHaveLength(2);
  await index.flush("agent-1", held);
  expect(notices).toHaveLength(1);
});

test("clearAgent forgets an Agent's read-context state", () => {
  const index = new AgentMessageAttentionIndex(
    "workspace-1",
    { session: () => session() },
    async () => {},
  );
  index.recordReadContext("agent-1", "#general:11111111");
  index.clearAgent("agent-1");
  expect(index.readOrder("agent-1", "#general:11111111")).toBeUndefined();
  expect(index.latestThreadReadUnderParent("agent-1", "#general")).toBeUndefined();
});

/**
 * The notice counts messages the daemon is holding — this delivery, plus whatever is still
 * queued for the Agent — and never a per-target total accumulated across earlier notices. A
 * count that outlives the notice is a second source of truth about "is there mail", and it used
 * to keep growing against a server that had already handed everything over, so the Agent was
 * told to run `check` and got nothing back (see the empty-drain case below).
 */
test("a later delivery is announced on its own, not added to an earlier notice's count", async () => {
  const notices: string[] = [];
  const index = new AgentMessageAttentionIndex(
    "workspace-1",
    { session: () => session((notice) => notices.push(notice)) },
    async () => {},
  );

  await index.receive({ ...delivery("first", "@ada"), sequence: 1, target: "#general" });
  await index.receive({ ...delivery("second", "@ada"), sequence: 2, target: "#general" });

  expect(notices).toHaveLength(2);
  for (const notice of notices) {
    expect(notice).toContain("Inbox update: 1 message waiting for you");
    expect(notice).toContain("#general  new: 1 message");
  }
});

test("the notice's total includes deliveries still queued for a busy Agent", async () => {
  const notices: string[] = [];
  const index = new AgentMessageAttentionIndex(
    "workspace-1",
    { session: () => session((notice) => notices.push(notice)) },
    async () => {},
    () => {},
    {
      shouldHold: () => false,
      enqueue: () => {},
      busy: () => {},
      queuedCount: () => 2,
    },
  );

  await index.receive({ ...delivery("with-queue", "@ada"), target: "#general" });

  expect(notices[0]).toContain("Inbox update: 3 messages waiting for you");
  expect(notices[0]).toContain("#general  new: 1 message");
});

test("a notice never promises what `coforge message check` will return", async () => {
  const notices: string[] = [];
  const index = new AgentMessageAttentionIndex(
    "workspace-1",
    { session: () => session((notice) => notices.push(notice)) },
    async () => {},
  );

  await index.receive({ ...delivery("wording"), target: "#general" });

  // The old wording ("Run `coforge message check` to read pending messages") read as a
  // guarantee, so an empty drain looked like a lost message rather than an already-read one.
  expect(notices[0]).not.toContain("to read pending messages");
  expect(notices[0]).toContain("leaving them unread does not establish that there is");
});
