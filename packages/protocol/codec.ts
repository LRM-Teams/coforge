import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { parseActivityEntries, type ActivityTrajectoryEntry } from "./activity-entries";
import {
  ComputerRegisterRequestSchema,
  ComputerRegisterResponseSchema,
} from "./gen/coforge/rpc/v1/computer_pb";
import {
  RUNTIME_PROVIDER,
  isChannelMessageTarget,
  type ComputerRegisterRequest,
  type ComputerRegisterResponse,
  type CodeAgentModelCatalog,
  type RuntimeProvider,
} from "./index";
import {
  WorkspaceGetRequestSchema,
  WorkspaceGetResponseSchema,
  WorkspaceListRequestSchema,
  WorkspaceListResponseSchema,
} from "./gen/coforge/rpc/v1/workspace_pb";
import {
  DaemonRuntimeCodeAgentsUpdateRequestSchema,
  DaemonRuntimeReadyRequestSchema,
  DaemonRuntimeUsageScanRequestSchema,
  DaemonRuntimeUsageScanResponseSchema,
  ComputerRestartIntentSchema,
} from "./gen/coforge/rpc/v1/daemon_runtime_pb";
import {
  AgentSessionReportSchema,
  AgentStartIntentSchema,
  AgentStopIntentSchema,
  AgentMessageDeliverySchema,
  AgentActivitySchema,
  AgentStatusSchema,
  AgentMessageDeliveryAckSchema,
  AgentMessageRequestSchema,
  CloudAgentMessageResponseSchema,
} from "./gen/coforge/rpc/v1/workspace_pb";
import type {
  AgentSessionReport,
  AgentStartIntent,
  AgentStopIntent,
  AgentRuntimeProviderConfig,
  AgentMessageDelivery,
  AgentActivity,
  AgentStatus,
  AgentMessageDeliveryAck,
  AgentMessageRequest,
  CloudAgentMessageResponse,
} from "./index";
import {
  AGENT_START_MESSAGE_TYPE,
  AGENT_STOP_MESSAGE_TYPE,
  USAGE_SCAN_MESSAGE_TYPE,
  USAGE_SCAN_RESPONSE_MESSAGE_TYPE,
} from "./index";
import { AGENT_MESSAGE_METHOD, AGENT_MESSAGE_ACK_METHOD } from "./index";
import { encodeLocalAttachment, decodeLocalAttachment } from "./local-daemon";
import type {
  RuntimeMetadata,
  DaemonRuntimeCodeAgentsUpdateRequest,
  DaemonRuntimeReadyRequest,
  ComputerRestartIntent,
} from "./index";
import { COMPUTER_RESTART_MESSAGE_TYPE } from "./index";

const runtimeMetadata = (runtime: RuntimeMetadata) => ({
  ...runtime,
});

function assertUint(value: number, maximum: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum)
    throw new Error(`invalid ${field}`);
}

function safeUint64(value: bigint, field: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`invalid ${field}`);
  return Number(value);
}

const decodedRuntimeMetadata = (runtime: {
  provider: string;
  version: string;
  displayName: string;
}): RuntimeMetadata => ({
  provider: parseRuntimeProvider(runtime.provider),
  version: runtime.version,
  displayName: runtime.displayName,
});

const modelCatalog = (catalog: CodeAgentModelCatalog) => ({
  provider: catalog.provider,
  models: catalog.models,
});

const decodedModelCatalog = (catalog: {
  provider: string;
  models: Array<{
    id: string;
    displayName: string;
    description: string;
    modelProvider: string;
    reasoningEfforts: string[];
    defaultReasoning: string;
    recommended: boolean;
  }>;
}): CodeAgentModelCatalog => ({
  provider: parseRuntimeProvider(catalog.provider),
  models: catalog.models.map((model) => ({
    id: model.id,
    displayName: model.displayName,
    description: model.description,
    modelProvider: model.modelProvider,
    reasoningEfforts: [...model.reasoningEfforts],
    defaultReasoning: model.defaultReasoning,
    recommended: model.recommended,
  })),
});

const MAX_AGENT_SESSION_REPORT_BYTES = 32_768;

export function encodeDaemonRuntimeReadyRequest(value: DaemonRuntimeReadyRequest): Uint8Array {
  assertRunningAgentIds(value.runningAgentIds);
  return toBinary(
    DaemonRuntimeReadyRequestSchema,
    create(DaemonRuntimeReadyRequestSchema, {
      ...value,
      startedAt: BigInt(value.startedAt),
    }),
  );
}

