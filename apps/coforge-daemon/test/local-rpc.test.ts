import { afterEach, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { LocalDaemonLauncher } from "../src/daemon-host/launcher";
import { startDaemonLocalRpcServer } from "../src/local-rpc";

const servers: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

test("daemon accepts a Computer handshake over its Unix socket", async () => {
  const socketPath = join(tmpdir(), `coforge-${randomUUID()}.sock`);
  const server = await startDaemonLocalRpcServer({
    socketPath,
    validateCredential: (credential) => credential === "daemon-secret",
  });
  servers.push(server);
  const launcher = new LocalDaemonLauncher({
    executablePath: "/unused",
    socketPath,
  });

  await launcher.ensureStarted("daemon-secret");
  expect(true).toBe(true);
});

test("daemon rejects an invalid handshake credential", async () => {
  const socketPath = join(tmpdir(), `coforge-${randomUUID()}.sock`);
  const server = await startDaemonLocalRpcServer({
    socketPath,
    validateCredential: () => false,
  });
  servers.push(server);
  const launcher = new LocalDaemonLauncher({
    executablePath: "/unused",
    socketPath,
    spawn: () => {},
    timeoutMilliseconds: 1,
    sleep: async () => {},
  });

  await expect(launcher.ensureStarted("wrong")).rejects.toThrow("did not accept");
});
