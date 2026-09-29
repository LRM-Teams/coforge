import { describe, expect, test } from "bun:test";
import {
  decodeDaemonCommandResponse,
  decodeDaemonHandshakeRequest,
  decodeDaemonHandshakeResponse,
  decodeDaemonRuntimeConfigureRequest,
  encodeDaemonCommandResponse,
  encodeDaemonHandshakeRequest,
  encodeDaemonHandshakeResponse,
  encodeDaemonRuntimeConfigureRequest,
  frameLocalRpc,
  readLocalRpcFrame,
  readLocalRpcFrames,
} from "./local-daemon";

describe("local daemon RPC", () => {
  test("round trips the handshake through a length-prefixed frame", () => {
    const request = {
      protocolMajor: 1,
      requestId: "request-1",
    };
    const frame = frameLocalRpc(encodeDaemonHandshakeRequest(request));
    expect(readLocalRpcFrame(frame)).not.toBeNull();
    expect(decodeDaemonHandshakeRequest(readLocalRpcFrame(frame)!)).toEqual(request);
  });

  test("round trips the daemon response", () => {
    const response = {
      protocolMajor: 1,
      requestId: "request-1",
      daemonId: "daemon-1",
      accepted: true,
      serverUrl: "https://coforge.example",
    };
    expect(decodeDaemonHandshakeResponse(encodeDaemonHandshakeResponse(response))).toEqual(
      response,
    );
  });

  test("round trips where a Workspace daemon's cloud connection stands", () => {
    const response = {
      protocolMajor: 1,
      requestId: "request-1",
      daemonId: "daemon-1",
      accepted: true,
      serverUrl: "https://coforge.example",
      cloudConnection: "not_connected",
      cloudConnectionError: "ECONNREFUSED",
    } as const;
    expect(decodeDaemonHandshakeResponse(encodeDaemonHandshakeResponse(response))).toEqual(
      response,
    );
  });

  test("round trips a parked runtime and the Workspace a lifecycle refusal names", () => {
    const response = {
      protocolMajor: 1,
      requestId: "request-1",
      accepted: false,
      runtimes: [
        {
          workspaceId: "workspace-1",
          computerId: "computer-1",
          enabled: true,
          processId: 0,
          instanceId: "",
          version: "",
          parkReason: "workspace_deleted",
        },
        {
          workspaceId: "workspace-2",
          computerId: "computer-1",
          enabled: true,
          processId: 42,
          instanceId: "i",
          version: "v",
          cloudConnection: "connecting" as const,
        },
        {
          workspaceId: "workspace-3",
          computerId: "computer-1",
          enabled: true,
          processId: 0,
          instanceId: "",
          version: "",
          lifecycleUnderWay: true,
        },
      ],
      error: "Workspace workspace-1 was deleted in CoForge (workspace_deleted).",
      errorCode: "workspace_deleted",
      workspaceId: "workspace-1",
    };
    expect(decodeDaemonCommandResponse(encodeDaemonCommandResponse(response))).toEqual(response);
  });

  test("round trips the Computer identity in a worker configure request", () => {
    const request = {
      protocolMajor: 1,
      requestId: "request-1",
      workspaceId: "workspace-1",
      computerId: "computer-1",
      workspaceRoot: "/workspaces/workspace-1",
      daemonApiKey: "worker-secret",
      expectedServerUrl: "https://coforge.example",
    };
    expect(
      decodeDaemonRuntimeConfigureRequest(encodeDaemonRuntimeConfigureRequest(request)),
    ).toEqual(request);
  });

  test("extracts multiple complete frames and preserves a partial frame", () => {
    const first = frameLocalRpc(new Uint8Array([1]));
    const second = frameLocalRpc(new Uint8Array([2, 3]));
    const partial = frameLocalRpc(new Uint8Array([4])).slice(0, 4);
    const input = new Uint8Array(first.byteLength + second.byteLength + partial.byteLength);
    input.set(first);
    input.set(second, first.byteLength);
    input.set(partial, first.byteLength + second.byteLength);

    expect(readLocalRpcFrames(input)).toEqual({
      frames: [new Uint8Array([1]), new Uint8Array([2, 3])],
      remainder: partial,
    });
  });
});
