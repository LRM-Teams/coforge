import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  DaemonHandshakeRequestSchema,
  DaemonHandshakeResponseSchema,
  DaemonCommandRequestSchema,
  DaemonCommandResponseSchema,
} from "#src/internal/gen/coforge/rpc/v1/daemon_pb";
import {
  DaemonRuntimeConfigureRequestSchema,
  DaemonRuntimeConfigureResponseSchema,
} from "#src/internal/gen/coforge/rpc/v1/daemon_runtime_pb";
import {
  LocalRpcRequestSchema,
  LocalRpcResponseSchema,
  AgentMessageResponseSchema,
  LocalInboxRequestSchema,
  InboxResponseSchema,
  InboxEntrySchema,
  MessageAttentionSummarySchema,
  AppInboxItemSchema,
  UsageScanRequestSchema,
  UsageScanResponseSchema,
  DaemonHoldRequestSchema,
  DaemonHoldResponseSchema,
} from "#src/internal/gen/coforge/rpc/v1/local_rpc_pb";
import { assertValidMessageSender, type MessageSenderKind } from "./message-sender";

export const LOCAL_RPC_PROTOCOL_MAJOR = 1 as const;
export const LOCAL_RPC_METHODS = {
  HANDSHAKE: "daemon:handshake",
  CONFIGURE: "daemon-runtime:configure",
  START: "daemon:start",
  STOP: "daemon:stop",
  RESTART: "daemon:restart",
  SNAPSHOT: "daemon:snapshot",
  PAUSE: "daemon:pause",
  RESUME: "daemon:resume",
  UPGRADE: "daemon:upgrade",
  UPGRADE_ACKNOWLEDGE: "daemon:upgrade_ack",
  HOLD: "daemon:hold",
  RELEASE: "daemon:release",
  AGENT_INBOX: "agent:inbox",
  USAGE_SCAN: "usage:scan",
} as const;
export type LocalInboxRequest = {
  requestId: string;
  context: string;
  operation: "check";
};
export type AppInboxItem = {
  itemId: string;
  appId: string;
  notificationClass: string;
  sourceRef: { kind: string; id: string; revision: string };
  title?: string;
  summary?: string;
  retention: "until_explicit_ack";
  action: { kind: "run_command"; commandId: string };
  createdAt: string;
};
export type InboxEntry =
  | { kind: "message_target"; messageTarget: MessageAttentionSummary }
  | { kind: "app"; app: AppInboxItem };