export function decodeDaemonRuntimeReadyRequest(bytes: Uint8Array): DaemonRuntimeReadyRequest {
  const value = fromBinary(DaemonRuntimeReadyRequestSchema, bytes);
  assertRunningAgentIds(value.runningAgentIds);
  return {
    protocolMajor: value.protocolMajor,
    requestId: value.requestId,
    workspaceId: value.workspaceId,
    computerId: value.computerId,
    workerInstanceId: value.workerInstanceId,
    daemonVersion: value.daemonVersion,
    ...(value.computerVersion !== undefined ? { computerVersion: value.computerVersion } : {}),
    ...(value.platform !== undefined ? { platform: value.platform } : {}),
    ...(value.osVersion !== undefined ? { osVersion: value.osVersion } : {}),
    startedAt: Number(value.startedAt),
    runningAgentIds: [...value.runningAgentIds],
    recoveredRestartRequestIds: [...value.recoveredRestartRequestIds],
    ...(value.capabilities.length ? { capabilities: [...value.capabilities] } : {}),
  };
}

export function encodeComputerRestartIntent(value: ComputerRestartIntent): Uint8Array {
  return toBinary(
    ComputerRestartIntentSchema,
    create(ComputerRestartIntentSchema, { ...value, messageType: COMPUTER_RESTART_MESSAGE_TYPE }),
  );
}

export function decodeComputerRestartIntent(bytes: Uint8Array): ComputerRestartIntent {
  const value = fromBinary(ComputerRestartIntentSchema, bytes);
  if (value.messageType !== COMPUTER_RESTART_MESSAGE_TYPE)
    throw new Error("invalid Computer restart message type");
  if (!value.requestId || !value.workspaceId || !value.computerId)
    throw new Error("invalid Computer restart intent");
  return {
    protocolMajor: value.protocolMajor,
    requestId: value.requestId,
    workspaceId: value.workspaceId,
    computerId: value.computerId,
    messageType: COMPUTER_RESTART_MESSAGE_TYPE,
  };
}

function assertRunningAgentIds(agentIds: readonly string[]): void {
  if (agentIds.some((agentId) => !agentId) || new Set(agentIds).size !== agentIds.length)
    throw new Error("Daemon running Agent IDs must be non-empty and unique");
}

export function encodeDaemonRuntimeCodeAgentsUpdateRequest(
  value: DaemonRuntimeCodeAgentsUpdateRequest,
): Uint8Array {
  return toBinary(
    DaemonRuntimeCodeAgentsUpdateRequestSchema,
    create(DaemonRuntimeCodeAgentsUpdateRequestSchema, {
      ...value,
      runtimes: value.runtimes.map(runtimeMetadata),
      catalogs: value.catalogs.map(modelCatalog),
    }),
  );
}

export function decodeDaemonRuntimeCodeAgentsUpdateRequest(
  bytes: Uint8Array,
): DaemonRuntimeCodeAgentsUpdateRequest {
  const value = fromBinary(DaemonRuntimeCodeAgentsUpdateRequestSchema, bytes);
  return {
    protocolMajor: value.protocolMajor,
    requestId: value.requestId,
    workspaceId: value.workspaceId,
    computerId: value.computerId,
    runtimes: value.runtimes.map(decodedRuntimeMetadata),
    catalogs: value.catalogs.map(decodedModelCatalog),
  };
}
export const encodeDaemonRuntimeUsageScanRequest = (
  v: import("./index").DaemonRuntimeUsageScanRequest,
) =>
  toBinary(
    DaemonRuntimeUsageScanRequestSchema,
    create(DaemonRuntimeUsageScanRequestSchema, { ...v, messageType: USAGE_SCAN_MESSAGE_TYPE }),
  );
export function decodeDaemonRuntimeUsageScanRequest(bytes: Uint8Array) {
  const v = fromBinary(DaemonRuntimeUsageScanRequestSchema, bytes);
  if (v.messageType !== USAGE_SCAN_MESSAGE_TYPE)
    throw new Error("invalid daemon runtime message type");
  return {
    protocolMajor: v.protocolMajor,
    requestId: v.requestId,
    workspaceId: v.workspaceId,
    computerId: v.computerId,
    provider: v.provider as import("./index").RuntimeProvider,
    messageType: v.messageType,
  };
}
export const encodeDaemonRuntimeUsageScanResponse = (
  v: import("./index").DaemonRuntimeUsageScanResponse,
) =>
  toBinary(
    DaemonRuntimeUsageScanResponseSchema,
    create(DaemonRuntimeUsageScanResponseSchema, {
      ...v,
      messageType: USAGE_SCAN_RESPONSE_MESSAGE_TYPE,
    }),
  );
