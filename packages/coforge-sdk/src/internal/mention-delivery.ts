import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  AgentMentionDeliveryTerminalErrorSchema,
  AgentMentionDeliveryTransitionSchema,
  MentionDeliveryEnvelopeSchema,
  type MentionDeliveryEnvelope as MentionDeliveryEnvelopeMessage,
} from "#src/internal/gen/coforge/rpc/v1/workspace_pb";
import { RPC_METHODS } from "./rpc-methods";
import { boundedPayload } from "./bounded-payload";

/** Daemon -> server progress of a tracked @mention delivery. Diagnostic only. */
export const AGENT_MENTION_DELIVERY_TRANSITION_METHOD = RPC_METHODS.agentMentionDeliveryTransition;
/** Daemon -> server final result of a tracked @mention delivery the daemon will not drain. */
export const AGENT_MENTION_DELIVERY_TERMINAL_ERROR_METHOD =
  RPC_METHODS.agentMentionDeliveryTerminalError;

/**
 * The recipient Agent's launch and native session a tracked @mention delivery was issued for, and
 * the Computer it was issued to. The delivery it travels with (or a report's `deliveryId`)
 * identifies the mention.
 * The codecs check only its shape: whether it matches the delivery and the running launch is the
 * daemon's call, which it answers with a terminal error instead of a refused decode.
 */
export type MentionDeliveryEnvelope = {
  messageId: string;
  launchId: string;
  sessionId: string;
  computerId: string;
};

export const MENTION_DELIVERY_STAGES = [
  "daemon_received",
  "daemon_pending",
  "daemon_drained",
] as const;
export type MentionDeliveryStage = (typeof MENTION_DELIVERY_STAGES)[number];
/** `accepted`: the daemon saw the delivery for the first time. `coalesced`: a repeat of one
 * it still holds pending. */
export const MENTION_DELIVERY_TRANSITION_OUTCOMES = ["accepted", "coalesced"] as const;
export type MentionDeliveryTransitionOutcome =
  (typeof MENTION_DELIVERY_TRANSITION_OUTCOMES)[number];

/** The terminal codes a daemon reports today. The wire carries any upper-case identifier, so a
 * newer daemon's code still reaches the server, which records it as unclassified. */
export const MENTION_DELIVERY_TERMINAL_CODES = {
  /** The Agent has no running launch or session. */
  IDENTITY_UNKNOWN: "IDENTITY_UNKNOWN",
  /** The envelope names another launch, session or Computer than the one running. */
  IDENTITY_DRIFT: "IDENTITY_DRIFT",
  /** The envelope does not match its own delivery. */
  INSTRUMENT_FAILED: "INSTRUMENT_FAILED",
  /** The runtime refused or lost the notice. */
  DELIVERY_REJECTED: "DELIVERY_REJECTED",
  /** The runtime has no path that can carry a tracked notice right now. */
  UNSUPPORTED_DELIVERY_PATH: "UNSUPPORTED_DELIVERY_PATH",
  /** The runtime is backing off from a rate or quota limit. */
  QUOTA_LIMITED: "QUOTA_LIMITED",
} as const;
export type MentionDeliveryTerminalCode =
  (typeof MENTION_DELIVERY_TERMINAL_CODES)[keyof typeof MENTION_DELIVERY_TERMINAL_CODES];

/** What every daemon report on a tracked mention names: its scope and the envelope it answers. */
type MentionDeliveryReport = {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  agentId: string;
  deliveryId: string;
  mentionDelivery: MentionDeliveryEnvelope;
};

export type AgentMentionDeliveryTransition = MentionDeliveryReport & {
  stage: MentionDeliveryStage;
  outcome: MentionDeliveryTransitionOutcome;
};

export type AgentMentionDeliveryTerminalError = MentionDeliveryReport & {
  /** One of `MENTION_DELIVERY_TERMINAL_CODES`, or another upper-case identifier. */
  code: string;
};

const MAX_ID_LENGTH = 512;
const MAX_REPORT_BYTES = 8_192;
const TERMINAL_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const ENVELOPE_FIELDS = [
  "messageId",
  "launchId",
  "sessionId",
  "computerId",
] as const satisfies readonly (keyof MentionDeliveryEnvelope)[];

const isId = (value: unknown) =>
  typeof value === "string" && value.trim().length > 0 && value.length <= MAX_ID_LENGTH;

