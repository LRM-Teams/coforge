/** TypeScript boundary approved by ADR 0004; codec/transport remains an adapter concern. */
export const COMPUTER_REGISTER_METHOD = "computer:register" as const;
export const COMPUTER_REGISTER_PROTOCOL_MAJOR = 1 as const;

export type RuntimeMetadata = { name: string; version: string; capabilities: string[] };
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
  connectionId: string;
  daemonWorkspaceCredential: string;
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

export {
  DAEMON_HANDSHAKE_METHOD,
  decodeDaemonHandshakeRequest,
  decodeDaemonHandshakeResponse,
  encodeDaemonHandshakeRequest,
  encodeDaemonHandshakeResponse,
  frameLocalRpc,
  readLocalRpcFrame,
  readLocalRpcFrames,
} from "./local-daemon";
export type { DaemonHandshakeRequest, DaemonHandshakeResponse } from "./local-daemon";