export function decodeDaemonRuntimeUsageScanResponse(bytes: Uint8Array) {
  const v = fromBinary(DaemonRuntimeUsageScanResponseSchema, bytes);
  if (v.messageType !== USAGE_SCAN_RESPONSE_MESSAGE_TYPE)
    throw new Error("invalid daemon runtime message type");
  return {
    protocolMajor: v.protocolMajor,
    requestId: v.requestId,
    workspaceId: v.workspaceId,
    computerId: v.computerId,
    provider: v.provider as import("./index").RuntimeProvider,
    accepted: v.accepted,
    status: v.status,
    message: v.message || undefined,
    snapshotJson: v.snapshotJson.length ? v.snapshotJson : undefined,
    messageType: v.messageType,
  };
}

export function encodeAgentSessionReport(value: AgentSessionReport): Uint8Array {
  validateAgentSessionReport(value);
  const bytes = toBinary(AgentSessionReportSchema, create(AgentSessionReportSchema, value));
  if (bytes.length > MAX_AGENT_SESSION_REPORT_BYTES)
    throw new Error("Agent Session report payload too large");
  return bytes;
}

export function decodeAgentSessionReport(bytes: Uint8Array): AgentSessionReport {
  if (bytes.length > MAX_AGENT_SESSION_REPORT_BYTES)
    throw new Error("Agent Session report payload too large");
  const { $typeName: _, ...value } = fromBinary(AgentSessionReportSchema, bytes);
  validateAgentSessionReport(value);
  return value;
}

function validateAgentSessionReport(value: {
  protocolMajor: number;
  provider: string;
  [key: string]: unknown;
}): asserts value is AgentSessionReport {
  if (
    value.protocolMajor !== 1 ||
    !Object.values(RUNTIME_PROVIDER).includes(value.provider as RuntimeProvider)
  )
    throw new Error("invalid session report protocol/provider");
  if (value.controlEpoch !== undefined) {
    assertPositiveControlCounter(value.controlEpoch as number, "Agent control epoch");
  }
  if (value.sequence !== undefined) {
    assertPositiveControlCounter(value.sequence as number, "Agent Session sequence");
    if (value.controlEpoch === undefined || value.sessionState === undefined)
      throw new Error("Session snapshot requires control epoch and state");
  }
  if (value.sessionState !== undefined && value.sequence === undefined)
    throw new Error("Session state requires a sequence");
  if (
    value.sessionState !== undefined &&
    !["empty", "resumable", "unknown"].includes(value.sessionState as string)
  )
    throw new Error("invalid Session state");
  for (const field of [
    "requestId",
    "workspaceId",
    "computerId",
    "agentId",
    "startRequestId",
    "daemonInstanceId",
    "launchId",
    ...(value.previousLaunchId === undefined ? [] : ["previousLaunchId"]),
    ...(value.replacedSessionId === undefined ? [] : ["replacedSessionId"]),
  ])
    if (
      typeof value[field] !== "string" ||
      !(value[field] as string).trim() ||
      (value[field] as string).length > 512
    )
      throw new Error(`invalid session report ${field}`);
  if (
    typeof value.sessionId !== "string" ||
    value.sessionId.length > 512 ||
    (value.sessionId.length === 0 && value.sessionState !== "empty") ||
    (value.sessionId.length > 0 && !value.sessionId.trim())
  )
    throw new Error("invalid session report sessionId");
}

