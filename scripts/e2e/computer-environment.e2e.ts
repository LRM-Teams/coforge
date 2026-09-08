import { expect, test } from "bun:test";
import { RedisClient } from "bun";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  decodeDaemonHandshakeRequest,
  decodeDaemonHandshakeResponse,
  decodeLocalRpcRequest,
  decodeLocalRpcResponse,
  encodeDaemonHandshakeRequest,
  encodeDaemonHandshakeResponse,
  encodeLocalRpcRequest,
  encodeLocalRpcResponse,
  frameLocalRpc,
  LOCAL_RPC_METHODS,
  readLocalRpcFrames,
} from "../../packages/protocol";
import { RedisComputerStatusCache } from "../../apps/web/src/server/centrifugo/computer-status.server";

const root = resolve(import.meta.dir, "../..");
const serverUrl = Bun.env.COFORGE_E2E_WEB_URL;
const workspace = Bun.env.COFORGE_E2E_WORKSPACE_SLUG;
if (Bun.env.COFORGE_E2E_ALLOW_DEVICE_AUTH !== "1" || !serverUrl || !workspace) {
  throw new Error(
    "Set COFORGE_E2E_ALLOW_DEVICE_AUTH=1, COFORGE_E2E_WEB_URL and COFORGE_E2E_WORKSPACE_SLUG for the local test stack",
  );
}
const computer = join(root, ".amp/e2e/bin/coforge-computer");
const localDaemon = join(root, ".amp/e2e/bin/coforge-daemon");
const productionDaemon = join(root, "packages/daemon/dist/coforge-daemon");

