import { expect, test } from "bun:test";
import {
  AgentMentionDeliveryTerminalErrorSchema,
  AgentMentionDeliveryTransitionSchema,
  AgentMessageDeliveryAckSchema,
  AgentMessageDeliverySchema,
  MentionDeliveryEnvelopeSchema,
} from "#src/internal/gen/coforge/rpc/v1/workspace_pb";
import {
  AGENT_MENTION_DELIVERY_TERMINAL_ERROR_METHOD,
  AGENT_MENTION_DELIVERY_TRANSITION_METHOD,
  AGENT_MESSAGE_ACK_METHOD,
  AGENT_MESSAGE_METHOD,
  MENTION_DELIVERY_TERMINAL_CODES,
  decodeAgentMentionDeliveryTerminalError,
  decodeAgentMentionDeliveryTransition,
  decodeAgentMessageDelivery,
  decodeAgentMessageDeliveryAck,
  encodeAgentMentionDeliveryTerminalError,
  encodeAgentMentionDeliveryTransition,
  encodeAgentMessageDelivery,
  encodeAgentMessageDeliveryAck,
} from "./index";

const envelope = {
  messageId: "message-a",
  launchId: "launch-a",
  sessionId: "native-session-a",
  computerId: "computer-a",
};

function delivery() {
  return {
    protocolMajor: 1,
    requestId: "request-a",
    messageId: "message-a",
    deliveryId: "delivery-a",
    sequence: 42,
    workspaceId: "workspace-a",
    conversationId: "conversation-a",
    agentId: "agent-a",
    body: "@bob please look",
    method: AGENT_MESSAGE_METHOD,
    mentionsAgent: true,
  } as const;
}

function ack() {
  return {
    protocolMajor: 1,
    requestId: "request-a",
    messageId: "message-a",
    deliveryId: "delivery-a",
    workspaceId: "workspace-a",
    agentId: "agent-a",
    sequence: 42,
    method: AGENT_MESSAGE_ACK_METHOD,
  } as const;
}

test("a tracked delivery carries its mention envelope to the daemon", () => {
  const tracked = { ...delivery(), mentionDelivery: envelope };
  expect(decodeAgentMessageDelivery(encodeAgentMessageDelivery(tracked))).toEqual(tracked);
});

test("an untracked delivery decodes without an envelope", () => {
  const decoded = decodeAgentMessageDelivery(encodeAgentMessageDelivery(delivery()));
  expect(decoded).toEqual(delivery());
  expect("mentionDelivery" in decoded).toBe(false);
});

test("a delivery envelope that does not match its delivery still decodes, so the daemon can report it", () => {
  const mismatched = {
    ...delivery(),
    mentionDelivery: { ...envelope, messageId: "other-message", computerId: "other-computer" },
  };
  expect(decodeAgentMessageDelivery(encodeAgentMessageDelivery(mismatched))).toEqual(mismatched);
});

test("an envelope with an empty identity field is refused both ways", () => {
  for (const field of Object.keys(envelope) as (keyof typeof envelope)[]) {
    const broken = { ...delivery(), mentionDelivery: { ...envelope, [field]: "" } };
    expect(() => encodeAgentMessageDelivery(broken)).toThrow("invalid mention delivery envelope");
  }
  const bytes = encodeAgentMessageDelivery(delivery());
  const withEmpty = new Uint8Array([
    ...bytes,
    // field 18, wire type 2, an empty envelope
    0x92,
    0x01,
    0x00,
  ]);
  expect(() => decodeAgentMessageDelivery(withEmpty)).toThrow("invalid mention delivery envelope");
});

test("an ACK echoes the envelope it drained, and an ACK without one decodes without it", () => {
  const echoed = { ...ack(), mentionDelivery: envelope };
  expect(decodeAgentMessageDeliveryAck(encodeAgentMessageDeliveryAck(echoed))).toEqual(echoed);
  const plain = decodeAgentMessageDeliveryAck(encodeAgentMessageDeliveryAck(ack()));
  expect(plain).toEqual(ack());
  expect("mentionDelivery" in plain).toBe(false);
});

