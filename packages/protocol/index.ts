/** TypeScript boundary approved by ADR 0004; codec/transport remains an adapter concern. */
export const COMPUTER_REGISTER_METHOD = "computer:register" as const;
export const COMPUTER_REGISTER_PROTOCOL_MAJOR = 1 as const;
export const WORKSPACE_LIST_METHOD = "workspace:list" as const;
export const WORKSPACE_GET_METHOD = "workspace:get" as const;
export const WORKSPACE_WORKER_READY_METHOD = "workspace_worker:ready" as const;
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
} from "./local-daemon";
export type {
  DaemonHandshakeRequest,
  DaemonHandshakeResponse,
  WorkspaceWorkerConfigureRequest,
  WorkspaceWorkerConfigureResponse,
  LocalRpcRequest,
  LocalRpcResponse,
} from "./local-daemon";
export { encodeWorkspaceWorkerReadyRequest, decodeWorkspaceWorkerReadyRequest } from "./codec";
