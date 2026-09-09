/** TypeScript boundary approved by ADR 0004; codec/transport remains an adapter concern. */
export const COMPUTER_REGISTER_METHOD = "computer:register" as const;
export const COMPUTER_REGISTER_PROTOCOL_MAJOR = 1 as const;
export const WORKSPACE_LIST_METHOD = "workspace:list" as const;
export const WORKSPACE_GET_METHOD = "workspace:get" as const;
export const DAEMON_RUNTIME_READY_METHOD = "daemon:runtime_ready" as const;
export const DAEMON_CONNECTION_STATUS_METHOD = "daemon:connection_status" as const;
export const DAEMON_RUNTIME_CODE_AGENTS_UPDATE_METHOD = "daemon:code_agents_update" as const;
export const DAEMON_RUNTIME_USAGE_SCAN_METHOD = "daemon:usage_scan" as const;
export const DAEMON_RUNTIME_USAGE_SCAN_RESULT_METHOD = "daemon:usage_scan_result" as const;
export const COMPUTER_RESTART_METHOD = "computer:restart" as const;
export const COMPUTER_RESTART_MESSAGE_TYPE = "coforge.rpc.v1.ComputerRestartIntent" as const;
export const AGENT_START_METHOD = "agent:start" as const;
export const AGENT_START_MESSAGE_TYPE = "coforge.rpc.v1.AgentStartIntent" as const;
export const AGENT_STOP_METHOD = "agent:stop" as const;
export const AGENT_STOP_MESSAGE_TYPE = "coforge.rpc.v1.AgentStopIntent" as const;
export const USAGE_SCAN_MESSAGE_TYPE = "coforge.rpc.v1.DaemonRuntimeUsageScanRequest" as const;
export const USAGE_SCAN_RESPONSE_MESSAGE_TYPE =
  "coforge.rpc.v1.DaemonRuntimeUsageScanResponse" as const;
export type DaemonRuntimeMessageType =
  | typeof AGENT_START_MESSAGE_TYPE
  | typeof AGENT_STOP_MESSAGE_TYPE
  | typeof USAGE_SCAN_MESSAGE_TYPE
  | typeof USAGE_SCAN_RESPONSE_MESSAGE_TYPE;
export const AGENT_MESSAGE_METHOD = "agent:deliver" as const;
export const AGENT_MESSAGE_ACK_METHOD = "agent:deliver:ack" as const;
export const AGENT_MESSAGE_CHECK_METHOD = "agent:message:check" as const;
export const AGENT_MESSAGE_READ_METHOD = "agent:message:read" as const;
export const AGENT_MESSAGE_SEARCH_METHOD = "agent:message:search" as const;
export const AGENT_MESSAGE_SEND_METHOD = "agent:message:send" as const;
export const AGENT_CHANNEL_MUTE_METHOD = "agent:channel:mute" as const;
export const AGENT_CHANNEL_UNMUTE_METHOD = "agent:channel:unmute" as const;
export const isChannelMessageTarget = (target: string): boolean =>
  /^#[a-z0-9][a-z0-9_-]{0,31}$/.test(target);
export const AGENT_MESSAGE_VALIDATION_MESSAGES = [
  "message anchor must be eight hexadecimal characters or a full UUID",
  "ambiguous message prefix; use the full UUID",
  "message anchor not found in this conversation",
  "thread root must be a top-level message",
  "message anchor is outside this target",
] as const;
export type AgentMessageValidationMessage = (typeof AGENT_MESSAGE_VALIDATION_MESSAGES)[number];
export const AGENT_STATUS_METHOD = "agent:status" as const;
export const AGENT_ACTIVITY_METHOD = "agent:activity" as const;
export const AGENT_SESSION_METHOD = "agent:session" as const;
export type AgentSessionReport = {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  computerId: string;
  agentId: string;
  provider: RuntimeProvider;
  sessionId: string;
  startRequestId: string;
  daemonInstanceId: string;
  launchId: string;
  previousLaunchId?: string;
  replacedSessionId?: string;
  controlEpoch?: number;
  sequence?: number;
  sessionState?: "empty" | "resumable" | "unknown";
};
export const WORKSPACE_PROTOCOL_MAJOR = COMPUTER_REGISTER_PROTOCOL_MAJOR;
export type Workspace = { id: string; slug: string; name: string };

