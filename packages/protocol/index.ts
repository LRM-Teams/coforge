/** TypeScript boundary approved by ADR 0004; codec/transport remains an adapter concern. */
export const COMPUTER_REGISTER_METHOD = "computer:register" as const;
export const COMPUTER_REGISTER_PROTOCOL_MAJOR = 1 as const;
export const WORKSPACE_LIST_METHOD = "workspace:list" as const;
export const WORKSPACE_GET_METHOD = "workspace:get" as const;
export const WORKSPACE_WORKER_READY_METHOD = "workspace_worker:ready" as const;
export const WORKSPACE_WORKER_CODE_AGENTS_UPDATE_METHOD =
  "workspace_worker:code_agents_update" as const;
export const AGENT_START_METHOD = "agent:start" as const;
export const AGENT_MESSAGE_METHOD = "agent:deliver" as const;
export const AGENT_MESSAGE_ACK_METHOD = "agent:deliver:ack" as const;
export const AGENT_MESSAGE_CHECK_METHOD = "agent:message:check" as const;
export const AGENT_MESSAGE_READ_METHOD = "agent:message:read" as const;
export const AGENT_MESSAGE_SEND_METHOD = "agent:message:send" as const;
export const AGENT_ACTIVITY_METHOD = "agent:activity" as const;
export const WORKSPACE_PROTOCOL_MAJOR = COMPUTER_REGISTER_PROTOCOL_MAJOR;
export type Workspace = { id: string; slug: string; name: string };

export type WorkspaceQueryRequest = {
  protocolMajor: number;
  requestId: string;
  workspaceSlug?: string;
};

export const RUNTIME_KINDS = ["external", "builtin"] as const;
export type RuntimeKind = (typeof RUNTIME_KINDS)[number];
export const RUNTIME_PROVIDER = {
  CODEX: "codex",
  CLAUDE_CODE: "claude-code",
  PI: "pi",
} as const;
export type RuntimeProvider = (typeof RUNTIME_PROVIDER)[keyof typeof RUNTIME_PROVIDER];
export type RuntimeMetadata = {
  provider: RuntimeProvider;
  version: string;
  /** Defaults to external when decoding a pre-kind payload. */
  kind: RuntimeKind;
};
export type CodeAgentModelMetadata = {
  id: string;
  displayName: string;
  description: string;
  modelProvider: string;
  reasoningEfforts: string[];
  defaultReasoning: string;
  recommended: boolean;
};
export type CodeAgentModelCatalog = {
  provider: RuntimeProvider;
  models: CodeAgentModelMetadata[];
};
export type ComputerRegisterRequest = {
  protocolMajor: number;
  requestId: string;
  workspaceSlug: string;
  machineId: string;
  platform: string;
  osVersion: string;
  computerVersion: string;
  runtimes: RuntimeMetadata[];
  registrationIdempotencyKey: string;
};
export type ComputerRegisterResponse = {
  protocolMajor: number;
  requestId: string;
  computerId: string;
  workspaceId: string;
  workspaceWorkerToken: string;
};
export type WorkspaceWorkerReadyRequest = {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  computerId: string;
  workerInstanceId: string;
  startedAt: number;
};
export type WorkspaceWorkerCodeAgentsUpdateRequest = {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  computerId: string;
  runtimes: RuntimeMetadata[];
  catalogs: CodeAgentModelCatalog[];
};
export type AgentStartIntent = {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  computerId?: string;
  agentId: string;
  provider: RuntimeProvider;
  model: string;
  modelProvider?: string;
  reasoning: string;
  sessionId?: string;
};
export type AgentMessageDelivery = {
  protocolMajor: number;
  requestId: string;
  messageId: string;
  deliveryId: string;
  sequence: number;
  workspaceId: string;
  conversationId: string;
  agentId: string;
  body: string;
  method: typeof AGENT_MESSAGE_METHOD;
  target?: string;
  latestSender?: string;
};
export type AgentMessageDeliveryAck = Omit<
  AgentMessageDelivery,
  "body" | "conversationId" | "method" | "requestId"
