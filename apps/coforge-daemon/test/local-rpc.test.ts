import { afterEach, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  decodeLocalRpcResponse,
  decodeWorkspaceWorkerConfigureResponse,
  encodeLocalRpcRequest,
  encodeWorkspaceWorkerConfigureRequest,
  frameLocalRpc,
  readLocalRpcFrames,
  LOCAL_RPC_METHODS,
} from "@coforge/protocol";
import { LocalDaemonLauncher } from "../src/daemon-host/launcher";
import { startDaemonLocalRpcServer } from "../src/local-rpc";
import { InMemoryWorkspaceWorkerCredentialStore } from "../src/workspace-worker/credential-store";
import type { WorkspaceConnection } from "../src/workspace-worker/supervisor";
import type { WorkspaceWorkerCredentialStore } from "../src/workspace-worker/credential-store";

const servers: Array<{ close(): Promise<void> }> = [];
const config = {
  workspaceId: "workspace-a",
  computerId: "computer-a",
  workspaceRoot: "/workspaces/workspace-a",
  workspaceWorkerToken: "daemon-secret",
};

class FakeCredentialStore implements WorkspaceWorkerCredentialStore {
  token: string | null = null;
  saves = 0;
  deletes = 0;
  async load(): Promise<string | null> {
    return this.token;
  }
  async save(_workspaceId: string, _computerId: string, token: string): Promise<void> {
    this.saves++;
    this.token = token;
  }
  async delete(): Promise<void> {
    this.deletes++;
    this.token = null;
  }
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

test("daemon accepts a Computer handshake over its Unix socket", async () => {
  const socketPath = join(tmpdir(), `coforge-${randomUUID()}.sock`);
  const server = await startDaemonLocalRpcServer({
    socketPath,
    validateCredential: (credential) => credential === "daemon-secret",
    runtime: {
      configureWorkspaceWorker: async () => {},
    },
    credentials: new InMemoryWorkspaceWorkerCredentialStore(),
  });
  servers.push(server);
  const launcher = new LocalDaemonLauncher({
    executablePath: "/unused",
    socketPath,
  });

  await launcher.ensureStarted(config);
  await launcher.ensureStarted(config);
  expect(true).toBe(true);
});

test("daemon stores configured connection metadata without its token", async () => {
  const socketPath = join(tmpdir(), `coforge-${randomUUID()}.sock`);
  const saved: WorkspaceConnection[] = [];
  const server = await startDaemonLocalRpcServer({
    socketPath,
    validateCredential: (credential) => credential === config.workspaceWorkerToken,
    runtime: { configureWorkspaceWorker: async () => {} },
    credentials: new InMemoryWorkspaceWorkerCredentialStore(),
    registry: {
      list: async () => [],
      upsert: async (connection) => {
        saved.push(connection);
      },
      delete: async () => {
        return;
      },
    },
  });
  servers.push(server);

  const launcher = new LocalDaemonLauncher({ executablePath: "/unused", socketPath });
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
    validateCredential: () => false,
    runtime: {
      configureWorkspaceWorker: async () => {},
    },
    credentials: new InMemoryWorkspaceWorkerCredentialStore(),
  });
  servers.push(server);
  const launcher = new LocalDaemonLauncher({
    executablePath: "/unused",
    socketPath,
    spawn: () => {},
    timeoutMilliseconds: 1,
    sleep: async () => {},
  });

  await expect(
    launcher.ensureStarted({ ...config, workspaceWorkerToken: "wrong" }),
  ).rejects.toThrow("did not accept");
  expect(registrations).toBe(0);
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
    validateCredential: async () => {
      if (configured.length === 0) {
        firstStarted.resolve();
        await firstReleased;
      }
      return true;
    },
    runtime: {
      configureWorkspaceWorker: async ({ workspaceId, computerId }) => {
        configured.push(`${workspaceId}:${computerId}`);
      },
    },
    credentials: new InMemoryWorkspaceWorkerCredentialStore(),
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
        payload: encodeWorkspaceWorkerConfigureRequest({
          protocolMajor: 1,
          ...config,
          computerId,
          requestId,
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
    decodeWorkspaceWorkerConfigureResponse(decodeLocalRpcResponse(responses[0]!).payload).requestId,
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
    validateCredential: () => true,
    runtime: {
      configureWorkspaceWorker: async () => {
        configured++;
      },
    },
    credentials,
  });
  servers.push(server);
  const launcher = new LocalDaemonLauncher({ executablePath: "/unused", socketPath });
  await launcher.ensureStarted({ ...config, workspaceWorkerToken: "new-token" });
  await launcher.ensureStarted({ ...config, workspaceWorkerToken: "new-token" });
  expect(credentials.token).toBe("new-token");
  expect(credentials.saves).toBe(1);
  expect(configured).toBe(2);
});

test("daemon restores the old token when configuration or registry persistence fails", async () => {
  for (const failure of ["configure", "registry"] as const) {
    const credentials = new FakeCredentialStore();
    credentials.token = "old-token";
    const socketPath = join(tmpdir(), `coforge-${randomUUID()}.sock`);
    let upserts = 0;
    let deletes = 0;
    const server = await startDaemonLocalRpcServer({
      socketPath,
      validateCredential: () => true,
      runtime: {
        configureWorkspaceWorker: async () => {
          if (failure === "configure") throw new Error("failed");
        },
      },
      credentials,
      registry: {
        list: async () => [],
        upsert: async () => {
          upserts++;
          if (failure === "registry") throw new Error("failed");
        },
        delete: async () => {
          deletes++;
        },
      },
    });
    servers.push(server);
    const launcher = new LocalDaemonLauncher({
      executablePath: "/unused",
      socketPath,
      spawn: () => {},
      timeoutMilliseconds: 0,
    });
    await expect(
      launcher.ensureStarted({ ...config, workspaceWorkerToken: "new-token" }),
    ).rejects.toThrow("did not accept");
    expect(credentials.token).toBe("old-token");
    expect(credentials.saves).toBe(2);
    expect(upserts).toBe(failure === "registry" ? 1 : 0);
    expect(deletes).toBe(failure === "registry" ? 1 : 0);
  }
});

test("daemon deletes a first token when configuration fails", async () => {
  const credentials = new FakeCredentialStore();
  const socketPath = join(tmpdir(), `coforge-${randomUUID()}.sock`);
  const server = await startDaemonLocalRpcServer({
    socketPath,
    validateCredential: () => true,
    runtime: {
      configureWorkspaceWorker: async () => {
        throw new Error("failed");
      },
    },
    credentials,
  });
  servers.push(server);
  await expect(
    new LocalDaemonLauncher({
      executablePath: "/unused",
      socketPath,
      spawn: () => {},
      timeoutMilliseconds: 0,
    }).ensureStarted(config),
  ).rejects.toThrow("did not accept");
  expect(credentials.token).toBeNull();
  expect(credentials.deletes).toBe(1);
});

test("launcher stops waiting when the daemon closes the socket during configuration", async () => {
  const socketPath = join(tmpdir(), `coforge-${randomUUID()}.sock`);
  const server = await startDaemonLocalRpcServer({
    socketPath,
    validateCredential: () => true,
    runtime: {
      configureWorkspaceWorker: async () => {},
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
      executablePath: "/unused",
      socketPath,
      spawn: () => {},
      timeoutMilliseconds: 10,
      sleep: async () => {},
    }).ensureStarted(config),
  ).rejects.toThrow("did not accept");
});