export type InboxResponse = { requestId: string; accepted: boolean; entries: InboxEntry[] };
export function encodeLocalInboxRequest(value: LocalInboxRequest): Uint8Array {
  return toBinary(LocalInboxRequestSchema, create(LocalInboxRequestSchema, value));
}
export function decodeLocalInboxRequest(bytes: Uint8Array): LocalInboxRequest {
  const value = fromBinary(LocalInboxRequestSchema, bytes);
  if (value.operation !== "check") throw new Error("invalid App Inbox operation");
  return {
    requestId: value.requestId,
    context: value.context,
    operation: value.operation,
  };
}
export function encodeInboxResponse(value: InboxResponse): Uint8Array {
  for (const entry of value.entries)
    if (entry.kind === "message_target" && entry.messageTarget.latestSenderKind !== undefined)
      assertValidMessageSender(
        entry.messageTarget.latestSenderKind,
        entry.messageTarget.latestSenderHandle ?? "",
        "Inbox message-target",
      );
  return toBinary(
    InboxResponseSchema,
    create(InboxResponseSchema, {
      requestId: value.requestId,
      accepted: value.accepted,
      entries: value.entries.map((entry) =>
        create(
          InboxEntrySchema,
          entry.kind === "message_target"
            ? {
                value: {
                  case: "messageTarget",
                  value: create(MessageAttentionSummarySchema, {
                    ...entry.messageTarget,
                    firstPendingSequence: BigInt(entry.messageTarget.firstPendingSequence),
                    latestSequence: BigInt(entry.messageTarget.latestSequence),
                  }),
                },
              }
            : {
                value: {
                  case: "app",
                  value: create(AppInboxItemSchema, {
                    ...entry.app,
                    sourceKind: entry.app.sourceRef.kind,
                    sourceId: entry.app.sourceRef.id,
                    sourceRevision: entry.app.sourceRef.revision,
                    actionKind: entry.app.action.kind,
                    actionCommandId: entry.app.action.commandId,
                  }),
                },
              },
        ),
      ),
    }),
  );
}
export function decodeInboxResponse(bytes: Uint8Array): InboxResponse {
  const value = fromBinary(InboxResponseSchema, bytes);
  return {
    requestId: value.requestId,
    accepted: value.accepted,
    entries: value.entries.map((entry): InboxEntry => {
      if (entry.value.case === "messageTarget") {
        const { latestSenderKind, latestSenderHandle } = entry.value.value;
        if (latestSenderKind !== undefined)
          assertValidMessageSender(
            latestSenderKind,
            latestSenderHandle ?? "",
            "Inbox message-target",
          );
        return {
          kind: "message_target",
          messageTarget: {
            target: entry.value.value.target,
            pendingCount: entry.value.value.pendingCount,
            firstPendingSequence: Number(entry.value.value.firstPendingSequence),
            latestSequence: Number(entry.value.value.latestSequence),
            ...(latestSenderKind
              ? {
                  latestSenderKind: latestSenderKind as MessageAttentionSummary["latestSenderKind"],
                  latestSenderHandle,
                }
              : {}),
            flags: entry.value.value.flags,
          },
        };
      }
      if (entry.value.case !== "app") throw new Error("invalid Inbox entry");
      const app = entry.value.value;
      if (app.retention !== "until_explicit_ack" || app.actionKind !== "run_command")
        throw new Error("invalid App Inbox entry");
      return {
        kind: "app",
        app: {
          itemId: app.itemId,
          appId: app.appId,
          notificationClass: app.notificationClass,
          sourceRef: { kind: app.sourceKind, id: app.sourceId, revision: app.sourceRevision },
          ...(app.title === undefined ? {} : { title: app.title }),
          ...(app.summary === undefined ? {} : { summary: app.summary }),
          retention: app.retention as "until_explicit_ack",
          action: { kind: "run_command", commandId: app.actionCommandId },
          createdAt: app.createdAt,
        },
      };
    }),
  };
}
export type UsageScanRequest = { protocolMajor: number; requestId: string; provider: string };
export type UsageScanResponse = {
  protocolMajor: number;
  requestId: string;
  accepted: boolean;
  status: string;
  message?: string;
  snapshotJson?: Uint8Array;
};
export const encodeUsageScanRequest = (v: UsageScanRequest) =>
  toBinary(UsageScanRequestSchema, create(UsageScanRequestSchema, v));
export const decodeUsageScanRequest = (b: Uint8Array): UsageScanRequest => {
  const v = fromBinary(UsageScanRequestSchema, b);
  return { protocolMajor: v.protocolMajor, requestId: v.requestId, provider: v.provider };
};
export const encodeUsageScanResponse = (v: UsageScanResponse) =>
  toBinary(UsageScanResponseSchema, create(UsageScanResponseSchema, v));
export const decodeUsageScanResponse = (b: Uint8Array): UsageScanResponse => {
  const v = fromBinary(UsageScanResponseSchema, b);
  return {
    protocolMajor: v.protocolMajor,
    requestId: v.requestId,
    accepted: v.accepted,
    status: v.status,
    message: v.message || undefined,
    snapshotJson: v.snapshotJson.length ? v.snapshotJson : undefined,
  };
};
/** A structured @mention binding: a handle claimed to name a specific actor. */
export type LocalMentionSelector = { type: "user" | "agent"; id: string; name: string };