> & { method: typeof AGENT_MESSAGE_ACK_METHOD; requestId: string };
export type AgentActivity = {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  agentId: string;
  activity: string;
  level: "info" | "warning" | "error";
  message: string;
  messageId?: string;
  conversationId?: string;
  occurredAt: string;
  launchId: string;
  clientSeq: number;
};
export type AgentMessageRequest = {
  protocolMajor: number;
  requestId: string;
  agentId: string;
  workspaceId: string;
  operation: "read" | "send";
  target: string;
  body?: string;
};
export type CloudAgentMessageResponse = {
  protocolMajor: number;
  requestId: string;
  accepted: boolean;
  attentionCount: number;
  messageId?: string;
  messages: {
    id: string;
    sequence: number;
    sender: string;
    body: string;
    createdAt: string;
    target: string;
    attachment?: {
      id: string;
      fileName: string;
      contentType: string;
      sizeBytes: number;
    };
  }[];
};

export interface ComputerRegisterTransport {
  request(
    method: typeof COMPUTER_REGISTER_METHOD,
    payload: ComputerRegisterRequest,
  ): Promise<ComputerRegisterResponse>;
}

export class ComputerRegistrationClient {
  constructor(private readonly transport: ComputerRegisterTransport) {}
  register(request: ComputerRegisterRequest): Promise<ComputerRegisterResponse> {
    if (request.protocolMajor !== COMPUTER_REGISTER_PROTOCOL_MAJOR)
      throw new Error("unsupported computer register protocol major");
    return this.transport.request(COMPUTER_REGISTER_METHOD, request).then((response) => {
      if (response.protocolMajor !== COMPUTER_REGISTER_PROTOCOL_MAJOR)
        throw new Error("unsupported response protocol major");
      return response;
    });
  }
}

export interface WorkspaceQueryTransport {
  listAccessible(request: WorkspaceQueryRequest): Promise<Workspace[]>;
  getBySlug(request: WorkspaceQueryRequest): Promise<Workspace>;
}

export {
  DAEMON_HANDSHAKE_METHOD,
  decodeDaemonHandshakeRequest,
  decodeDaemonHandshakeResponse,
  encodeDaemonHandshakeRequest,
  encodeDaemonHandshakeResponse,
  frameLocalRpc,
  readLocalRpcFrame,
  readLocalRpcFrames,
  WORKSPACE_WORKER_CONFIGURE_METHOD,
  LOCAL_RPC_PROTOCOL_MAJOR,
  LOCAL_RPC_METHODS,
  encodeLocalRpcRequest,
  decodeLocalRpcRequest,
  encodeLocalRpcResponse,
  decodeLocalRpcResponse,
  encodeWorkspaceWorkerConfigureRequest,
  decodeWorkspaceWorkerConfigureRequest,
  encodeWorkspaceWorkerConfigureResponse,
  decodeWorkspaceWorkerConfigureResponse,
  encodeDaemonCommandRequest,
  decodeDaemonCommandRequest,
  encodeDaemonCommandResponse,
  decodeDaemonCommandResponse,
  encodeLocalAgentMessageRequest,
  decodeLocalAgentMessageRequest,
  encodeAgentMessageResponse,
  decodeAgentMessageResponse,
} from "./local-daemon";
export type {
  DaemonHandshakeRequest,
  DaemonHandshakeResponse,
  WorkspaceWorkerConfigureRequest,
  WorkspaceWorkerConfigureResponse,
  LocalRpcRequest,
  LocalRpcResponse,
  DaemonCommandRequest,
  DaemonCommandResponse,
  LocalAgentMessageRequest,
  AgentMessageResponse,
} from "./local-daemon";
export {
  encodeWorkspaceWorkerReadyRequest,
  decodeWorkspaceWorkerReadyRequest,
  encodeWorkspaceWorkerCodeAgentsUpdateRequest,
  decodeWorkspaceWorkerCodeAgentsUpdateRequest,
} from "./codec";
export {
  encodeAgentStartIntent,
  decodeAgentStartIntent,
  encodeAgentMessageDelivery,
  decodeAgentMessageDelivery,
  encodeAgentMessageDeliveryAck,
  decodeAgentMessageDeliveryAck,
  encodeAgentActivity,
  decodeAgentActivity,
  encodeAgentMessageRequest,
  decodeAgentMessageRequest,
  encodeCloudAgentMessageResponse,
  decodeCloudAgentMessageResponse,
} from "./codec";
