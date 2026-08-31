import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  ComputerRegisterRequestSchema,
  ComputerRegisterResponseSchema,
  RuntimeKind,
} from "./gen/coforge/rpc/v1/computer_pb";
import {
  RUNTIME_PROVIDER,
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
} from "./gen/coforge/rpc/v1/daemon_runtime_pb";
import {
  AgentStartIntentSchema,
  AgentMessageDeliverySchema,
  AgentActivitySchema,
  AgentMessageDeliveryAckSchema,
  AgentMessageRequestSchema,
  CloudAgentMessageResponseSchema,
} from "./gen/coforge/rpc/v1/workspace_pb";
import type {
  AgentStartIntent,
  AgentMessageDelivery,
  AgentActivity,
  AgentMessageDeliveryAck,
  AgentMessageRequest,
  CloudAgentMessageResponse,
} from "./index";
import {
  AGENT_START_MESSAGE_TYPE,
  USAGE_SCAN_MESSAGE_TYPE,
  USAGE_SCAN_RESPONSE_MESSAGE_TYPE,
} from "./index";
import { AGENT_MESSAGE_METHOD, AGENT_MESSAGE_ACK_METHOD } from "./index";
import { encodeLocalAttachment, decodeLocalAttachment } from "./local-daemon";
import type {
  RuntimeMetadata,
  DaemonRuntimeCodeAgentsUpdateRequest,
  DaemonRuntimeReadyRequest,
} from "./index";

const runtimeMetadata = (runtime: RuntimeMetadata) => ({
  ...runtime,
  kind: runtime.kind === "builtin" ? RuntimeKind.BUILTIN : RuntimeKind.EXTERNAL,
});

const decodedRuntimeMetadata = (runtime: {
  provider: string;
  version: string;
  displayName: string;
  kind: RuntimeKind;
}): RuntimeMetadata => ({
  provider: parseRuntimeProvider(runtime.provider),
  version: runtime.version,
  displayName: runtime.displayName,
  kind: runtime.kind === RuntimeKind.BUILTIN ? "builtin" : "external",
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

export function encodeDaemonRuntimeReadyRequest(value: DaemonRuntimeReadyRequest): Uint8Array {
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
  return { ...value, startedAt: Number(value.startedAt) };
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

export function encodeAgentStartIntent(value: AgentStartIntent): Uint8Array {
  return toBinary(
    AgentStartIntentSchema,
    create(AgentStartIntentSchema, { ...value, messageType: AGENT_START_MESSAGE_TYPE }),
  );
}
export function decodeAgentStartIntent(bytes: Uint8Array): AgentStartIntent {
  const v = fromBinary(AgentStartIntentSchema, bytes);
  if (
    v.messageType !== AGENT_START_MESSAGE_TYPE ||
    !v.requestId ||
    !v.workspaceId ||
    !v.agentId ||
    !v.provider
  )
    throw new Error("invalid agent start intent");
  if (!["pi", "codex", "claude-code"].includes(v.provider))
    throw new Error(`unsupported runtime provider: ${v.provider}`);
  return {
    protocolMajor: v.protocolMajor,
    requestId: v.requestId,
    workspaceId: v.workspaceId,
    agentId: v.agentId,
    provider: v.provider as AgentStartIntent["provider"],
    model: v.model,
    modelProvider: v.modelProvider,
    reasoning: v.reasoning,
    ...(v.sessionId ? { sessionId: v.sessionId } : {}),
    computerId: v.computerId || undefined,
  };
}
export function encodeAgentMessageDelivery(value: AgentMessageDelivery): Uint8Array {
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
    sequence: Number(value.sequence),
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
  return { ...v, sequence: Number(v.sequence), method: AGENT_MESSAGE_ACK_METHOD };
}
export function encodeAgentActivity(value: AgentActivity): Uint8Array {
  validateAgentActivity(value);
  return toBinary(
    AgentActivitySchema,
    create(AgentActivitySchema, { ...value, clientSeq: BigInt(value.clientSeq) }),
  );
}
export function encodeAgentMessageRequest(value: AgentMessageRequest): Uint8Array {
  return toBinary(AgentMessageRequestSchema, create(AgentMessageRequestSchema, value));
}
export function decodeAgentMessageRequest(bytes: Uint8Array): AgentMessageRequest {
  const v = fromBinary(AgentMessageRequestSchema, bytes);
  if (!v.requestId || !v.agentId || !["read", "send"].includes(v.operation) || !v.target)
    throw new Error("invalid cloud agent message request");
  return {
    ...v,
    operation: v.operation as AgentMessageRequest["operation"],
    body: v.body || undefined,
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
  };
}
export function decodeAgentActivity(bytes: Uint8Array): AgentActivity {
  const v = fromBinary(AgentActivitySchema, bytes);
  const value = {
    protocolMajor: v.protocolMajor,
    requestId: v.requestId,
    workspaceId: v.workspaceId,
    agentId: v.agentId,
    activity: v.activity,
    clientSeq: Number(v.clientSeq),
    level: v.level as AgentActivity["level"],
    message: v.message,
    occurredAt: v.occurredAt,
    launchId: v.launchId,
    ...(v.messageId ? { messageId: v.messageId } : {}),
    ...(v.conversationId ? { conversationId: v.conversationId } : {}),
  };
  validateAgentActivity(value);
  return value;
}

function validateAgentActivity(value: AgentActivity): void {
  if (
    value.protocolMajor !== 1 ||
    !value.requestId ||
    !value.workspaceId ||
    !value.agentId ||
    !value.launchId ||
    !Number.isSafeInteger(value.clientSeq) ||
    value.clientSeq < 1 ||
    !value.activity ||
    !["info", "warning", "error"].includes(value.level) ||
    !value.occurredAt ||
    Number.isNaN(Date.parse(value.occurredAt))
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
      runtimes: value.runtimes.map(runtimeMetadata),
    }),
  );
}

export function decodeComputerRegisterRequest(bytes: Uint8Array): ComputerRegisterRequest {
  const value = fromBinary(ComputerRegisterRequestSchema, bytes);
  return {
    protocolMajor: value.protocolMajor,
    requestId: value.requestId,
    workspaceSlug: value.workspaceSlug,
    machineId: value.machineId,
    platform: value.platform,
    osVersion: value.osVersion,
    computerVersion: value.computerVersion,
    registrationIdempotencyKey: value.registrationIdempotencyKey,
    runtimes: value.runtimes.map(decodedRuntimeMetadata),
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
    daemonToken: value.daemonToken,
  };
}

export function encodeComputerRegisterResponse(value: ComputerRegisterResponse): Uint8Array {
  return toBinary(ComputerRegisterResponseSchema, create(ComputerRegisterResponseSchema, value));
}