function checkedEnvelope(
  value: Record<(typeof ENVELOPE_FIELDS)[number], string> | undefined,
): MentionDeliveryEnvelope {
  if (!value || !ENVELOPE_FIELDS.every((field) => isId(value[field])))
    throw new Error("invalid mention delivery envelope");
  return {
    messageId: value.messageId,
    launchId: value.launchId,
    sessionId: value.sessionId,
    computerId: value.computerId,
  };
}

/** The wire form of an optional envelope, refusing an incomplete one. */
export function mentionDeliveryEnvelopeMessage(
  value: MentionDeliveryEnvelope | undefined,
): MentionDeliveryEnvelopeMessage | undefined {
  return value === undefined
    ? undefined
    : create(MentionDeliveryEnvelopeSchema, checkedEnvelope(value));
}

/** The plain envelope a decoded message carries, if any; an incomplete one is refused. */
export function readMentionDeliveryEnvelope(
  value: MentionDeliveryEnvelopeMessage | undefined,
): MentionDeliveryEnvelope | undefined {
  return value === undefined ? undefined : checkedEnvelope(value);
}

const validScope = (value: Omit<MentionDeliveryReport, "mentionDelivery">) =>
  value.protocolMajor === 1 &&
  isId(value.requestId) &&
  isId(value.workspaceId) &&
  isId(value.agentId) &&
  isId(value.deliveryId);

function checkTransition(
  value: Omit<MentionDeliveryReport, "mentionDelivery"> & {
    stage: string;
    outcome: string;
  },
) {
  if (
    !validScope(value) ||
    !(MENTION_DELIVERY_STAGES as readonly string[]).includes(value.stage) ||
    !(MENTION_DELIVERY_TRANSITION_OUTCOMES as readonly string[]).includes(value.outcome)
  )
    throw new Error("invalid mention delivery transition");
}

function checkTerminalError(
  value: Omit<MentionDeliveryReport, "mentionDelivery"> & {
    code: string;
  },
) {
  if (!validScope(value) || !TERMINAL_CODE.test(value.code))
    throw new Error("invalid mention delivery terminal error");
}

export function encodeAgentMentionDeliveryTransition(
  value: AgentMentionDeliveryTransition,
): Uint8Array {
  checkTransition(value);
  return boundedPayload(
    toBinary(
      AgentMentionDeliveryTransitionSchema,
      create(AgentMentionDeliveryTransitionSchema, {
        ...value,
        mentionDelivery: mentionDeliveryEnvelopeMessage(checkedEnvelope(value.mentionDelivery)),
      }),
    ),
    MAX_REPORT_BYTES,
    "mention delivery transition",
  );
}

export function decodeAgentMentionDeliveryTransition(
  bytes: Uint8Array,
): AgentMentionDeliveryTransition {
  const {
    $typeName: _,
    mentionDelivery,
    ...value
  } = fromBinary(
    AgentMentionDeliveryTransitionSchema,
    boundedPayload(bytes, MAX_REPORT_BYTES, "mention delivery transition"),
  );
  checkTransition(value);
  return {
    ...value,
    stage: value.stage as MentionDeliveryStage,
    outcome: value.outcome as MentionDeliveryTransitionOutcome,
    mentionDelivery: checkedEnvelope(mentionDelivery),
  };
}

export function encodeAgentMentionDeliveryTerminalError(
  value: AgentMentionDeliveryTerminalError,
): Uint8Array {
  checkTerminalError(value);
  return boundedPayload(
    toBinary(
      AgentMentionDeliveryTerminalErrorSchema,
      create(AgentMentionDeliveryTerminalErrorSchema, {
        ...value,
        mentionDelivery: mentionDeliveryEnvelopeMessage(checkedEnvelope(value.mentionDelivery)),
      }),
    ),
    MAX_REPORT_BYTES,
    "mention delivery terminal error",
  );
}

export function decodeAgentMentionDeliveryTerminalError(
  bytes: Uint8Array,
): AgentMentionDeliveryTerminalError {
  const {
    $typeName: _,
    mentionDelivery,
    ...value
  } = fromBinary(
    AgentMentionDeliveryTerminalErrorSchema,
    boundedPayload(bytes, MAX_REPORT_BYTES, "mention delivery terminal error"),
  );
  checkTerminalError(value);
  return { ...value, mentionDelivery: checkedEnvelope(mentionDelivery) };
}
