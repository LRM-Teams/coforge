import { expect, test } from "bun:test";
import {
  decodeDaemonHandshakeRequest,
  encodeDaemonHandshakeResponse,
  decodeDaemonRuntimeConfigureRequest,
  encodeDaemonRuntimeConfigureResponse,
  decodeLocalRpcRequest,
  encodeLocalRpcResponse,
  LOCAL_RPC_METHODS,
  readLocalRpcFrame,
} from "@coforge/protocol";
import { LocalDaemonLauncher, resolveDaemonExecutablePath } from "@coforge/daemon";

test("reuses a running daemon after a successful local handshake", async () => {
  let spawned = false;
  const launcher = new LocalDaemonLauncher({
    executablePath: "/install/active/coforge-daemon",
    socketPath: "/state/daemon.sock",
    connect: async () => ({
      request: async (frame) => {
        const envelope = decodeLocalRpcRequest(readLocalRpcFrame(frame)!);
        if (envelope.method === LOCAL_RPC_METHODS.CONFIGURE) {
          const request = decodeDaemonRuntimeConfigureRequest(envelope.payload);
          return encodeLocalRpcResponse({
            method: LOCAL_RPC_METHODS.CONFIGURE,
            payload: encodeDaemonRuntimeConfigureResponse({
              protocolMajor: 1,
              requestId: request.requestId,
              accepted: true,
            }),
          });
        }
        const request = decodeDaemonHandshakeRequest(envelope.payload);
        return encodeLocalRpcResponse({
          method: LOCAL_RPC_METHODS.HANDSHAKE,
          payload: encodeDaemonHandshakeResponse({
            protocolMajor: 1,
            requestId: request.requestId,
            daemonId: "daemon-1",
            accepted: true,
          }),
        });
      },
      close() {},
    }),
    spawn: () => {
      spawned = true;
    },
  });

  await launcher.ensureStarted({
    workspaceId: "w",
    computerId: "computer",
    workspaceRoot: "/w",
    daemonApiKey: "daemon-credential",
  });
  expect(spawned).toBe(false);
});

test("starts the daemon and waits for its handshake", async () => {
  let attempts = 0;
  let spawned = false;
  const launcher = new LocalDaemonLauncher({
    executablePath: "/install/active/coforge-daemon",
    socketPath: "/state/daemon.sock",
    connect: async () => {
      attempts += 1;
      if (attempts < 2) throw new Error("not listening");
      return {
        request: async (frame: Uint8Array) => {
          const envelope = decodeLocalRpcRequest(readLocalRpcFrame(frame)!);
          if (envelope.method === LOCAL_RPC_METHODS.CONFIGURE) {
            const request = decodeDaemonRuntimeConfigureRequest(envelope.payload);
            return encodeLocalRpcResponse({
              method: LOCAL_RPC_METHODS.CONFIGURE,
              payload: encodeDaemonRuntimeConfigureResponse({
                protocolMajor: 1,
                requestId: request.requestId,
                accepted: true,
              }),
            });
          }
          const request = decodeDaemonHandshakeRequest(envelope.payload);
          return encodeLocalRpcResponse({
            method: LOCAL_RPC_METHODS.HANDSHAKE,
            payload: encodeDaemonHandshakeResponse({
              protocolMajor: 1,
              requestId: request.requestId,
              daemonId: "daemon-1",
              accepted: true,
            }),
          });
        },
        close() {},
      };
    },
    spawn: (path, socket) => {
      spawned = path === "/install/active/coforge-daemon" && socket === "/state/daemon.sock";
    },
    sleep: async () => {},
  });

  await launcher.ensureStarted({
    workspaceId: "w",
    computerId: "computer",
    workspaceRoot: "/w",
    daemonApiKey: "daemon-credential",
  });
  expect(spawned).toBe(true);
  expect(attempts).toBe(2);
});

test("resolves the daemon from the active verified release", () => {
  expect(
    resolveDaemonExecutablePath({ installRoot: "/data/Coforge/Computer", platform: "linux" }),
  ).toBe("/data/Coforge/Computer/active/coforge-daemon");
});

test("resolves the Windows daemon from the active verified release", () => {
  expect(
    resolveDaemonExecutablePath({
      installRoot: "C:\\Users\\Alice\\.coforge\\computer\\install",
      platform: "win32",
    }),
  ).toBe("C:\\Users\\Alice\\.coforge\\computer\\install\\active\\coforge-daemon.exe");
});