export function encodeAgentStartIntent(value: AgentStartIntent): Uint8Array {
  if (value.controlEpoch !== undefined)
    assertPositiveControlCounter(value.controlEpoch, "Agent control epoch");
  if ((value.resumeMessages?.length ?? 0) > 100)
    throw new Error("Agent recovery resumeMessages exceeds 100");
  const recoveryMessages = [
    ...(value.wakeMessage ? [value.wakeMessage] : []),
    ...(value.resumeMessages ?? []),
  ];
  if (
    new Set(recoveryMessages.map(({ messageId }) => messageId)).size !== recoveryMessages.length ||
    new Set(recoveryMessages.map(({ deliveryId }) => deliveryId)).size !== recoveryMessages.length
  )
    throw new Error("invalid agent recovery context");
  for (const message of recoveryMessages) {
    if (!message.body) throw new Error("Agent recovery body is required");
    assertUint(message.sequence, Number.MAX_SAFE_INTEGER, "Agent recovery sequence");
  }
  for (const count of Object.values(value.unreadSummary ?? {}))
    assertUint(count, 0xffff_ffff, "Agent unread count");
  const providerConfig = value.providerConfig
    ? parseAgentRuntimeProviderConfig(
        value.providerConfig.kind,
        "providerId" in value.providerConfig ? value.providerConfig.providerId : undefined,
      )
    : undefined;
  return toBinary(
    AgentStartIntentSchema,
    create(AgentStartIntentSchema, {
      ...value,
      providerConfig: providerConfig
        ? {
            kind: providerConfig.kind,
            providerId: "providerId" in providerConfig ? providerConfig.providerId : "",
          }
        : undefined,
      messageType: AGENT_START_MESSAGE_TYPE,
      wakeMessage: value.wakeMessage
        ? { ...value.wakeMessage, sequence: BigInt(value.wakeMessage.sequence) }
        : undefined,
      resumeMessages: (value.resumeMessages ?? []).map((message) => ({
        ...message,
        sequence: BigInt(message.sequence),
      })),
      unreadSummary: Object.entries(value.unreadSummary ?? {}).map(([target, count]) => ({
        target,
        count,
      })),
    }),
  );
}
export function decodeAgentStartIntent(bytes: Uint8Array): AgentStartIntent {
  const v = fromBinary(AgentStartIntentSchema, bytes);
  if (
    v.messageType !== AGENT_START_MESSAGE_TYPE ||
    !v.requestId ||
    !v.workspaceId ||
    !v.computerId ||
    !v.agentId ||
    !v.provider
  )
    throw new Error("invalid agent start intent");
  if (!["coforge", "pi", "codex", "claude-code", "kiro"].includes(v.provider))
    throw new Error(`unsupported runtime provider: ${v.provider}`);
  if (v.controlEpoch !== undefined)
    assertPositiveControlCounter(v.controlEpoch, "Agent control epoch");
  const recoveryMessages = [...(v.wakeMessage ? [v.wakeMessage] : []), ...v.resumeMessages];
  const summaryTargets = new Set(v.unreadSummary.map(({ target }) => target));
  const messageIds = new Set(recoveryMessages.map(({ messageId }) => messageId));
  const deliveryIds = new Set(recoveryMessages.map(({ deliveryId }) => deliveryId));
  if (
    v.resumeMessages.length > 100 ||
    recoveryMessages.some(
      (message) =>
        !message.messageId ||
        !message.deliveryId ||
        !message.conversationId ||
        !message.body ||
        (!message.target.startsWith("@") && !isChannelMessageTarget(message.target)) ||
        message.sequence < 1n ||
        message.sequence > BigInt(Number.MAX_SAFE_INTEGER),
    ) ||
    messageIds.size !== recoveryMessages.length ||
    deliveryIds.size !== recoveryMessages.length ||
    v.unreadSummary.some(
      (entry) =>
        (!entry.target.startsWith("@") && !isChannelMessageTarget(entry.target)) || entry.count < 1,
    ) ||
    summaryTargets.size !== v.unreadSummary.length
  )
    throw new Error("invalid agent recovery context");
  if (v.sessionMode !== undefined && v.sessionMode !== "create" && v.sessionMode !== "resume")
    throw new Error("invalid Agent session mode");
  if (v.sessionMode === "resume" && !v.sessionId)
    throw new Error("Agent resume requires a session ID");
  const recoveryMessage = (message: (typeof recoveryMessages)[number]) => ({
    messageId: message.messageId,
    deliveryId: message.deliveryId,
    conversationId: message.conversationId,
    sequence: Number(message.sequence),
    target: message.target,
    latestSender: message.latestSender,
    body: message.body,
  });
  return {
    protocolMajor: v.protocolMajor,
    requestId: v.requestId,
    workspaceId: v.workspaceId,
    computerId: v.computerId,
    agentId: v.agentId,
    provider: v.provider as AgentStartIntent["provider"],
    model: v.model,
    modelProvider: v.modelProvider,
    reasoning: v.reasoning,
    ...(v.previousLaunchId ? { previousLaunchId: v.previousLaunchId } : {}),
    providerConfig: v.providerConfig
      ? parseAgentRuntimeProviderConfig(
          v.providerConfig.kind,
          v.providerConfig.providerId || undefined,
        )
      : undefined,
    ...(v.sessionId ? { sessionId: v.sessionId } : {}),
    ...(v.sessionMode ? { sessionMode: v.sessionMode } : {}),
    ...(v.controlEpoch !== undefined ? { controlEpoch: v.controlEpoch } : {}),
    ...(v.wakeMessage ? { wakeMessage: recoveryMessage(v.wakeMessage) } : {}),
    ...(v.resumeMessages.length ? { resumeMessages: v.resumeMessages.map(recoveryMessage) } : {}),
    ...(v.unreadSummary.length
      ? {
          unreadSummary: Object.fromEntries(
            v.unreadSummary.map((entry) => [entry.target, entry.count]),
          ),
        }
      : {}),
  };
}

