import { describe, expect, test } from "bun:test";
import {
  decodeDaemonHandshakeRequest,
  decodeDaemonHandshakeResponse,
  encodeDaemonHandshakeRequest,
  encodeDaemonHandshakeResponse,
  frameLocalRpc,
  readLocalRpcFrame,
  readLocalRpcFrames,
} from "./local-daemon";

describe("local daemon RPC", () => {
  test("round trips the handshake through a length-prefixed frame", () => {
    const request = {
      protocolMajor: 1,
      requestId: "request-1",
      daemonWorkspaceCredential: "secret",
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
    };
    expect(decodeDaemonHandshakeResponse(encodeDaemonHandshakeResponse(response))).toEqual(
      response,
    );
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