export type LocalAgentMessageRequest = {
  requestId: string;
  context: string;
  operation:
    | "check"
    | "read"
    | "search"
    | "send"
    | "mute"
    | "unmute"
    | "thread-unfollow"
    | "resolve"
    | "react"
    | "unreact";
  target?: string;
  content?: string;
  sendDraft?: boolean;
  continueAnyway?: boolean;
  /** `message send` only (daemon-internal): the boundary the sender has already reviewed. */
  seenUpToSeq?: number;
  /** `message send` only (daemon-internal): how many times this draft has already been held. */
  draftReholdCount?: number;
  /** `message send` only (daemon-internal): a normal send that replaced an already-held draft. */
  draftReplacedExisting?: boolean;
  before?: string;
  after?: string;
  around?: string;
  limit?: number;
  query?: string;
  sender?: string;
  sort?: "relevance" | "recent";
  offset?: number;
  freshnessContextMode?: "inline" | "withheld";
  messageId?: string;
  emoji?: string;
  /** `message send` only: attachments already uploaded to this conversation, in send order.
   * Max 10, unique, each a UUID. */
  attachmentIds?: string[];
  /** `message send` only: structured @mention bindings; replaces the draft's saved mentions on `--send-draft` when non-empty. */
  mentions?: LocalMentionSelector[];
  /** `message send` only: confirms a top-level send despite newer thread read context under the same parent. Never leaves the daemon. */
  targetConfirmed?: boolean;
};
export type LocalAttachment = {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
};
export type AgentMessageRecord = {
  id: string;
  sequence: number;
  senderKind: MessageSenderKind;
  /** Public handle without a leading "@"; required for "human"/"agent", empty for "system". */
  senderHandle: string;
  /** The sender's role text; empty when there is none. */
  senderDescription: string;
  target: string;
  body: string;
  createdAt: string;
  /** Always present, possibly empty; order matches send/upload order. */
  attachments: LocalAttachment[];
  task?: MessageTaskMetadata;
  /** True when this message personally @mentioned the reading Agent. */
  mentionsAgent?: boolean;
  /** True when the reading Agent is not in the channel and was notified of this one message. */
  nonMemberMention?: boolean;
};
export type MessageTaskMetadata = {
  number: number;
  status: import("./tasks").TaskStatus;
  /** `handle` has no leading "@"; `deleted` marks an Agent deleted while still holding the Task. */
  owner?: { displayName: string; handle: string; deleted?: boolean };
};

export function decodeMessageTask(value: {
  number: number;
  status: string;
  owner?: { displayName: string; handle: string; deleted?: boolean };
}): MessageTaskMetadata {
  let status: MessageTaskMetadata["status"];
  switch (value.status) {
    case "todo":
    case "in_progress":
    case "in_review":
    case "done":
    case "closed":
      status = value.status;
      break;
    default:
      throw new Error("invalid message Task status");
  }
  return {
    number: value.number,
    status,
    ...(value.owner
      ? {
          owner: {
            displayName: value.owner.displayName,
            handle: value.owner.handle,
            ...(value.owner.deleted ? { deleted: true } : {}),
          },
        }
      : {}),
  };
}
export function encodeLocalAttachment(value: LocalAttachment) {
  return { ...value, sizeBytes: BigInt(value.sizeBytes) };
}
export function encodeLocalAttachments(values: readonly LocalAttachment[]) {
  return values.map(encodeLocalAttachment);
}
type RawLocalAttachment = {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: bigint;
};
export function decodeLocalAttachments(values: readonly RawLocalAttachment[]): LocalAttachment[] {
  return values.map((value) => ({
    id: value.id,
    fileName: value.fileName,
    contentType: value.contentType,
    sizeBytes: Number(value.sizeBytes),
  }));
}
/** One mention the sender's message did not deliver, as Raft 1.0.32 reports it. */
export type AgentPendingMentionAction = {
  resolutionId: string;
  messageId: string;
  targetType: "user" | "agent";
  targetHandle: string;
  targetAvatarUrl: string | null;
  /** Why it was not delivered: the target was not in the conversation at send time. */
  reason: "not_member";
  /** What the sender may still do: `notify` and/or `add`. */
  availableActions: string[];
  /** ISO time after which the action can no longer be taken. */
  expiresAt: string;
};
export type AgentMessageResponse = {
  requestId: string;
  accepted: boolean;
  attentionCount: number;
  messages: AgentMessageRecord[];
  messageId: string;
  summaries: MessageAttentionSummary[];
  /** `message send` only: Raft's send contract, `"sent"` or `"held"`. */
  state?: "sent" | "held";
  /** `message send` only: `forward`/`bypass` sent the message, `local_hold`/`syncing_hold` held it. */
  decision?: "forward" | "bypass" | "local_hold" | "syncing_hold";
  reason?: string;
  producerFactId?: string;
  /** `message send` only, held: Raft's `available_actions` recovery paths. */
  availableActions?: string[];
  /** `message send` only, held: an already-re-held draft may be forced with `--send-draft --anyway`. */
  continueAnywaySuggested?: boolean;
  /** `message send` only, held: the held context window, oldest to newest. */
  heldMessages?: AgentMessageRecord[];
  newMessageCount?: number;
  shownMessageCount?: number;
  omittedMessageCount?: number;
  hasOlder?: boolean;
  hasNewer?: boolean;
  olderCursor?: string;
  newerCursor?: string;
  freshnessContextMode?: "inline" | "withheld";
  withheldMessageCount?: number;
  hasMore?: boolean;
  /** `message send` only: pending messages a bypassed hold chose not to review; empty otherwise. */
  recentUnread?: AgentMessageRecord[];
  /** `message send` only: mentions of people outside the channel, which notified no one. */
  pendingMentionActions?: AgentPendingMentionAction[];
  /** `message send` only: `@handle`s that name nobody the Agent can see. */
  unresolvedMentionHandles?: string[];
};
export type MessageAttentionSummary = {
  target: string;
  pendingCount: number;
  firstPendingSequence: number;
  latestSequence: number;
  latestSenderKind?: MessageSenderKind;
  /** Public handle without a leading "@". No description on this summary. */
  latestSenderHandle?: string;
  flags: string[];
};
function encodeAgentMessageRecords(records: readonly AgentMessageRecord[]) {
  for (const m of records)
    assertValidMessageSender(m.senderKind, m.senderHandle, "Agent message record");
  return records.map((m) => ({
    ...m,
    sequence: BigInt(m.sequence),
    createdAt: m.createdAt,
    attachments: encodeLocalAttachments(m.attachments),
    task: m.task,
  }));
}