function assertPositiveControlCounter(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2 ** 31 - 1)
    throw new Error(`invalid ${field}`);
}

export function encodeAgentStopIntent(value: AgentStopIntent): Uint8Array {
  if ((value.provider === undefined) !== (value.controlEpoch === undefined))
    throw new Error("agent stop provider and control epoch must be paired");
  if (value.controlEpoch !== undefined)
    assertPositiveControlCounter(value.controlEpoch, "control epoch");
  return toBinary(
    AgentStopIntentSchema,
    create(AgentStopIntentSchema, { ...value, messageType: AGENT_STOP_MESSAGE_TYPE }),
  );
}

export function decodeAgentStopIntent(bytes: Uint8Array): AgentStopIntent {
  const value = fromBinary(AgentStopIntentSchema, bytes);
  if (
    value.messageType !== AGENT_STOP_MESSAGE_TYPE ||
    !value.requestId ||
    !value.workspaceId ||
    !value.computerId ||
    !value.agentId ||
    (value.provider === "" && value.controlEpoch !== undefined) ||
    (value.provider === undefined) !== (value.controlEpoch === undefined)
  )
    throw new Error("invalid agent stop intent");
  return {
    protocolMajor: value.protocolMajor,
    requestId: value.requestId,
    workspaceId: value.workspaceId,
    computerId: value.computerId,
    agentId: value.agentId,
    ...(value.provider !== undefined ? { provider: parseRuntimeProvider(value.provider) } : {}),
    ...(value.controlEpoch !== undefined ? { controlEpoch: value.controlEpoch } : {}),
    messageType: value.messageType,
  };
}

function parseAgentRuntimeProviderConfig(
  kind: string,
  providerId: string | undefined,
): AgentRuntimeProviderConfig {
  if (kind === "default" && providerId === undefined) return { kind };
  if (kind === "coforge" && providerId) return { kind, providerId };
  throw new Error("invalid Agent runtime provider config");
}