export type WorkspaceQueryRequest = {
  protocolMajor: number;
  requestId: string;
  workspaceSlug?: string;
};

export const RUNTIME_PROVIDER = {
  COFORGE: "coforge",
  CODEX: "codex",
  CLAUDE_CODE: "claude-code",
  PI: "pi",
} as const;
export type RuntimeProvider = (typeof RUNTIME_PROVIDER)[keyof typeof RUNTIME_PROVIDER];
export type AgentRuntimeProviderConfig =
  | { kind: "default" }
  | { kind: "coforge"; providerId: string };
export type RuntimeMetadata = {
  provider: RuntimeProvider;
  version: string;
  displayName: string;
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
  name: string;
  displayName: string;
  machineId: string;
  platform: string;
  osVersion: string;
  computerVersion: string;
  registrationIdempotencyKey: string;
};
export type ComputerRegisterResponse = {
  protocolMajor: number;
  requestId: string;
  computerId: string;
  workspaceId: string;
  daemonApiKey: string;
};
export type DaemonRuntimeReadyRequest = {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  computerId: string;
  workerInstanceId: string;
  daemonVersion?: string;
  startedAt: number;
  runningAgentIds: string[];
  recoveredRestartRequestIds?: string[];
  capabilities?: string[];
};
export type ComputerRestartIntent = {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  computerId: string;
  messageType?: typeof COMPUTER_RESTART_MESSAGE_TYPE;
};
export type DaemonRuntimeCodeAgentsUpdateRequest = {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  computerId: string;
  runtimes: RuntimeMetadata[];
  catalogs: CodeAgentModelCatalog[];
};
export type DaemonRuntimeUsageScanRequest = {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  computerId: string;
  provider: RuntimeProvider;
  messageType?: DaemonRuntimeMessageType;
};
export type DaemonRuntimeUsageScanResponse = DaemonRuntimeUsageScanRequest & {
  accepted: boolean;
  status: string;
  message?: string;
  snapshotJson?: Uint8Array;
};
export type AgentStartIntent = {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  computerId: string;
  agentId: string;
  provider: RuntimeProvider;
  model: string;
  modelProvider?: string;
  reasoning: string;
  sessionId?: string;
  sessionMode?: "create" | "resume";
  previousLaunchId?: string;
  controlEpoch?: number;
  providerConfig?: AgentRuntimeProviderConfig;
  wakeMessage?: AgentRecoveryMessage;
  resumeMessages?: AgentRecoveryMessage[];
  unreadSummary?: Readonly<Record<string, number>>;
};
export type AgentStopIntent = {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  computerId: string;
  agentId: string;
  provider?: RuntimeProvider;
  controlEpoch?: number;
  messageType?: typeof AGENT_STOP_MESSAGE_TYPE;
};
export type AgentRecoveryMessage = {
  messageId: string;
  deliveryId: string;
  conversationId: string;
  sequence: number;
  target: string;
  latestSender: string;
  body: string;
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
export { parseActivityEntries } from "./activity-entries";
export type { ActivityTrajectoryEntry, ActivitySubagent } from "./activity-entries";
export type AgentActivity = {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  agentId: string;
  detailKind: string;
  level: "info" | "warning" | "error";
  detail: string;
  messageId?: string;
  conversationId?: string;
  observedAtMs: number;
  launchId: string;
  clientSeq: number;
  entries?: import("./activity-entries").ActivityTrajectoryEntry[];
  runtimeError?: {
    errorClass: string;
    errorReason: string;
    fingerprint: string;
  };
};
export type AgentStatus = {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  computerId: string;
  agentId: string;
  status: "active" | "inactive";
  daemonInstanceId: string;
  clientSeq: number;
  observedAtMs: number;
};
export type AgentMessageRequest = {
  protocolMajor: number;
  requestId: string;
  agentId: string;
  workspaceId: string;
  fromSequence?: number;
  throughSequence?: number;
  operation: "read" | "search" | "send" | "mute" | "unmute";
  target: string;
  body?: string;
  holdToken?: string;
  continueAnyway?: boolean;
  before?: string;
  after?: string;
  around?: string;
  limit?: number;
  query?: string;
  sender?: string;
  sort?: "relevance" | "recent";
  offset?: number;
  seenUpToSequence?: number;
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
  sideEffectDecision?: "forward" | "hold" | "anyway_denied" | "anyway_accepted";
  holdToken?: string;
  anywayAllowed?: boolean;
  hasOlder?: boolean;
  hasNewer?: boolean;
  olderCursor?: string;
  newerCursor?: string;
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
  DAEMON_RUNTIME_CONFIGURE_METHOD,
  LOCAL_RPC_PROTOCOL_MAJOR,
  LOCAL_RPC_METHODS,
  encodeLocalRpcRequest,
  decodeLocalRpcRequest,
  encodeLocalRpcResponse,
  decodeLocalRpcResponse,
  encodeDaemonRuntimeConfigureRequest,
  decodeDaemonRuntimeConfigureRequest,
  encodeDaemonRuntimeConfigureResponse,
  decodeDaemonRuntimeConfigureResponse,
  encodeDaemonCommandRequest,
  decodeDaemonCommandRequest,
  encodeDaemonCommandResponse,
  decodeDaemonCommandResponse,
  encodeLocalAgentMessageRequest,
  decodeLocalAgentMessageRequest,
  encodeAgentMessageResponse,
  decodeAgentMessageResponse,
  encodeLocalInboxRequest,
  decodeLocalInboxRequest,
  encodeInboxResponse,
  decodeInboxResponse,
  encodeLocalAttachment,
  decodeLocalAttachment,
  encodeUsageScanRequest,
  decodeUsageScanRequest,
  encodeUsageScanResponse,
  decodeUsageScanResponse,
} from "./local-daemon";
export type { AgentMessageRecord } from "./local-daemon";
export type {
  DaemonHandshakeRequest,
  DaemonHandshakeResponse,
  DaemonRuntimeConfigureRequest,
  DaemonRuntimeConfigureResponse,
  LocalRpcRequest,
  LocalRpcResponse,
  DaemonCommandRequest,
  DaemonCommandResponse,
  ManagedRuntimeIdentity,
  LocalAgentMessageRequest,
  AgentMessageResponse,
  LocalInboxRequest,
  InboxResponse,
  InboxEntry,
  AppInboxItem,
  UsageScanRequest,
  UsageScanResponse,
} from "./local-daemon";
export {
  encodeDaemonRuntimeReadyRequest,
  decodeDaemonRuntimeReadyRequest,
  encodeDaemonRuntimeCodeAgentsUpdateRequest,
  decodeDaemonRuntimeCodeAgentsUpdateRequest,
  encodeDaemonRuntimeUsageScanRequest,
  decodeDaemonRuntimeUsageScanRequest,
  encodeDaemonRuntimeUsageScanResponse,
  decodeDaemonRuntimeUsageScanResponse,
  encodeComputerRestartIntent,
  decodeComputerRestartIntent,
} from "./codec";
export {
  encodeAgentSessionReport,
  decodeAgentSessionReport,
  encodeAgentStartIntent,
  decodeAgentStartIntent,
  encodeAgentStopIntent,
  decodeAgentStopIntent,
  encodeAgentMessageDelivery,
  decodeAgentMessageDelivery,
  encodeAgentMessageDeliveryAck,
  decodeAgentMessageDeliveryAck,
  encodeAgentActivity,
  decodeAgentActivity,
  encodeAgentStatus,
  decodeAgentStatus,
  encodeAgentMessageRequest,
  decodeAgentMessageRequest,
  encodeCloudAgentMessageResponse,
  decodeCloudAgentMessageResponse,
} from "./codec";
export * from "./agent-skills";
export * from "./agent-control";
export * from "./reminder";
