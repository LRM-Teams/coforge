import { afterEach, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  decodeLocalRpcResponse,
  decodeDaemonRuntimeConfigureResponse,
  encodeDaemonCommandRequest,
  encodeLocalRpcRequest,
  encodeDaemonRuntimeConfigureRequest,
  frameLocalRpc,
  readLocalRpcFrames,
  LOCAL_RPC_METHODS,
} from "@coforge/protocol";
import { LocalDaemonLauncher } from "../src/daemon-host/launcher";
import { startDaemonLocalRpcServer } from "../src/local-rpc";
import { InMemoryDaemonCredentialStore } from "../src/credentials/credential-store";
import type { WorkspaceConfig } from "../src/daemon-runtime/runtime";
import type { DaemonCredentialStore } from "../src/credentials/credential-store";

const servers: Array<{ close(): Promise<void> }> = [];
const config = {
  workspaceId: "workspace-a",
  computerId: "computer-a",
  workspaceRoot: "/workspaces/workspace-a",
  daemonApiKey: "daemon-secret",
};
const launcherEnvironment = { stateDirectory: tmpdir(), serverUrl: "https://coforge.test" };

class FakeCredentialStore implements DaemonCredentialStore {
  token: string | null = null;
  saves = 0;
  clears = 0;
  async load(): Promise<string | null> {
    return this.token;
  }
  async save(_workspaceId: string, _computerId: string, token: string): Promise<void> {
    this.saves++;
    this.token = token;
  }
  async delete(): Promise<void> {
    this.clears++;
    this.token = null;
  }
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function expectSocketClosedWithoutResponse(
  socketPath: string,
  frame: Uint8Array,
): Promise<void> {
  const closed = Promise.withResolvers<void>();
  const socket = await Bun.connect({
    unix: socketPath,
    socket: {
      data() {
        closed.reject(new Error("daemon unexpectedly returned a response"));
      },
      close() {
        closed.resolve();
      },
      error(_socket, error) {
        closed.reject(error);
      },
    },
  });
  socket.write(frame);
  await closed.promise;
}

test("daemon accepts a Computer handshake over its Unix socket", async () => {
  const socketPath = join(tmpdir(), `coforge-${randomUUID()}.sock`);
  let configured = 0;
  let started = 0;
  const server = await startDaemonLocalRpcServer({
    socketPath,
    serverUrl: launcherEnvironment.serverUrl,
    validateCredential: (credential) => credential === "daemon-secret",
    runtime: {
      configure: async () => {
        configured++;
      },
      start: async () => {
        started++;
      },
    },
    credentials: new InMemoryDaemonCredentialStore(),
  });
  servers.push(server);
  const launcher = new LocalDaemonLauncher({
    ...launcherEnvironment,
    executablePath: "/unused",
    socketPath,
  });

  await launcher.ensureStarted(config);
  await launcher.ensureStarted(config);
  await launcher.command("start");
  expect(configured).toBe(2);
  expect(started).toBe(1);
});

test("daemon stores configured connection metadata without its token", async () => {
  const socketPath = join(tmpdir(), `coforge-${randomUUID()}.sock`);
  const saved: WorkspaceConfig[] = [];
  const server = await startDaemonLocalRpcServer({
    socketPath,
    serverUrl: launcherEnvironment.serverUrl,
    validateCredential: (credential) => credential === config.daemonApiKey,
    runtime: { configure: async () => {} },
    credentials: new InMemoryDaemonCredentialStore(),
    configStore: {
      load: async () => null,
      save: async (connection) => {
        saved.push(connection);
      },
      clear: async () => {
        return;
      },
    },
  });
  servers.push(server);

  const launcher = new LocalDaemonLauncher({
    ...launcherEnvironment,
    executablePath: "/unused",
    socketPath,
  });
  await launcher.ensureStarted(config);

  expect(saved).toEqual([
    {
      computerId: "computer-a",
      workspaceId: "workspace-a",
      workspaceRoot: "/workspaces/workspace-a",
    },
  ]);
  expect(JSON.stringify(saved)).not.toContain("daemon-secret");
});

test("daemon rejects an invalid handshake credential", async () => {
  const socketPath = join(tmpdir(), `coforge-${randomUUID()}.sock`);
  let registrations = 0;
  const server = await startDaemonLocalRpcServer({
    socketPath,
    serverUrl: launcherEnvironment.serverUrl,
    validateCredential: () => false,
    runtime: {
      configure: async () => {},
    },
    credentials: new InMemoryDaemonCredentialStore(),
  });
  servers.push(server);
  const launcher = new LocalDaemonLauncher({
    ...launcherEnvironment,
    executablePath: "/unused",
    socketPath,
    spawn: () => {},
    timeoutMilliseconds: 1,
    sleep: async () => {},
  });

  await expect(launcher.ensureStarted({ ...config, daemonApiKey: "wrong" })).rejects.toThrow(
    "did not accept",
  );
  expect(registrations).toBe(0);
});

test("daemon rejects missing or wrong request servers before credentials, persistence, or runtime changes", async () => {
  const socketPath = join(tmpdir(), `coforge-${randomUUID()}.sock`);
  const calls: string[] = [];
  const server = await startDaemonLocalRpcServer({
    socketPath,
    serverUrl: launcherEnvironment.serverUrl,
    validateCredential: () => {
      calls.push("validate");
      return true;
    },
    runtime: {
      configure: async () => {
        calls.push("configure");
      },
      start: async () => {
        calls.push("start");
      },
      stopAll: async () => {
        calls.push("stop");
      },
      restart: async () => {
        calls.push("restart");
      },
    },
    credentials: {
      async load() {
        calls.push("credential-load");
        return null;
      },
      async save() {
        calls.push("credential-save");
      },
      async delete() {
        calls.push("credential-delete");
      },
    },
    configStore: {
      async load() {
        calls.push("config-load");
        return null;
      },
      async save() {
        calls.push("config-save");
      },
      async clear() {
        calls.push("config-clear");
      },
    },
  });
  servers.push(server);

  for (const expectedServerUrl of ["", "https://other.coforge.example"]) {
    const configure = frameLocalRpc(
      encodeLocalRpcRequest({
        method: LOCAL_RPC_METHODS.CONFIGURE,
        payload: encodeDaemonRuntimeConfigureRequest({
          protocolMajor: 1,
          requestId: randomUUID(),
          ...config,
          expectedServerUrl,
        }),
      }),
    );
    await expectSocketClosedWithoutResponse(socketPath, configure);

    for (const method of [
      LOCAL_RPC_METHODS.START,
      LOCAL_RPC_METHODS.STOP,
      LOCAL_RPC_METHODS.RESTART,
    ]) {
      await expectSocketClosedWithoutResponse(
        socketPath,
        frameLocalRpc(
          encodeLocalRpcRequest({
            method,
            payload: encodeDaemonCommandRequest({
              protocolMajor: 1,
              requestId: randomUUID(),
              expectedServerUrl,
            }),
          }),
        ),
      );
    }
  }

  expect(calls).toEqual([]);
});

test("daemon processes requests on one socket in order", async () => {
  const socketPath = join(tmpdir(), `coforge-${randomUUID()}.sock`);
  let releaseFirst!: () => void;
  const firstStarted = Promise.withResolvers<void>();
  const firstReleased = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const configured: string[] = [];
  const server = await startDaemonLocalRpcServer({
    socketPath,
    serverUrl: launcherEnvironment.serverUrl,
    validateCredential: async () => {
      if (configured.length === 0) {
        firstStarted.resolve();
        await firstReleased;
      }
      return true;
    },
    runtime: {
      configure: async ({ workspaceId, computerId }) => {
        configured.push(`${workspaceId}:${computerId}`);
      },
    },
    credentials: new InMemoryDaemonCredentialStore(),
  });
  servers.push(server);

  let responseBuffer: Uint8Array<ArrayBufferLike> = new Uint8Array();
  const responses: Uint8Array[] = [];
  let resolveResponses!: () => void;
  const responsesReady = new Promise<void>((resolve) => {
    resolveResponses = resolve;
  });
  const socket = await Bun.connect({
    unix: socketPath,
    socket: {
      data(_socket, chunk) {
        const next = new Uint8Array(responseBuffer.byteLength + chunk.byteLength);
        next.set(responseBuffer);
        next.set(chunk, responseBuffer.byteLength);
        const parsed = readLocalRpcFrames(next);
        responseBuffer = parsed.remainder;
        responses.push(...parsed.frames);
        if (responses.length === 2) resolveResponses();
      },
    },
  });
  const request = (computerId: string, requestId: string) =>
    frameLocalRpc(
      encodeLocalRpcRequest({
        method: LOCAL_RPC_METHODS.CONFIGURE,
        payload: encodeDaemonRuntimeConfigureRequest({
          protocolMajor: 1,
          ...config,
          computerId,
          requestId,
          expectedServerUrl: "https://coforge.test",
        }),
      }),
    );
  socket.write(
    new Uint8Array([...request("first", "request-first"), ...request("second", "request-second")]),
  );
  await firstStarted.promise;
  await Promise.resolve();
  expect(configured).toEqual([]);
  expect(responses).toHaveLength(0);
  releaseFirst();
  await responsesReady;
  expect(configured).toEqual(["workspace-a:first", "workspace-a:second"]);
  expect(
    decodeDaemonRuntimeConfigureResponse(decodeLocalRpcResponse(responses[0]!).payload).requestId,
  ).toBe("request-first");
  socket.end();
});

test("daemon rotates a changed token before configuring and does not rewrite an equal token", async () => {
  const credentials = new FakeCredentialStore();
  credentials.token = "old-token";
  let configured = 0;
  const socketPath = join(tmpdir(), `coforge-${randomUUID()}.sock`);
  const server = await startDaemonLocalRpcServer({
    socketPath,
    serverUrl: launcherEnvironment.serverUrl,
    validateCredential: () => true,
    runtime: {
      configure: async () => {
        configured++;
      },
    },
    credentials,
  });
  servers.push(server);
  const launcher = new LocalDaemonLauncher({
    ...launcherEnvironment,
    executablePath: "/unused",
    socketPath,
  });
  await launcher.ensureStarted({ ...config, daemonApiKey: "new-token" });
  await launcher.ensureStarted({ ...config, daemonApiKey: "new-token" });
  expect(credentials.token).toBe("new-token");
  expect(credentials.saves).toBe(1);
  expect(configured).toBe(2);
});

test("daemon restores the old token when configuration persistence fails", async () => {
  for (const failure of ["configure", "registry"] as const) {
    const credentials = new FakeCredentialStore();
    credentials.token = "old-token";
    const socketPath = join(tmpdir(), `coforge-${randomUUID()}.sock`);
    let saves = 0;
    let clears = 0;
    const server = await startDaemonLocalRpcServer({
      socketPath,
      serverUrl: launcherEnvironment.serverUrl,
      validateCredential: () => true,
      runtime: {
        configure: async () => {
          if (failure === "configure") throw new Error("failed");
        },
      },
      credentials,
      configStore: {
        load: async () => null,
        save: async () => {
          saves++;
          if (failure === "registry") throw new Error("failed");
        },
        clear: async () => {
          clears++;
        },
      },
    });
    servers.push(server);
    const launcher = new LocalDaemonLauncher({
      ...launcherEnvironment,
      executablePath: "/unused",
      socketPath,
      spawn: () => {},
      timeoutMilliseconds: 0,
    });
    await expect(launcher.ensureStarted({ ...config, daemonApiKey: "new-token" })).rejects.toThrow(
      "did not accept",
    );
    expect(credentials.token).toBe("old-token");
    expect(credentials.saves).toBe(2);
    expect(saves).toBe(failure === "registry" ? 1 : 0);
    expect(clears).toBe(1);
  }
});

test("daemon clears a first token when configuration fails", async () => {
  const credentials = new FakeCredentialStore();
  const socketPath = join(tmpdir(), `coforge-${randomUUID()}.sock`);
  const server = await startDaemonLocalRpcServer({
    socketPath,
    serverUrl: launcherEnvironment.serverUrl,
    validateCredential: () => true,
    runtime: {
      configure: async () => {
        throw new Error("failed");
      },
    },
    credentials,
  });
  servers.push(server);
  await expect(
    new LocalDaemonLauncher({
      ...launcherEnvironment,
      executablePath: "/unused",
      socketPath,
      spawn: () => {},
      timeoutMilliseconds: 0,
    }).ensureStarted(config),
  ).rejects.toThrow("did not accept");
  expect(credentials.token).toBeNull();
  expect(credentials.clears).toBe(1);
});

test("launcher stops waiting when the daemon closes the socket during configuration", async () => {
  const socketPath = join(tmpdir(), `coforge-${randomUUID()}.sock`);
  const server = await startDaemonLocalRpcServer({
    socketPath,
    serverUrl: launcherEnvironment.serverUrl,
    validateCredential: () => true,
    runtime: {
      configure: async () => {},
    },
    credentials: {
      async load() {
        throw new Error("secret store unavailable");
      },
      async save() {},
      async delete() {},
    },
  });
  servers.push(server);

  await expect(
    new LocalDaemonLauncher({
      ...launcherEnvironment,
      executablePath: "/unused",
      socketPath,
      spawn: () => {},
      timeoutMilliseconds: 10,
      sleep: async () => {},
    }).ensureStarted(config),
  ).rejects.toThrow("did not accept");
});