export function encodeAgentMessageDelivery(value: AgentMessageDelivery): Uint8Array {
  assertUint(value.sequence, Number.MAX_SAFE_INTEGER, "Agent message sequence");
  return toBinary(
    AgentMessageDeliverySchema,
    create(AgentMessageDeliverySchema, {
      protocolMajor: value.protocolMajor,
      requestId: value.requestId,
      messageId: value.messageId,
      deliveryId: value.deliveryId,
      sequence: BigInt(value.sequence),
      workspaceId: value.workspaceId,
      conversationId: value.conversationId,
      agentId: value.agentId,
      body: value.body,
      method: value.method,
      target: value.target,
      latestSender: value.latestSender,
    }),
  );
}
export function decodeAgentMessageDelivery(bytes: Uint8Array): AgentMessageDelivery {
  const value = fromBinary(AgentMessageDeliverySchema, bytes);
  if (
    value.method !== AGENT_MESSAGE_METHOD ||
    !value.requestId ||
    !value.messageId ||
    !value.workspaceId ||
    !value.conversationId ||
    !value.agentId ||
    !value.body
  )
    throw new Error("invalid agent message delivery");
  return {
    protocolMajor: value.protocolMajor,
    requestId: value.requestId,
    messageId: value.messageId,
    deliveryId: value.deliveryId,
    sequence: safeUint64(value.sequence, "Agent message sequence"),
    workspaceId: value.workspaceId,
    conversationId: value.conversationId,
    agentId: value.agentId,
    body: value.body,
    method: AGENT_MESSAGE_METHOD,
    ...(value.target ? { target: value.target } : {}),
    ...(value.latestSender ? { latestSender: value.latestSender } : {}),
  };
}
export function encodeAgentMessageDeliveryAck(value: AgentMessageDeliveryAck): Uint8Array {
  assertUint(value.sequence, Number.MAX_SAFE_INTEGER, "Agent delivery ACK sequence");
  return toBinary(
    AgentMessageDeliveryAckSchema,
    create(AgentMessageDeliveryAckSchema, { ...value, sequence: BigInt(value.sequence) }),
  );
}
export function decodeAgentMessageDeliveryAck(bytes: Uint8Array): AgentMessageDeliveryAck {
  const v = fromBinary(AgentMessageDeliveryAckSchema, bytes);
  if (
    v.method !== AGENT_MESSAGE_ACK_METHOD ||
    !v.requestId ||
    !v.deliveryId ||
    !v.messageId ||
    !v.workspaceId ||
    !v.agentId ||
    !v.sequence
  )
    throw new Error("invalid agent delivery ack");
  return {
    ...v,
    sequence: safeUint64(v.sequence, "Agent delivery ACK sequence"),
    method: AGENT_MESSAGE_ACK_METHOD,
  };
}
export function encodeAgentActivity(value: AgentActivity): Uint8Array {
  validateAgentActivity(value);
  return toBinary(
    AgentActivitySchema,
    create(AgentActivitySchema, {
      ...value,
      clientSeq: BigInt(value.clientSeq),
      observedAtMs: BigInt(value.observedAtMs),
      runtimeErrorClass: value.runtimeError?.errorClass ?? "",
      runtimeErrorReason: value.runtimeError?.errorReason ?? "",
      runtimeErrorFingerprint: value.runtimeError?.fingerprint ?? "",
      entries: value.entries?.map((entry) => ({
        content:
          entry.kind === "tool_start"
            ? { case: "toolName" as const, value: entry.toolName }
            : entry.kind === "thinking"
              ? { case: "thinking" as const, value: entry.text }
              : { case: "text" as const, value: entry.text },
        parentToolUseId: entry.subagent?.parentToolUseId ?? "",
      })),
    }),
  );
}
export function encodeAgentMessageRequest(value: AgentMessageRequest): Uint8Array {
  if (value.fromSequence !== undefined)
    assertUint(value.fromSequence, Number.MAX_SAFE_INTEGER, "Agent message from sequence");
  if (value.throughSequence !== undefined)
    assertUint(value.throughSequence, Number.MAX_SAFE_INTEGER, "Agent message through sequence");
  if (value.seenUpToSequence !== undefined) {
    if (value.operation !== "send")
      throw new Error("Agent message seen-up-to sequence is only valid for send");
    assertUint(
      value.seenUpToSequence,
      Number.MAX_SAFE_INTEGER,
      "Agent message seen-up-to sequence",
    );
    if (value.seenUpToSequence < 1)
      throw new Error("Agent message seen-up-to sequence must be positive");
  }
  return toBinary(
    AgentMessageRequestSchema,
    create(AgentMessageRequestSchema, {
      ...value,
      fromSequence: BigInt(value.fromSequence ?? 0),
      throughSequence: BigInt(value.throughSequence ?? 0),
      seenUpToSequence: BigInt(value.seenUpToSequence ?? 0),
    }),
  );
}
export function decodeAgentMessageRequest(bytes: Uint8Array): AgentMessageRequest {
  const v = fromBinary(AgentMessageRequestSchema, bytes);
  if (v.seenUpToSequence && v.operation !== "send")
    throw new Error("Agent message seen-up-to sequence is only valid for send");
  if (
    !v.requestId ||
    !v.agentId ||
    !["read", "search", "send", "mute", "unmute", "thread-unfollow"].includes(v.operation) ||
    (v.operation !== "search" && !v.target)
  )
    throw new Error("invalid cloud agent message request");
  return {
    ...v,
    operation: v.operation as AgentMessageRequest["operation"],
    target: v.target,
    body: v.body || undefined,
    holdToken: v.holdToken || undefined,
    continueAnyway: v.continueAnyway || undefined,
    before: v.before || undefined,
    after: v.after || undefined,
    around: v.around || undefined,
    limit: v.limit || undefined,
    query: v.query || undefined,
    sender: v.sender || undefined,
    sort: (v.sort || undefined) as AgentMessageRequest["sort"],
    offset: v.offset || undefined,
    fromSequence: v.fromSequence
      ? safeUint64(v.fromSequence, "Agent message from sequence")
      : undefined,
    throughSequence: v.throughSequence
      ? safeUint64(v.throughSequence, "Agent message through sequence")
      : undefined,
    seenUpToSequence: v.seenUpToSequence
      ? safeUint64(v.seenUpToSequence, "Agent message seen-up-to sequence")
      : undefined,
  };
}
export function encodeCloudAgentMessageResponse(value: CloudAgentMessageResponse): Uint8Array {
  return toBinary(
    CloudAgentMessageResponseSchema,
    create(CloudAgentMessageResponseSchema, {
      ...value,
      messageId: value.messageId ?? "",
      messages: value.messages.map((m) => ({
        ...m,
        sequence: BigInt(m.sequence),
        attachment: m.attachment ? encodeLocalAttachment(m.attachment) : undefined,
      })),
    }),
  );
}
export function decodeCloudAgentMessageResponse(bytes: Uint8Array): CloudAgentMessageResponse {
  const v = fromBinary(CloudAgentMessageResponseSchema, bytes);
  return {
    protocolMajor: v.protocolMajor,
    requestId: v.requestId,
    accepted: v.accepted,
    attentionCount: v.attentionCount,
    ...(v.messageId ? { messageId: v.messageId } : {}),
    messages: v.messages.map((m) => ({
      id: m.id,
      sequence: Number(m.sequence),
      sender: m.sender,
      body: m.body,
      createdAt: m.createdAt,
      target: m.target,
      ...decodeLocalAttachment(m.attachment),
    })),
    sideEffectDecision: v.sideEffectDecision
      ? (v.sideEffectDecision as CloudAgentMessageResponse["sideEffectDecision"])
      : undefined,
    holdToken: v.holdToken || undefined,
    anywayAllowed: v.anywayAllowed || undefined,
    hasOlder: v.hasOlder || undefined,
    hasNewer: v.hasNewer || undefined,
    olderCursor: v.olderCursor || undefined,
    newerCursor: v.newerCursor || undefined,
  };
}
export function decodeAgentActivity(bytes: Uint8Array): AgentActivity {
  const v = fromBinary(AgentActivitySchema, bytes);
  const entries = v.entries.map((entry): ActivityTrajectoryEntry => {
    const scope = entry.parentToolUseId
      ? { subagent: { parentToolUseId: entry.parentToolUseId } }
      : {};
    if (entry.content.case === "toolName")
      return { kind: "tool_start", toolName: entry.content.value, ...scope };
    if (entry.content.case === "thinking" || entry.content.case === "text")
      return { kind: entry.content.case, text: entry.content.value, ...scope };
    throw new Error("missing activity entry content");
  });
  const value = {
    protocolMajor: v.protocolMajor,
    requestId: v.requestId,
    workspaceId: v.workspaceId,
    agentId: v.agentId,
    detailKind: v.detailKind,
    clientSeq: Number(v.clientSeq),
    level: v.level as AgentActivity["level"],
    detail: v.detail,
    observedAtMs: Number(v.observedAtMs),
    launchId: v.launchId,
    ...(v.activityKind ? { activityKind: v.activityKind as AgentActivity["activityKind"] } : {}),
    ...(entries.length ? { entries } : {}),
    ...(v.messageId ? { messageId: v.messageId } : {}),
    ...(v.conversationId ? { conversationId: v.conversationId } : {}),
    ...(v.runtimeErrorClass
      ? {
          runtimeError: {
            errorClass: v.runtimeErrorClass,
            errorReason: v.runtimeErrorReason,
            fingerprint: v.runtimeErrorFingerprint,
          },
        }
      : {}),
  };
  validateAgentActivity(value);
  return value;
}