test("compiled Computer setup and environment rejection against the real local stack", async () => {
  for (const command of [
    [process.execPath, "scripts/e2e/build-computer-fixture.ts"],
    [process.execPath, "run", "--cwd", "packages/daemon", "build"],
  ]) {
    const build = Bun.spawnSync(command, {
      cwd: root,
      env: { ...Bun.env, COFORGE_RELEASE_FEED_URL: "https://releases.coforge.cn" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(build.exitCode).toBe(0);
  }
  const directory = await mkdtemp(join(tmpdir(), "coforge-environment-e2e-"));
  const processes: Bun.Subprocess[] = [];
  const redisPassword = (await Bun.file(join(root, "infra/secrets/redis_password")).text()).trim();
  const redis = new RedisClient(`redis://:${encodeURIComponent(redisPassword)}@127.0.0.1:6379`);
  const status = new RedisComputerStatusCache(redis);
  const environment = (home: string) => ({
    ...Bun.env,
    HOME: home,
    COFORGE_COMPUTER_CREDENTIALS_DIR: join(home, ".coforge/computer/credentials"),
    COFORGE_DAEMON_HOME: join(home, ".coforge/daemon"),
    COFORGE_E2E_DAEMON_EXECUTABLE: localDaemon,
    COFORGE_E2E_CENTRIFUGO_ENDPOINT:
      Bun.env.COFORGE_E2E_CENTRIFUGO_ENDPOINT ?? "ws://127.0.0.1:8000/connection/websocket",
  });
  const stateFor = (home: string) => join(home, ".coforge/daemon");
  const socketFor = (home: string) => join(stateFor(home), "daemon.sock");
  async function invoke(home: string, command: string) {
    const args = command === "setup" ? [command, "--workspace", workspace!, "--json"] : [command];
    const child = Bun.spawn([computer, ...args], {
      env: environment(home),
      stdout: "pipe",
      stderr: "pipe",
      timeout: 20_000,
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
  }
  async function handshake(home: string) {
    const reply = Promise.withResolvers<Uint8Array>();
    let buffer = new Uint8Array();
    const socket = await Bun.connect({
      unix: socketFor(home),
      socket: {
        data(_socket, chunk) {
          buffer = new Uint8Array([...buffer, ...chunk]);
          const frame = readLocalRpcFrames(buffer).frames[0];
          if (frame) reply.resolve(frame);
        },
        error(_socket, error) {
          reply.reject(error);
        },
        close() {
          reply.reject(new Error("Daemon closed before handshake response"));
        },
      },
    });
    try {
      socket.write(
        frameLocalRpc(
          encodeLocalRpcRequest({
            method: LOCAL_RPC_METHODS.HANDSHAKE,
            payload: encodeDaemonHandshakeRequest({
              protocolMajor: 1,
              requestId: crypto.randomUUID(),
            }),
          }),
        ),
      );
      const response = decodeLocalRpcResponse(await reply.promise);
      return decodeDaemonHandshakeResponse(response.payload);
    } finally {
      socket.end();
    }
  }
  async function startDaemon(home: string, executable: string) {
    await mkdir(home, { recursive: true });
    const child = Bun.spawn(
      [executable, "--socket", socketFor(home), "--state-directory", stateFor(home)],
      {
        env: environment(home),
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    processes.push(child);
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        return await handshake(home);
      } catch {
        if (child.exitCode !== null) throw new Error("E2E daemon exited before handshake");
        await Bun.sleep(50);
      }
    }
    throw new Error("E2E daemon handshake timed out");
  }
  async function assertRejected(home: string) {
    for (const command of ["login", "setup", "start", "restart"]) {
      const result = await invoke(home, command);
      expect(result.code).toBe(1);
      expect(result.stdout + result.stderr).toMatch(/environment|does not match|does not identify/);
      expect(result.stdout + result.stderr).not.toContain("Waiting for authorization");
      expect(result.stdout + result.stderr).not.toContain('"ok":true');
    }
    expect(await Bun.file(join(home, ".coforge/computer/profile.json")).exists()).toBe(false);
    expect(await Bun.file(join(home, ".coforge/computer/workspace/config.json")).exists()).toBe(
      false,
    );
    await expect(readdir(join(home, ".coforge/computer/credentials"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  }
  try {
    const home = join(directory, "same");
    const identity = await startDaemon(home, localDaemon);
    expect(identity.serverUrl).toBe(serverUrl);
    const setup = await invoke(home, "setup");
    expect(setup.code).toBe(0);
    expect(JSON.parse(setup.stdout)).toMatchObject({
      ok: true,
      daemon_started: true,
      server_registration_created: true,
    });
    const registration = await Bun.file(
      join(home, ".coforge/computer/workspace/config.json"),
    ).json();
    const scope = { workspaceId: registration.workspace_id, computerId: registration.computer_id };
    for (let attempt = 0; attempt < 100 && !(await status.get(scope)); attempt++)
      await Bun.sleep(100);
    expect(await status.get(scope)).toBe(true);
    expect((await handshake(home)).daemonId).toBe(identity.daemonId);
    expect((await invoke(home, "restart")).code).toBe(0);
    expect((await handshake(home)).daemonId).toBe(identity.daemonId);
    expect((await invoke(home, "setup")).code).toBe(0);
    expect((await handshake(home)).daemonId).toBe(identity.daemonId);
    console.log(
      "PASS real local OAuth → workspace lookup → register RPC → Unix configure → Daemon WSS; same-process restart/reuse",
    );

    const otherHome = join(directory, "other-daemon");
    const otherIdentity = await startDaemon(otherHome, productionDaemon);
    expect(otherIdentity.serverUrl).toBe("https://coforge.cn");
    await assertRejected(otherHome);
    expect((await handshake(otherHome)).daemonId).toBe(otherIdentity.daemonId);
    expect(await readdir(stateFor(otherHome))).toEqual(["daemon.sock"]);

    for (const storedServer of ["https://coforge.cn", undefined]) {
      const storedHome = join(directory, storedServer ? "persisted-other" : "persisted-legacy");
      await mkdir(stateFor(storedHome), { recursive: true });
      const file = join(stateFor(storedHome), "config.json");
      const original = JSON.stringify({
        workspaceId: "untouched",
        computerId: "untouched",
        workspaceRoot: storedHome,
        serverHttpUrl: storedServer,
      });
      await Bun.write(file, original);
      await assertRejected(storedHome);
      expect(await Bun.file(file).text()).toBe(original);
      expect(await readdir(stateFor(storedHome))).toEqual(["config.json"]);
    }
    console.log(
      "PASS missing Computer profile cannot bypass live, persisted or legacy Daemon environment checks",
    );

    // An identity-less wire peer models a pre-change Daemon. No configure/command may be sent.
    const legacyHome = join(directory, "legacy-peer");
    await mkdir(stateFor(legacyHome), { recursive: true });
    const methods: string[] = [];
    const legacy = Bun.listen<{ buffer: Uint8Array }>({
      unix: socketFor(legacyHome),
      socket: {
        open(socket) {
          socket.data = { buffer: new Uint8Array() };
        },
        data(socket, chunk) {
          socket.data.buffer = new Uint8Array([...socket.data.buffer, ...chunk]);
          const parsed = readLocalRpcFrames(socket.data.buffer);
          socket.data.buffer = parsed.remainder;
          for (const frame of parsed.frames) {
            const envelope = decodeLocalRpcRequest(frame);
            methods.push(envelope.method);
            const request = decodeDaemonHandshakeRequest(envelope.payload);
            socket.write(
              frameLocalRpc(
                encodeLocalRpcResponse({
                  method: LOCAL_RPC_METHODS.HANDSHAKE,
                  payload: encodeDaemonHandshakeResponse({
                    protocolMajor: 1,
                    requestId: request.requestId,
                    daemonId: "legacy",
                    accepted: true,
                    serverUrl: "",
                  }),
                }),
              ),
            );
          }
        },
      },
    });
    try {
      await assertRejected(legacyHome);
      expect(methods).toEqual(Array(4).fill(LOCAL_RPC_METHODS.HANDSHAKE));
    } finally {
      legacy.stop(true);
    }
    console.log("PASS legacy wire identity rejected before any credentials or lifecycle command");
    expect((await invoke(home, "stop")).code).toBe(0);
    expect((await handshake(home)).daemonId).toBe(identity.daemonId);
    expect((await invoke(home, "start")).code).toBe(0);
    expect((await handshake(home)).daemonId).toBe(identity.daemonId);
    expect((await invoke(home, "stop")).code).toBe(0);
    console.log("PASS stop/start preserves the Daemon process and its verified socket identity");
  } finally {
    redis.close();
    for (const child of processes) {
      child.kill();
      await child.exited;
    }
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);
