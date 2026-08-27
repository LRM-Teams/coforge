import { parse } from "protobufjs";

export const DAEMON_HANDSHAKE_METHOD = "daemon:handshake" as const;

export type DaemonHandshakeRequest = {
  protocolMajor: number;
  requestId: string;
  daemonWorkspaceCredential: string;
};

export type DaemonHandshakeResponse = {
  protocolMajor: number;
  requestId: string;
  daemonId: string;
  accepted: boolean;
};

const root = parse(`syntax = "proto3"; package coforge.rpc.v1;
message DaemonHandshakeRequest { uint32 protocol_major = 1; string request_id = 2; string daemon_workspace_credential = 3; }
message DaemonHandshakeResponse { uint32 protocol_major = 1; string request_id = 2; string daemon_id = 3; bool accepted = 4; }`).root;
const requestType = root.lookupType("coforge.rpc.v1.DaemonHandshakeRequest");
const responseType = root.lookupType("coforge.rpc.v1.DaemonHandshakeResponse");

export function encodeDaemonHandshakeRequest(value: DaemonHandshakeRequest): Uint8Array {
  return requestType
    .encode(
      requestType.fromObject({
        protocolMajor: value.protocolMajor,
        requestId: value.requestId,
        daemonWorkspaceCredential: value.daemonWorkspaceCredential,
      }),
    )
    .finish();
}

export function decodeDaemonHandshakeRequest(bytes: Uint8Array): DaemonHandshakeRequest {
  const value = requestType.toObject(requestType.decode(bytes));
  return {
    protocolMajor: value.protocolMajor,
    requestId: value.requestId,
    daemonWorkspaceCredential: value.daemonWorkspaceCredential,
  };
}

export function encodeDaemonHandshakeResponse(value: DaemonHandshakeResponse): Uint8Array {
  return responseType
    .encode(
      responseType.fromObject({
        protocolMajor: value.protocolMajor,
        requestId: value.requestId,
        daemonId: value.daemonId,
        accepted: value.accepted,
      }),
    )
    .finish();
}

export function decodeDaemonHandshakeResponse(bytes: Uint8Array): DaemonHandshakeResponse {
  const value = responseType.toObject(responseType.decode(bytes));
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