export function encodeAgentStatus(value: AgentStatus): Uint8Array {
  validateAgentStatus(value);
  return toBinary(
    AgentStatusSchema,
    create(AgentStatusSchema, {
      ...value,
      clientSeq: BigInt(value.clientSeq),
      observedAtMs: BigInt(value.observedAtMs),
    }),
  );
}

export function decodeAgentStatus(bytes: Uint8Array): AgentStatus {
  const value = fromBinary(AgentStatusSchema, bytes);
  const status = {
    protocolMajor: value.protocolMajor,
    requestId: value.requestId,
    workspaceId: value.workspaceId,
    computerId: value.computerId,
    agentId: value.agentId,
    status: value.status,
    daemonInstanceId: value.daemonInstanceId,
    clientSeq: Number(value.clientSeq),
    observedAtMs: Number(value.observedAtMs),
  };
  validateAgentStatus(status);
  return status;
}

function validateAgentStatus(value: {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  computerId: string;
  agentId: string;
  status: string;
  daemonInstanceId: string;
  clientSeq: number;
  observedAtMs: number;
}): asserts value is AgentStatus {
  if (
    value.protocolMajor !== 1 ||
    !value.requestId ||
    !value.workspaceId ||
    !value.computerId ||
    !value.agentId ||
    !value.daemonInstanceId ||
    !Number.isSafeInteger(value.clientSeq) ||
    value.clientSeq < 1 ||
    !Number.isSafeInteger(value.observedAtMs) ||
    value.observedAtMs < 1 ||
    (value.status !== "active" && value.status !== "inactive")
  )
    throw new Error("invalid agent status");
}

function validateAgentActivity(value: AgentActivity): void {
  if (value.entries !== undefined) parseActivityEntries(value.entries);
  if (
    value.protocolMajor !== 1 ||
    !value.requestId ||
    !value.workspaceId ||
    !value.agentId ||
    !value.launchId ||
    !Number.isSafeInteger(value.clientSeq) ||
    value.clientSeq < 1 ||
    !value.detailKind ||
    !["info", "warning", "error"].includes(value.level) ||
    (value.activityKind !== undefined &&
      !["online", "working", "thinking", "error", "offline"].includes(value.activityKind)) ||
    !Number.isSafeInteger(value.observedAtMs) ||
    value.observedAtMs < 1
  )
    throw new Error("invalid agent activity");
}
import type { Workspace, WorkspaceQueryRequest } from "./index";

