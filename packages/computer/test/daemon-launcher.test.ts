import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    stateDirectory: "/state",
    serverUrl: "https://coforge.example",
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
            serverUrl: "https://coforge.example",
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
    stateDirectory: "/state",
    serverUrl: "https://coforge.example",
    executablePath: "/install/active/coforge-daemon",
    socketPath: "/state/daemon.sock",
    connect: async () => {
      attempts += 1;
      if (attempts < 2) throw Object.assign(new Error("not listening"), { code: "ENOENT" });
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
              serverUrl: "https://coforge.example",
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

test("does not spawn when opening the daemon socket is forbidden", async () => {
  let spawned = false;
  const launcher = new LocalDaemonLauncher({
    stateDirectory: "/state",
    serverUrl: "https://coforge.example",
    executablePath: "/install/active/coforge-daemon",
    socketPath: "/state/daemon.sock",
    connect: async () => {
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    },
    spawn: () => {
      spawned = true;
    },
  });

  await expect(launcher.ensureRunning()).rejects.toMatchObject({ code: "EACCES" });
  expect(spawned).toBe(false);
});

test("preflight rejects mismatched and legacy persisted daemon configuration before connecting", async () => {
  for (const serverHttpUrl of ["https://other.coforge.example", undefined]) {
    const stateDirectory = await mkdtemp(join(tmpdir(), "coforge-preflight-"));
    try {
      await Bun.write(
        join(stateDirectory, "config.json"),
        JSON.stringify({
          workspaceId: "workspace",
          computerId: "computer",
          workspaceRoot: "/workspace",
          ...(serverHttpUrl ? { serverHttpUrl } : {}),
        }),
      );
      let connected = false;
      const launcher = new LocalDaemonLauncher({
        stateDirectory,
        serverUrl: "https://coforge.example",
        executablePath: "/unused",
        socketPath: join(stateDirectory, "daemon.sock"),
        connect: async () => {
          connected = true;
          throw Object.assign(new Error("absent"), { code: "ENOENT" });
        },
      });

      await expect(launcher.preflight()).rejects.toThrow(
        serverHttpUrl ? "does not match" : "does not identify its server",
      );
      expect(connected).toBe(false);
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
    }
  }
});

test("commands reject wrong and legacy identities on different sockets without sending commands", async () => {
  const methodsBySocket = new Map<string, string[]>();
  for (const [socketPath, serverUrl] of [
    ["/state/wrong.sock", "https://other.coforge.example"],
    ["/state/legacy.sock", ""],
  ] as const) {
    const methods: string[] = [];
    methodsBySocket.set(socketPath, methods);
    const launcher = new LocalDaemonLauncher({
      stateDirectory: "/state",
      serverUrl: "https://coforge.example",
      executablePath: "/unused",
      socketPath,
      connect: async (openedPath) => {
        expect(openedPath).toBe(socketPath);
        return {
          request: async (frame) => {
            const envelope = decodeLocalRpcRequest(readLocalRpcFrame(frame)!);
            methods.push(envelope.method);
            const request = decodeDaemonHandshakeRequest(envelope.payload);
            return encodeLocalRpcResponse({
              method: LOCAL_RPC_METHODS.HANDSHAKE,
              payload: encodeDaemonHandshakeResponse({
                protocolMajor: 1,
                requestId: request.requestId,
                daemonId: "other-daemon",
                accepted: true,
                serverUrl,
              }),
            });
          },
          close() {},
        };
      },
    });

    await expect(launcher.command("stop")).rejects.toThrow("server does not match");
  }

  expect([...methodsBySocket.values()]).toEqual([
    [LOCAL_RPC_METHODS.HANDSHAKE],
    [LOCAL_RPC_METHODS.HANDSHAKE],
  ]);
});

test("refuses a legacy daemon identity before sending configuration credentials", async () => {
  const methods: string[] = [];
  const launcher = new LocalDaemonLauncher({
    executablePath: "/unused",
    socketPath: "/state/daemon.sock",
    stateDirectory: "/state",
    serverUrl: "https://coforge.example",
    connect: async () => ({
      request: async (frame) => {
        const envelope = decodeLocalRpcRequest(readLocalRpcFrame(frame)!);
        methods.push(envelope.method);
        const request = decodeDaemonHandshakeRequest(envelope.payload);
        return encodeLocalRpcResponse({
          method: LOCAL_RPC_METHODS.HANDSHAKE,
          payload: encodeDaemonHandshakeResponse({
            protocolMajor: 1,
            requestId: request.requestId,
            daemonId: "legacy-daemon",
            accepted: true,
            serverUrl: "",
          }),
        });
      },
      close() {},
    }),
  });

  await expect(
    launcher.ensureStarted({
      workspaceId: "w",
      computerId: "computer",
      workspaceRoot: "/w",
      daemonApiKey: "must-not-be-sent",
    }),
  ).rejects.toThrow("server does not match");
  expect(methods).toEqual([LOCAL_RPC_METHODS.HANDSHAKE]);
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