test("a transition round-trips its stage and outcome and refuses an unknown one", () => {
  const transition = {
    protocolMajor: 1,
    requestId: "transition-a",
    workspaceId: "workspace-a",
    agentId: "agent-a",
    deliveryId: "delivery-a",
    stage: "daemon_received",
    outcome: "accepted",
    mentionDelivery: envelope,
  } as const;
  expect(
    decodeAgentMentionDeliveryTransition(encodeAgentMentionDeliveryTransition(transition)),
  ).toEqual(transition);
  const coalesced = { ...transition, stage: "daemon_pending", outcome: "coalesced" } as const;
  expect(
    decodeAgentMentionDeliveryTransition(encodeAgentMentionDeliveryTransition(coalesced)),
  ).toEqual(coalesced);
  expect(() =>
    encodeAgentMentionDeliveryTransition({
      ...transition,
      stage: "daemon_lost" as "daemon_pending",
    }),
  ).toThrow("invalid mention delivery transition");
  expect(() =>
    encodeAgentMentionDeliveryTransition({ ...transition, outcome: "dropped" as "accepted" }),
  ).toThrow("invalid mention delivery transition");
  expect(() => encodeAgentMentionDeliveryTransition({ ...transition, workspaceId: "" })).toThrow(
    "invalid mention delivery transition",
  );
});

test("a terminal error round-trips every known code and any other well-formed one", () => {
  const terminal = {
    protocolMajor: 1,
    requestId: "terminal-a",
    workspaceId: "workspace-a",
    agentId: "agent-a",
    deliveryId: "delivery-a",
    code: MENTION_DELIVERY_TERMINAL_CODES.QUOTA_LIMITED,
    mentionDelivery: envelope,
  };
  for (const code of [...Object.values(MENTION_DELIVERY_TERMINAL_CODES), "SOMETHING_NEW"]) {
    const value = { ...terminal, code };
    expect(
      decodeAgentMentionDeliveryTerminalError(encodeAgentMentionDeliveryTerminalError(value)),
    ).toEqual(value);
  }
  for (const code of ["", "lower_case", "X".repeat(65)])
    expect(() => encodeAgentMentionDeliveryTerminalError({ ...terminal, code })).toThrow(
      "invalid mention delivery terminal error",
    );
  expect(() => encodeAgentMentionDeliveryTerminalError({ ...terminal, protocolMajor: 2 })).toThrow(
    "invalid mention delivery terminal error",
  );
});

test("the daemon reports on its own RPC methods", () => {
  expect(AGENT_MENTION_DELIVERY_TRANSITION_METHOD).toBe("agent:v1:mention_delivery:transition");
  expect(AGENT_MENTION_DELIVERY_TERMINAL_ERROR_METHOD).toBe(
    "agent:v1:mention_delivery:terminal_error",
  );
});

test("keeps the envelope's wire tags stable and additive", () => {
  const tags = (schema: { fields: { localName: string; number: number }[] }) =>
    Object.fromEntries(schema.fields.map((field) => [field.localName, field.number]));
  expect(tags(MentionDeliveryEnvelopeSchema)).toEqual({
    messageId: 1,
    launchId: 2,
    sessionId: 3,
    computerId: 4,
  });
  expect(tags(AgentMessageDeliverySchema)).toMatchObject({ mentionDelivery: 18 });
  expect(tags(AgentMessageDeliveryAckSchema)).toMatchObject({ mentionDelivery: 9 });
  expect(tags(AgentMentionDeliveryTransitionSchema)).toEqual({
    protocolMajor: 1,
    requestId: 2,
    workspaceId: 3,
    agentId: 4,
    deliveryId: 5,
    stage: 6,
    outcome: 7,
    mentionDelivery: 8,
  });
  expect(tags(AgentMentionDeliveryTerminalErrorSchema)).toEqual({
    protocolMajor: 1,
    requestId: 2,
    workspaceId: 3,
    agentId: 4,
    deliveryId: 5,
    code: 6,
    mentionDelivery: 7,
  });
});