function decodeAgentMessageRecords(
  records: readonly {
    id: string;
    sequence: bigint;
    senderKind: string;
    senderHandle: string;
    senderDescription: string;
    target: string;
    body: string;
    createdAt: string;
    attachments: readonly RawLocalAttachment[];
    task?: Parameters<typeof decodeMessageTask>[0];
    mentionsAgent?: boolean;
  }[],
): AgentMessageRecord[] {
  return records.map((m) => {
    assertValidMessageSender(m.senderKind, m.senderHandle, "Agent message record");
    return {
      id: m.id,
      sequence: Number(m.sequence),
      senderKind: m.senderKind,
      senderHandle: m.senderHandle,
      senderDescription: m.senderDescription,
      target: m.target,
      body: m.body,
      createdAt: m.createdAt,
      attachments: decodeLocalAttachments(m.attachments),
      ...(m.task ? { task: decodeMessageTask(m.task) } : {}),
      ...(m.mentionsAgent ? { mentionsAgent: true } : {}),
    };
  });
}

export function encodeAgentMessageResponse(value: AgentMessageResponse): Uint8Array {
  const safeValue =
    value.freshnessContextMode === "withheld"
      ? {
          ...value,
          messages: [],
          summaries: [],
          hasOlder: undefined,
          hasNewer: undefined,
          olderCursor: undefined,
          newerCursor: undefined,
          withheldMessageCount: value.withheldMessageCount ?? value.attentionCount,
          hasMore: undefined,
          heldMessages: [],
          recentUnread: [],
        }
      : value;
  return toBinary(
    AgentMessageResponseSchema,
    create(AgentMessageResponseSchema, {
      ...safeValue,
      messages: encodeAgentMessageRecords(safeValue.messages),
      heldMessages: encodeAgentMessageRecords(safeValue.heldMessages ?? []),
      recentUnread: encodeAgentMessageRecords(safeValue.recentUnread ?? []),
      summaries: safeValue.summaries.map((summary) => {
        if (summary.latestSenderKind !== undefined)
          assertValidMessageSender(
            summary.latestSenderKind,
            summary.latestSenderHandle ?? "",
            "message attention summary",
          );
        return {
          ...summary,
          firstPendingSequence: BigInt(summary.firstPendingSequence),
          latestSequence: BigInt(summary.latestSequence),
        };
      }),
      hasOlder: safeValue.hasOlder ?? false,
      hasNewer: safeValue.hasNewer ?? false,
      olderCursor: safeValue.olderCursor,
      newerCursor: safeValue.newerCursor,
    }),
  );
}
export function decodeAgentMessageResponse(bytes: Uint8Array): AgentMessageResponse {
  const v = fromBinary(AgentMessageResponseSchema, bytes);
  if (v.freshnessContextMode && !["inline", "withheld"].includes(v.freshnessContextMode))
    throw new Error("invalid Agent message freshness context mode");
  if (v.freshnessContextMode === "withheld")
    return {
      requestId: v.requestId,
      accepted: v.accepted,
      attentionCount: v.attentionCount,
      messages: [],
      messageId: v.messageId,
      summaries: [],
      state: v.state as AgentMessageResponse["state"],
      decision: v.decision as AgentMessageResponse["decision"],
      reason: v.reason || undefined,
      producerFactId: v.producerFactId || undefined,
      availableActions: v.availableActions.length ? v.availableActions : undefined,
      continueAnywaySuggested: v.continueAnywaySuggested || undefined,
      heldMessages: [],
      newMessageCount: v.newMessageCount,
      shownMessageCount: v.shownMessageCount,
      omittedMessageCount: v.omittedMessageCount,
      freshnessContextMode: "withheld",
      withheldMessageCount: v.withheldMessageCount ?? v.attentionCount,
      recentUnread: [],
    };
  return {
    requestId: v.requestId,
    accepted: v.accepted,
    attentionCount: v.attentionCount,
    messageId: v.messageId,
    summaries: v.summaries.map((summary) => {
      if (summary.latestSenderKind !== undefined)
        assertValidMessageSender(
          summary.latestSenderKind,
          summary.latestSenderHandle ?? "",
          "message attention summary",
        );
      return {
        target: summary.target,
        pendingCount: summary.pendingCount,
        firstPendingSequence: Number(summary.firstPendingSequence),
        latestSequence: Number(summary.latestSequence),
        ...(summary.latestSenderKind
          ? {
              latestSenderKind:
                summary.latestSenderKind as MessageAttentionSummary["latestSenderKind"],
              latestSenderHandle: summary.latestSenderHandle,
            }
          : {}),
        flags: summary.flags,
      };
    }),
    messages: decodeAgentMessageRecords(v.messages),
    state: (v.state || undefined) as AgentMessageResponse["state"],
    decision: (v.decision || undefined) as AgentMessageResponse["decision"],
    reason: v.reason || undefined,
    producerFactId: v.producerFactId || undefined,
    availableActions: v.availableActions.length ? v.availableActions : undefined,
    continueAnywaySuggested: v.continueAnywaySuggested || undefined,
    heldMessages: v.heldMessages.length ? decodeAgentMessageRecords(v.heldMessages) : undefined,
    newMessageCount: v.newMessageCount,
    shownMessageCount: v.shownMessageCount,
    omittedMessageCount: v.omittedMessageCount,
    recentUnread: v.recentUnread.length ? decodeAgentMessageRecords(v.recentUnread) : undefined,
    hasOlder: v.hasOlder || undefined,
    hasNewer: v.hasNewer || undefined,
    olderCursor: v.olderCursor || undefined,
    newerCursor: v.newerCursor || undefined,
    freshnessContextMode: (v.freshnessContextMode || undefined) as
      | "inline"
      | "withheld"
      | undefined,
    withheldMessageCount: v.withheldMessageCount,
    hasMore: v.hasMore || undefined,
  };
}
export const DAEMON_HANDSHAKE_METHOD = LOCAL_RPC_METHODS.HANDSHAKE;
export const DAEMON_RUNTIME_CONFIGURE_METHOD = LOCAL_RPC_METHODS.CONFIGURE;
export type DaemonRuntimeConfigureRequest = {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  workspaceRoot: string;
  daemonApiKey: string;
  computerId: string;
  expectedServerUrl: string;
  serverHttpUrl?: string;
};
export type DaemonRuntimeConfigureResponse = {
  protocolMajor: number;
  requestId: string;
  accepted: boolean;
};
export type DaemonCommandRequest = {
  protocolMajor: number;
  requestId: string;
  expectedServerUrl: string;
  workspaceId?: string;
  expectedVersion?: string;
};
export type ManagedRuntimeIdentity = {
  workspaceId: string;
  computerId: string;
  enabled: boolean;
  processId: number;
  instanceId: string;
  version: string;
};
export type DaemonCommandResponse = {
  protocolMajor: number;
  requestId: string;
  accepted: boolean;
  runtimes?: ManagedRuntimeIdentity[];
  /** Set only when `accepted` is false. Local Coordinator<->Workspace daemon process boundary
   * only - never the wire to the server. */
  error?: string;
  /** See `UPGRADE_ERROR_CODE` (the only vocabulary a lifecycle refusal currently uses); may be
   * absent even when `error` is set, and may name a code this build does not know yet. */
  errorCode?: string;
};
export type LocalRpcRequest = { method: string; payload: Uint8Array };
export type LocalRpcResponse = { method: string; payload: Uint8Array };

