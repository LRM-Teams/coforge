import { parse } from "protobufjs";
import type { ComputerRegisterRequest, ComputerRegisterResponse } from "./index";

const schema = `syntax = "proto3"; package coforge.rpc.v1;
message RuntimeMetadata { string name = 1; string version = 2; repeated string capabilities = 3; }
message ComputerRegisterRequest { uint32 protocol_major = 1; string request_id = 2; string workspace_slug = 3; string machine_id = 4; string platform = 5; string os_version = 6; string computer_version = 7; repeated RuntimeMetadata runtimes = 8; string registration_idempotency_key = 9; }
message ComputerRegisterResponse { uint32 protocol_major = 1; string request_id = 2; string computer_id = 3; string workspace_id = 4; string connection_id = 5; string daemon_workspace_credential = 6; }`;
const root = parse(schema).root;
const requestType = root.lookupType("coforge.rpc.v1.ComputerRegisterRequest");
const responseType = root.lookupType("coforge.rpc.v1.ComputerRegisterResponse");

export function encodeComputerRegisterRequest(value: ComputerRegisterRequest): Uint8Array {
  return requestType
    .encode(
      requestType.fromObject({
        protocol_major: value.protocolMajor,
        request_id: value.requestId,
        workspace_slug: value.workspaceSlug,
        machine_id: value.machineId,
        platform: value.platform,
        os_version: value.osVersion,
        computer_version: value.computerVersion,
        runtimes: value.runtimes,
        registration_idempotency_key: value.registrationIdempotencyKey,
      }),
    )
    .finish();
}

export function decodeComputerRegisterResponse(bytes: Uint8Array): ComputerRegisterResponse {
  const value = responseType.toObject(responseType.decode(bytes), { longs: String });
  return {
    protocolMajor: value.protocol_major,
    requestId: value.request_id,
    computerId: value.computer_id,
    workspaceId: value.workspace_id,
    connectionId: value.connection_id,
    daemonWorkspaceCredential: value.daemon_workspace_credential,
  };
}
