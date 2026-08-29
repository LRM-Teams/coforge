import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  DaemonHandshakeRequestSchema,
  DaemonHandshakeResponseSchema,
  WorkspaceWorkerConfigureRequestSchema,
  WorkspaceWorkerConfigureResponseSchema,
  DaemonCommandRequestSchema,
  DaemonCommandResponseSchema,
  LocalRpcRequestSchema,
  LocalRpcResponseSchema,
  LocalAgentMessageRequestSchema,
  AgentMessageResponseSchema,
} from "./gen/coforge/rpc/v1/computer_register_pb";

export const LOCAL_RPC_PROTOCOL_MAJOR = 1 as const;
export const LOCAL_RPC_METHODS = {
  HANDSHAKE: "daemon:handshake",
  CONFIGURE: "workspace-worker:configure",
  START: "daemon:start",
  STOP: "daemon:stop",
  RESTART: "daemon:restart",
  AGENT_MESSAGE: "agent:message",
} as const;
export type LocalAgentMessageRequest = {
  requestId: string;
  context: string;
  operation: "check" | "read" | "send";
  target?: string;
  body?: string;
};
export type AgentMessageRecord = {
  id: string;
  sequence: number;
  sender: string;
  target: string;
  body: string;
  createdAt: string;
};
export type AgentMessageResponse = {
  requestId: string;
  accepted: boolean;
  attentionCount: number;
  messages: AgentMessageRecord[];
  messageId: string;
  summaries: MessageAttentionSummary[];
};
export type MessageAttentionSummary = {
  target: string;
  pendingCount: number;
  firstPendingSequence: number;
  latestSequence: number;
  latestSender?: string;
  flags: string[];
};
export function encodeLocalAgentMessageRequest(value: LocalAgentMessageRequest): Uint8Array {
  return toBinary(LocalAgentMessageRequestSchema, create(LocalAgentMessageRequestSchema, value));
}
export function decodeLocalAgentMessageRequest(bytes: Uint8Array): LocalAgentMessageRequest {
  const v = fromBinary(LocalAgentMessageRequestSchema, bytes);
  return {
    requestId: v.requestId,
    context: v.context,
    operation: v.operation as LocalAgentMessageRequest["operation"],
    target: v.target || undefined,
    body: v.body || undefined,
  };
}
export function encodeAgentMessageResponse(value: AgentMessageResponse): Uint8Array {
  return toBinary(
    AgentMessageResponseSchema,
    create(AgentMessageResponseSchema, {
      ...value,
      messages: value.messages.map((m) => ({
        ...m,
        sequence: BigInt(m.sequence),
        createdAt: m.createdAt,
      })),
      summaries: value.summaries.map((summary) => ({
        ...summary,
        firstPendingSequence: BigInt(summary.firstPendingSequence),
        latestSequence: BigInt(summary.latestSequence),
      })),
    }),
  );
}
export function decodeAgentMessageResponse(bytes: Uint8Array): AgentMessageResponse {
  const v = fromBinary(AgentMessageResponseSchema, bytes);
  return {
    requestId: v.requestId,
    accepted: v.accepted,
    attentionCount: v.attentionCount,
    messageId: v.messageId,
    summaries: v.summaries.map((summary) => ({
      target: summary.target,
      pendingCount: summary.pendingCount,
      firstPendingSequence: Number(summary.firstPendingSequence),
      latestSequence: Number(summary.latestSequence),
      ...(summary.latestSender !== undefined ? { latestSender: summary.latestSender } : {}),
      flags: summary.flags,
    })),
    messages: v.messages.map((m) => ({
      id: m.id,
      sequence: Number(m.sequence),
      sender: m.sender,
      target: m.target,
      body: m.body,
      createdAt: m.createdAt,
    })),
  };
}
export const DAEMON_HANDSHAKE_METHOD = LOCAL_RPC_METHODS.HANDSHAKE;
export const WORKSPACE_WORKER_CONFIGURE_METHOD = LOCAL_RPC_METHODS.CONFIGURE;
export type WorkspaceWorkerConfigureRequest = {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  workspaceRoot: string;
  workspaceWorkerToken: string;
  computerId: string;
};
export type WorkspaceWorkerConfigureResponse = {
  protocolMajor: number;
  requestId: string;
  accepted: boolean;
};
export type DaemonCommandRequest = { protocolMajor: number; requestId: string };
export type DaemonCommandResponse = {
  protocolMajor: number;
  requestId: string;
  accepted: boolean;
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

export function encodeWorkspaceWorkerConfigureRequest(
  value: WorkspaceWorkerConfigureRequest,
): Uint8Array {
  return toBinary(
    WorkspaceWorkerConfigureRequestSchema,
    create(WorkspaceWorkerConfigureRequestSchema, value),
  );
}
export function decodeWorkspaceWorkerConfigureRequest(
  bytes: Uint8Array,
): WorkspaceWorkerConfigureRequest {
  const v = fromBinary(WorkspaceWorkerConfigureRequestSchema, bytes);
  return {
    protocolMajor: v.protocolMajor,
    requestId: v.requestId,
    workspaceId: v.workspaceId,
    workspaceRoot: v.workspaceRoot,
    workspaceWorkerToken: v.workspaceWorkerToken,
    computerId: v.computerId,
  };
}
export function encodeWorkspaceWorkerConfigureResponse(
  value: WorkspaceWorkerConfigureResponse,
): Uint8Array {
  return toBinary(
    WorkspaceWorkerConfigureResponseSchema,
    create(WorkspaceWorkerConfigureResponseSchema, value),
  );
}
export function decodeWorkspaceWorkerConfigureResponse(
  bytes: Uint8Array,
): WorkspaceWorkerConfigureResponse {
  const v = fromBinary(WorkspaceWorkerConfigureResponseSchema, bytes);
  return { protocolMajor: v.protocolMajor, requestId: v.requestId, accepted: v.accepted };
}

export function encodeDaemonCommandRequest(value: DaemonCommandRequest): Uint8Array {
  return toBinary(DaemonCommandRequestSchema, create(DaemonCommandRequestSchema, value));
}
export function decodeDaemonCommandRequest(bytes: Uint8Array): DaemonCommandRequest {
  const value = fromBinary(DaemonCommandRequestSchema, bytes);
  return { protocolMajor: value.protocolMajor, requestId: value.requestId };
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
