import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  ComputerRegisterRequestSchema,
  ComputerRegisterResponseSchema,
  RuntimeKind,
} from "./gen/coforge/rpc/v1/computer_register_pb";
import {
  RUNTIME_PROVIDER,
  type ComputerRegisterRequest,
  type ComputerRegisterResponse,
  type RuntimeProvider,
} from "./index";
import {
  WorkspaceGetRequestSchema,
  WorkspaceGetResponseSchema,
  WorkspaceListRequestSchema,
  WorkspaceListResponseSchema,
} from "./gen/coforge/rpc/v1/workspace_pb";
import { WorkspaceWorkerReadyRequestSchema } from "./gen/coforge/rpc/v1/computer_register_pb";
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
import { AGENT_MESSAGE_METHOD, AGENT_MESSAGE_ACK_METHOD } from "./index";
import type { WorkspaceWorkerReadyRequest } from "./index";

export function encodeWorkspaceWorkerReadyRequest(value: WorkspaceWorkerReadyRequest): Uint8Array {
  return toBinary(
    WorkspaceWorkerReadyRequestSchema,
    create(WorkspaceWorkerReadyRequestSchema, {
      ...value,
      startedAt: BigInt(value.startedAt),
    }),
  );
}

export function decodeWorkspaceWorkerReadyRequest(bytes: Uint8Array): WorkspaceWorkerReadyRequest {
  const value = fromBinary(WorkspaceWorkerReadyRequestSchema, bytes);
  return { ...value, startedAt: Number(value.startedAt) };
}

export function encodeAgentStartIntent(value: AgentStartIntent): Uint8Array {
  return toBinary(AgentStartIntentSchema, create(AgentStartIntentSchema, value));
}
export function decodeAgentStartIntent(bytes: Uint8Array): AgentStartIntent {
  const v = fromBinary(AgentStartIntentSchema, bytes);
  if (!v.requestId || !v.workspaceId || !v.agentId || !v.provider)
    throw new Error("invalid agent start intent");
  if (!["pi", "codex", "claude-code"].includes(v.provider))
    throw new Error(`unsupported runtime provider: ${v.provider}`);
  return {
    ...v,
    provider: v.provider as AgentStartIntent["provider"],
    sessionId: v.sessionId || undefined,
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
  return toBinary(AgentActivitySchema, create(AgentActivitySchema, value));
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
      messages: value.messages.map((m) => ({ ...m, sequence: BigInt(m.sequence) })),
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
    messageId: v.messageId || undefined,
    messages: v.messages.map((m) => ({ ...m, sequence: Number(m.sequence) })),
  };
}
export function decodeAgentActivity(bytes: Uint8Array): AgentActivity {
  const v = fromBinary(AgentActivitySchema, bytes);
  return {
    ...v,
    level: v.level as AgentActivity["level"],
  };
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
      runtimes: value.runtimes.map((runtime) => ({
        ...runtime,
        kind: runtime.kind === "builtin" ? RuntimeKind.BUILTIN : RuntimeKind.EXTERNAL,
      })),
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
    runtimes: value.runtimes.map((runtime) => ({
      provider: parseRuntimeProvider(runtime.provider),
      version: runtime.version,
      kind: runtime.kind === RuntimeKind.BUILTIN ? "builtin" : "external",
    })),
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
    workspaceWorkerToken: value.workspaceWorkerToken,
  };
}

export function encodeComputerRegisterResponse(value: ComputerRegisterResponse): Uint8Array {
  return toBinary(ComputerRegisterResponseSchema, create(ComputerRegisterResponseSchema, value));
}