export function encodeLocalRpcRequest(value: LocalRpcRequest): Uint8Array {
  return toBinary(LocalRpcRequestSchema, create(LocalRpcRequestSchema, value));
}
export function decodeLocalRpcRequest(bytes: Uint8Array): LocalRpcRequest {
  const value = fromBinary(LocalRpcRequestSchema, bytes);
  return { method: value.method, payload: value.payload };
}
export function encodeLocalRpcResponse(value: LocalRpcResponse): Uint8Array {
  return toBinary(LocalRpcResponseSchema, create(LocalRpcResponseSchema, value));
}
export function decodeLocalRpcResponse(bytes: Uint8Array): LocalRpcResponse {
  const value = fromBinary(LocalRpcResponseSchema, bytes);
  return { method: value.method, payload: value.payload };
}

export function encodeDaemonRuntimeConfigureRequest(
  value: DaemonRuntimeConfigureRequest,
): Uint8Array {
  return toBinary(
    DaemonRuntimeConfigureRequestSchema,
    create(DaemonRuntimeConfigureRequestSchema, value),
  );
}
export function decodeDaemonRuntimeConfigureRequest(
  bytes: Uint8Array,
): DaemonRuntimeConfigureRequest {
  const v = fromBinary(DaemonRuntimeConfigureRequestSchema, bytes);
  return {
    protocolMajor: v.protocolMajor,
    requestId: v.requestId,
    workspaceId: v.workspaceId,
    workspaceRoot: v.workspaceRoot,
    daemonApiKey: v.daemonApiKey,
    computerId: v.computerId,
    expectedServerUrl: v.expectedServerUrl,
    serverHttpUrl: v.serverHttpUrl,
  };
}
export function encodeDaemonRuntimeConfigureResponse(
  value: DaemonRuntimeConfigureResponse,
): Uint8Array {
  return toBinary(
    DaemonRuntimeConfigureResponseSchema,
    create(DaemonRuntimeConfigureResponseSchema, value),
  );
}
export function decodeDaemonRuntimeConfigureResponse(
  bytes: Uint8Array,
): DaemonRuntimeConfigureResponse {
  const v = fromBinary(DaemonRuntimeConfigureResponseSchema, bytes);
  return { protocolMajor: v.protocolMajor, requestId: v.requestId, accepted: v.accepted };
}

