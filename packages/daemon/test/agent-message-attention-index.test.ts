import { expect, test } from "bun:test";
import type { AgentMessageDelivery } from "@coforge/protocol";
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
    "[CoForge inbox notice:\nInbox update: 1 unread message total; 1 changed target\n@ada  pending: 1 message · latest sender @ada\nRun `coforge message check` to read pending messages.]",
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