const workspaceRequest = (value: WorkspaceQueryRequest) => ({
  protocolMajor: value.protocolMajor,
  requestId: value.requestId,
  workspaceSlug: value.workspaceSlug ?? "",
});
export function encodeWorkspaceListRequest(value: WorkspaceQueryRequest) {
  return toBinary(
    WorkspaceListRequestSchema,
    create(WorkspaceListRequestSchema, workspaceRequest(value)),
  );
}
export function encodeWorkspaceGetRequest(value: WorkspaceQueryRequest) {
  return toBinary(
    WorkspaceGetRequestSchema,
    create(WorkspaceGetRequestSchema, workspaceRequest(value)),
  );
}
export function decodeWorkspaceListRequest(bytes: Uint8Array) {
  const v = fromBinary(WorkspaceListRequestSchema, bytes);
  return v;
}
export function decodeWorkspaceGetRequest(bytes: Uint8Array) {
  const v = fromBinary(WorkspaceGetRequestSchema, bytes);
  return v;
}
export function decodeWorkspaceListResponse(bytes: Uint8Array) {
  const v = fromBinary(WorkspaceListResponseSchema, bytes);
  return {
    protocolMajor: v.protocolMajor,
    requestId: v.requestId,
    workspaces: v.workspaces.map(workspace),
  };
}
export function decodeWorkspaceGetResponse(bytes: Uint8Array) {
  const v = fromBinary(WorkspaceGetResponseSchema, bytes);
  if (!v.workspace) throw new Error("workspace not found");
  return {
    protocolMajor: v.protocolMajor,
    requestId: v.requestId,
    workspace: workspace(v.workspace),
  };
}
const workspace = (v: { id: string; slug: string; name: string }): Workspace => ({
  id: v.id,
  slug: v.slug,
  name: v.name,
});
export function encodeWorkspaceListResponse(value: {
  protocolMajor: number;
  requestId: string;
  workspaces: Workspace[];
}) {
  return toBinary(WorkspaceListResponseSchema, create(WorkspaceListResponseSchema, value));
}
export function encodeWorkspaceGetResponse(value: {
  protocolMajor: number;
  requestId: string;
  workspace: Workspace;
}) {
  return toBinary(WorkspaceGetResponseSchema, create(WorkspaceGetResponseSchema, value));
}

// This adapter is intentionally limited to the domain boundary: generated
// messages already use camelCase, while the domain narrows provider values and
// maps legacy/unknown enum zero values to the historical external meaning.
export function encodeComputerRegisterRequest(value: ComputerRegisterRequest): Uint8Array {
  return toBinary(
    ComputerRegisterRequestSchema,
    create(ComputerRegisterRequestSchema, {
      ...value,
    }),
  );
}

export function decodeComputerRegisterRequest(bytes: Uint8Array): ComputerRegisterRequest {
  const value = fromBinary(ComputerRegisterRequestSchema, bytes);
  return {
    protocolMajor: value.protocolMajor,
    requestId: value.requestId,
    workspaceSlug: value.workspaceSlug,
    name: value.name,
    displayName: value.displayName,
    machineId: value.machineId,
    platform: value.platform,
    osVersion: value.osVersion,
    computerVersion: value.computerVersion,
    registrationIdempotencyKey: value.registrationIdempotencyKey,
  };
}

function parseRuntimeProvider(value: string): RuntimeProvider {
  if (isRuntimeProvider(value)) return value;
  throw new Error(`unsupported runtime provider: ${value}`);
}

function isRuntimeProvider(value: string): value is RuntimeProvider {
  return Object.values(RUNTIME_PROVIDER).some((provider) => provider === value);
}

export function decodeComputerRegisterResponse(bytes: Uint8Array): ComputerRegisterResponse {
  const value = fromBinary(ComputerRegisterResponseSchema, bytes);
  return {
    protocolMajor: value.protocolMajor,
    requestId: value.requestId,
    computerId: value.computerId,
    workspaceId: value.workspaceId,
    daemonApiKey: value.daemonApiKey,
  };
}

export function encodeComputerRegisterResponse(value: ComputerRegisterResponse): Uint8Array {
  return toBinary(ComputerRegisterResponseSchema, create(ComputerRegisterResponseSchema, value));
}