export function encodeDaemonCommandRequest(value: DaemonCommandRequest): Uint8Array {
  return toBinary(DaemonCommandRequestSchema, create(DaemonCommandRequestSchema, value));
}
export function decodeDaemonCommandRequest(bytes: Uint8Array): DaemonCommandRequest {
  const value = fromBinary(DaemonCommandRequestSchema, bytes);
  return {
    protocolMajor: value.protocolMajor,
    requestId: value.requestId,
    expectedServerUrl: value.expectedServerUrl,
    workspaceId: value.workspaceId,
    expectedVersion: value.expectedVersion,
  };
}
export function encodeDaemonCommandResponse(value: DaemonCommandResponse): Uint8Array {
  return toBinary(DaemonCommandResponseSchema, create(DaemonCommandResponseSchema, value));
}
export function decodeDaemonCommandResponse(bytes: Uint8Array): DaemonCommandResponse {
  const value = fromBinary(DaemonCommandResponseSchema, bytes);
  return {
    protocolMajor: value.protocolMajor,
    requestId: value.requestId,
    accepted: value.accepted,
    runtimes: value.runtimes.map(
      ({ workspaceId, computerId, enabled, processId, instanceId, version }) => ({
        workspaceId,
        computerId,
        enabled,
        processId,
        instanceId,
        version,
      }),
    ),
    ...(value.error ? { error: value.error } : {}),
    ...(value.errorCode ? { errorCode: value.errorCode } : {}),
  };
}

export type DaemonHandshakeRequest = {
  protocolMajor: number;
  requestId: string;
};

export type DaemonHandshakeResponse = {
  protocolMajor: number;
  requestId: string;
  daemonId: string;
  accepted: boolean;
  serverUrl: string;
  version?: string;
  processId?: number;
};

export function encodeDaemonHandshakeRequest(value: DaemonHandshakeRequest): Uint8Array {
  return toBinary(DaemonHandshakeRequestSchema, create(DaemonHandshakeRequestSchema, value));
}

export function decodeDaemonHandshakeRequest(bytes: Uint8Array): DaemonHandshakeRequest {
  const value = fromBinary(DaemonHandshakeRequestSchema, bytes);
  return {
    protocolMajor: value.protocolMajor,
    requestId: value.requestId,
  };
}

export function encodeDaemonHandshakeResponse(value: DaemonHandshakeResponse): Uint8Array {
  return toBinary(DaemonHandshakeResponseSchema, create(DaemonHandshakeResponseSchema, value));
}

export function decodeDaemonHandshakeResponse(bytes: Uint8Array): DaemonHandshakeResponse {
  const value = fromBinary(DaemonHandshakeResponseSchema, bytes);
  return {
    protocolMajor: value.protocolMajor,
    requestId: value.requestId,
    daemonId: value.daemonId,
    accepted: value.accepted,
    serverUrl: value.serverUrl,
    version: value.version || undefined,
    processId: value.processId || undefined,
  };
}

export function frameLocalRpc(payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(4 + payload.byteLength);
  new DataView(frame.buffer).setUint32(0, payload.byteLength);
  frame.set(payload, 4);
  return frame;
}

export function readLocalRpcFrame(buffer: Uint8Array): Uint8Array | null {
  if (buffer.byteLength < 4) return null;
  const size = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength).getUint32(0);
  if (buffer.byteLength < size + 4) return null;
  return buffer.slice(4, size + 4);
}

export function readLocalRpcFrames(buffer: Uint8Array): {
  frames: Uint8Array[];
  remainder: Uint8Array;
} {
  const frames: Uint8Array[] = [];
  let remainder = buffer;
  while (true) {
    const frame = readLocalRpcFrame(remainder);
    if (!frame) break;
    frames.push(frame);
    remainder = remainder.slice(frame.byteLength + 4);
  }
  return { frames, remainder };
}

/**
 * Runner hold. `daemon:hold` tells a daemon to stop admitting new Agent turns and report which
 * Agents are still busy; `daemon:release` lifts it. Both are idempotent, and neither is persisted,
 * so a restarted daemon is never born held.
 */
export type DaemonHoldRequest = {
  protocolMajor: number;
  requestId: string;
  expectedServerUrl: string;
  reason?: string;
};

/** One Agent whose last emitted Activity is still a busy detail kind. */
export type HeldBusyAgent = {
  workspaceId: string;
  agentId: string;
  detailKind: string;
  busySinceMs: number;
};

export type DaemonHoldResponse = {
  protocolMajor: number;
  requestId: string;
  accepted: boolean;
  held: boolean;
  busyAgents: HeldBusyAgent[];
  /** Workspaces that did not answer in time; a Coordinator reports rather than blocks on them. */
  unreachableWorkspaceIds: string[];
};

export function encodeDaemonHoldRequest(value: DaemonHoldRequest): Uint8Array {
  return toBinary(DaemonHoldRequestSchema, create(DaemonHoldRequestSchema, value));
}

export function decodeDaemonHoldRequest(bytes: Uint8Array): DaemonHoldRequest {
  const value = fromBinary(DaemonHoldRequestSchema, bytes);
  return {
    protocolMajor: value.protocolMajor,
    requestId: value.requestId,
    expectedServerUrl: value.expectedServerUrl,
    reason: value.reason || undefined,
  };
}

export function encodeDaemonHoldResponse(value: DaemonHoldResponse): Uint8Array {
  return toBinary(
    DaemonHoldResponseSchema,
    create(DaemonHoldResponseSchema, {
      ...value,
      busyAgents: value.busyAgents.map((agent) => ({
        ...agent,
        busySinceMs: BigInt(agent.busySinceMs),
      })),
    }),
  );
}

export function decodeDaemonHoldResponse(bytes: Uint8Array): DaemonHoldResponse {
  const value = fromBinary(DaemonHoldResponseSchema, bytes);
  return {
    protocolMajor: value.protocolMajor,
    requestId: value.requestId,
    accepted: value.accepted,
    held: value.held,
    busyAgents: value.busyAgents.map((agent) => ({
      workspaceId: agent.workspaceId,
      agentId: agent.agentId,
      detailKind: agent.detailKind,
      busySinceMs: Number(agent.busySinceMs),
    })),
    unreachableWorkspaceIds: [...value.unreachableWorkspaceIds],
  };
}
