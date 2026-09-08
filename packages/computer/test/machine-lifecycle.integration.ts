import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createDaemonHost, LocalDaemonLauncher } from "@coforge/daemon";
import { ComputerUpdater } from "../src/updater";
import { buildReleaseTree } from "../../../scripts/release/build-release";
import {
  DAEMON_RUNTIME_READY_METHOD,
  decodeDaemonRuntimeReadyRequest,
  type DaemonRuntimeReadyRequest,
} from "@coforge/protocol";

let root: string;
let executable: string;
let containerName: string;
let centrifugoPort: number;
let proxy: ReturnType<typeof Bun.serve>;
const readyRequests: DaemonRuntimeReadyRequest[] = [];
const systemdUserAvailable =
  process.platform === "linux" &&
  Bun.spawnSync(["systemctl", "--user", "show-environment"], {
    stdout: "ignore",
    stderr: "ignore",
  }).exitCode === 0;

const waitFor = async (condition: () => boolean | Promise<boolean>, message: string) => {
  const deadline = Date.now() + 30_000;
  while (!(await condition())) {
    if (Date.now() >= deadline) throw new Error(message);
    await Bun.sleep(50);
  }
};

const waitForSystemdUserUnitInactive = async (serviceName: string) => {
  await waitFor(() => {
    const result = Bun.spawnSync([
      "systemctl",
      "--user",
      "show",
      serviceName,
      "--property=ActiveState",
      "--value",
    ]);
    return result.exitCode !== 0 || result.stdout.toString().trim() === "inactive";
  }, `systemd user unit ${serviceName} did not become inactive`);
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "coforge-machine-lifecycle-"));
  executable = join(root, "coforge-computer");
  const suppliedBuild = Bun.env.COFORGE_NATIVE_TEST_BUILD_1;
  if (suppliedBuild) {
    await Bun.write(executable, Bun.file(suppliedBuild));
    await chmod(executable, 0o700);
  } else {
    const compiled = Bun.spawnSync([
      process.execPath,
      "build",
      "--compile",
      new URL("../src/main.ts", import.meta.url).pathname,
      "--outfile",
      executable,
    ]);
    if (compiled.exitCode !== 0) throw new Error(compiled.stderr.toString());
  }

  proxy = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as {
        data?: { daemonApiKey?: string };
        method?: string;
        b64data?: string;
      };
      if (body.method) {
        if (body.method === DAEMON_RUNTIME_READY_METHOD && body.b64data) {
          readyRequests.push(
            decodeDaemonRuntimeReadyRequest(
              Uint8Array.from(atob(body.b64data), (character) => character.charCodeAt(0)),
            ),
          );
        }
        return Response.json({ result: { b64data: "" } });
      }
      const workspaceId =
        body.data?.daemonApiKey === "test-a"
          ? "a"
          : body.data?.daemonApiKey === "test-b"
            ? "b"
            : undefined;
      if (!workspaceId) return Response.json({ error: { code: 101, message: "unauthorized" } });
      return Response.json({
        result: {
          user: `test-${workspaceId}`,
          meta: { workspace_id: workspaceId, computer_id: "machine" },
          subs: { [`daemon:${workspaceId}:machine`]: {} },
        },
      });
    },
  });

  const portProbe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  if (!portProbe.port) throw new Error("Centrifugo port allocation failed");
  centrifugoPort = portProbe.port;
  portProbe.stop(true);
  const configPath = join(root, "centrifugo.yaml");
  await writeFile(
    configPath,
    `http_server:\n  port: ${centrifugoPort}\nhealth:\n  enabled: true\nadmin:\n  enabled: false\nlog:\n  level: error\nclient:\n  proxy:\n    connect:\n      enabled: true\n      endpoint: http://127.0.0.1:${proxy.port}/connect\n      timeout: 5s\nrpc:\n  proxy:\n    endpoint: http://127.0.0.1:${proxy.port}/rpc\n    timeout: 5s\n    binary_encoding: true\n    include_connection_meta: true\n  without_namespace:\n    proxy_enabled: true\n  namespaces:\n    - name: daemon\n      proxy_enabled: true\nchannel:\n  namespaces:\n    - name: daemon\n`,
    { mode: 0o600 },
  );
  containerName = `coforge-machine-lifecycle-${crypto.randomUUID()}`;
  const docker = Bun.spawnSync([
    "docker",
    "run",
    "--detach",
    "--rm",
    "--network",
    "host",
    "--name",
    containerName,
    "--volume",
    `${configPath}:/centrifugo/config.yaml:ro`,
    "centrifugo/centrifugo:v6.9.2",
    "centrifugo",
    "--config",
    "/centrifugo/config.yaml",
  ]);
  if (docker.exitCode !== 0) throw new Error(docker.stderr.toString());
  await waitFor(
    async () =>
      (await fetch(`http://127.0.0.1:${centrifugoPort}/health`).catch(() => null))?.ok === true,
    "Centrifugo did not become healthy",
  );
}, 60_000);

afterAll(async () => {
  if (containerName) Bun.spawnSync(["docker", "rm", "--force", containerName]);
  proxy?.stop(true);
  if (root) await rm(root, { recursive: true, force: true });
});

test("real compiled machine supervisor preserves Workspace lifecycle and recovery state", async () => {
  const stateDirectory = join(root, "machine");
  const socketPath = join(stateDirectory, "daemon.sock");
  const spawn = () =>
    Bun.spawn(
      [executable, "__daemon", "--socket", socketPath, "--state-directory", stateDirectory],
      {
        env: {
          ...Bun.env,
          COFORGE_DAEMON_CONNECTION_ENDPOINT: `ws://127.0.0.1:${centrifugoPort}/connection/websocket`,
        },
        stdout: "ignore",
        stderr: "pipe",
      },
    );
  let supervisor = spawn();
  const client = new LocalDaemonLauncher({
    executablePath: executable,
    socketPath,
    stateDirectory,
    spawn: () => {},
  });
  try {
    await client.ensureRunning();
    await client.ensureStarted({
      workspaceId: "a",
      computerId: "machine",
      workspaceRoot: root,
      daemonApiKey: "test-a",
    });
    const firstA = (await client.control("snapshot"))[0]!;
    await client.ensureStarted({
      workspaceId: "b",
      computerId: "machine",
      workspaceRoot: root,
      daemonApiKey: "test-b",
    });
    const both = await client.control("snapshot");
    expect(both.find((runtime) => runtime.workspaceId === "a")?.processId).toBe(firstA.processId);
    expect(both.find((runtime) => runtime.workspaceId === "a")?.instanceId).toBe(firstA.instanceId);

    await client.control("restart", "a", "stable-restart-a");
    const restarted = await client.control("snapshot");
    expect(restarted.find((runtime) => runtime.workspaceId === "a")?.processId).not.toBe(
      firstA.processId,
    );
    expect(restarted.find((runtime) => runtime.workspaceId === "b")?.processId).toBe(
      both.find((runtime) => runtime.workspaceId === "b")?.processId,
    );
    await client.control("restart", "a", "stable-restart-a");
    expect(await client.control("snapshot")).toEqual(restarted);
    await waitFor(
      () =>
        readyRequests.some(
          (ready) =>
            ready.workspaceId === "a" &&
            ready.recoveredRestartRequestIds?.includes("stable-restart-a"),
        ),
      "ready recovery evidence was not received",
    );

    await client.control("stop", "b");
    await client.control("pause");
    await client.control("resume");
    await client.control("start", "a");
    const orphanedAProcessId = (await client.control("snapshot")).find(
      (runtime) => runtime.workspaceId === "a",
    )!.processId;
    supervisor.kill("SIGKILL");
    expect(await supervisor.exited).not.toBe(0);
    supervisor = spawn();
    await client.ensureRunning();
    const recovered = await client.control("snapshot");
    expect(recovered.find((runtime) => runtime.workspaceId === "a")?.processId).toBeGreaterThan(0);
    expect(recovered.find((runtime) => runtime.workspaceId === "a")?.processId).not.toBe(
      orphanedAProcessId,
    );
    expect(recovered.find((runtime) => runtime.workspaceId === "b")?.processId).toBe(0);
    for (const workspace of ["YQ", "Yg"]) {
      expect(
        await Bun.file(join(stateDirectory, "workspaces", workspace, "config.json")).exists(),
      ).toBe(true);
      expect(
        await Bun.file(
          join(
            stateDirectory,
            "workspaces",
            workspace,
            "credentials",
            `${workspace === "YQ" ? "a" : "b"}-machine.api-key`,
          ),
        ).exists(),
      ).toBe(true);
    }
  } finally {
    supervisor.kill("SIGTERM");
    await supervisor.exited;
  }
}, 120_000);

test.skipIf(!systemdUserAvailable)(
  "native coordinator survives caller exit under the real systemd user manager, upgrades the running set, and rolls back a bad candidate offline",
  async () => {
    const feedDirectory = join(root, "feed");
    const downloadStarted = Promise.withResolvers<void>();
    const allowDownload = Promise.withResolvers<void>();
    const feed = Bun.serve({
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/2.0.0/manifest.json") {
          downloadStarted.resolve();
          await allowDownload.promise;
        }
        return new Response(Bun.file(join(feedDirectory, path)));
      },
    });
    const installRoot = join(root, "installation");
    const stateDirectory = join(root, "upgrade-machine");
    const socketPath = join(stateDirectory, "daemon.sock");
    const serviceName = `coforge-native-upgrade-${crypto.randomUUID()}.service`;
    const environment = {
      ...process.env,
      COFORGE_DAEMON_CONNECTION_ENDPOINT: `ws://127.0.0.1:${centrifugoPort}/connection/websocket`,
    };
    const artifacts = new Map<string, Uint8Array>();
    for (const version of ["1.0.0", "2.0.0"]) {
      const supplied = Bun.env[`COFORGE_NATIVE_TEST_BUILD_${version[0]}`];
      const path = supplied ?? join(root, `computer-${version}`);
      if (!supplied) {
        const compiled = Bun.spawnSync([
          process.execPath,
          "build",
          "--compile",
          new URL("../src/main.ts", import.meta.url).pathname,
          "--define",
          `Bun.env.COFORGE_COMPUTER_VERSION=${JSON.stringify(version)}`,
          "--define",
          `process.env.COFORGE_DAEMON_VERSION=${JSON.stringify(version)}`,
          "--outfile",
          path,
        ]);
        if (compiled.exitCode !== 0) throw new Error(compiled.stderr.toString());
      }
      artifacts.set(version, new Uint8Array(await Bun.file(path).arrayBuffer()));
    }
    // Correct checksum but wrong embedded version: installation succeeds, process health must fail.
    artifacts.set("3.0.0", artifacts.get("1.0.0")!);
    for (const [version, bytes] of artifacts)
      await buildReleaseTree(
        {
          version,
          commit: "a".repeat(40),
          buildDate: "2026-09-07T00:00:00Z",
          artifacts: { "linux-x64": { computer: bytes } },
        },
        feedDirectory,
      );
    await new ComputerUpdater({
      baseUrl: feed.url.toString(),
      target: "linux-x64",
      installRoot,
    }).install("1.0.0");
    const installed = join(installRoot, "active", "coforge-computer");
    const client = new LocalDaemonLauncher({
      executablePath: installed,
      socketPath,
      spawn: () => {},
    });
    const host = createDaemonHost({
      platform: "linux",
      executablePath: installed,
      socketPath,
      stateDirectory,
      daemonConnectionEndpoint: environment.COFORGE_DAEMON_CONNECTION_ENDPOINT,
      homeDirectory: homedir(),
      uid: process.getuid?.() ?? 0,
      serviceName,
      runtimeHomeDirectory: root,
    });
    const unitDirectory = join(homedir(), ".config", "systemd", "user");
    const unitPath = join(unitDirectory, serviceName);
    const callerPath = Bun.env.COFORGE_NATIVE_TEST_CALLER ?? join(root, "upgrade-caller.ts");
    if (!Bun.env.COFORGE_NATIVE_TEST_CALLER)
      await writeFile(
        callerPath,
        `import { launchUpgradeCoordinator } from ${JSON.stringify(new URL("../src/release/upgrade-coordinator.ts", import.meta.url).pathname)}; await launchUpgradeCoordinator(JSON.parse(Bun.argv[2]));`,
      );
    const invoke = (selection: string, operation = "upgrade") =>
      Bun.spawn(
        [
          process.execPath,
          callerPath,
          JSON.stringify({
            installRoot,
            target: "linux-x64",
            baseUrl: feed.url.toString(),
            selection,
            operation,
            supervisorSocketPath: socketPath,
            supervisorStatePath: stateDirectory,
            executablePath: installed,
            serviceName,
            homeDirectory: homedir(),
            runtimeHomeDirectory: root,
          }),
        ],
        { env: environment, stdout: "ignore", stderr: "pipe" },
      );
    const results = async () =>
      (await readdir(join(installRoot, "upgrade-results"))).filter((name) =>
        name.endsWith(".result.json"),
      );
    try {
      await host.ensureStarted({
        workspaceId: "a",
        computerId: "machine",
        workspaceRoot: root,
        daemonApiKey: "test-a",
      });
      for (const id of ["b"])
        await host.ensureStarted({
          workspaceId: id,
          computerId: "machine",
          workspaceRoot: root,
          daemonApiKey: `test-${id}`,
        });
      await client.control("stop", "b");
      const before = await client.control("snapshot");
      const caller = invoke("2.0.0");
      await downloadStarted.promise;
      // Candidate download has started, but old Workspace process is still serving.
      expect(await client.control("snapshot")).toEqual(before);
      caller.kill("SIGTERM");
      await caller.exited;
      allowDownload.resolve();
      await waitFor(
        async () => (await results()).length === 1,
        "detached coordinator did not finish",
      );
      const result = await Bun.file(
        join(installRoot, "upgrade-results", (await results())[0]!),
      ).json();
      expect(result).toMatchObject({ status: "succeeded", version: "2.0.0" });
      const after = await client.control("snapshot");
      expect(after.find((runtime) => runtime.workspaceId === "a")?.version).toBe("2.0.0");
      expect(after.find((runtime) => runtime.workspaceId === "a")?.processId).not.toBe(
        before.find((runtime) => runtime.workspaceId === "a")?.processId,
      );
      expect(after.find((runtime) => runtime.workspaceId === "b")?.processId).toBe(0);
      const failed = invoke("3.0.0");
      expect(await failed.exited).not.toBe(0);
      const outcomes = await Promise.all(
        (await results()).map((name) =>
          Bun.file(join(installRoot, "upgrade-results", name)).json(),
        ),
      );
      expect(
        outcomes.some(
          (outcome) => outcome.status === "failed" && outcome.restoredVersion === "2.0.0",
        ),
      ).toBe(true);
      expect(
        (await client.control("snapshot")).find((runtime) => runtime.workspaceId === "a")?.version,
      ).toBe("2.0.0");
      feed.stop(true);
      const rollback = invoke("latest", "rollback");
      expect(await rollback.exited).toBe(0);
      const restored = await client.control("snapshot");
      expect(restored.find((runtime) => runtime.workspaceId === "a")?.version).toBe("1.0.0");
      expect(restored.find((runtime) => runtime.workspaceId === "b")?.processId).toBe(0);
    } finally {
      allowDownload.resolve();
      await host.stop().catch(() => {});
      // `systemctl stop` is normally synchronous, but keep cleanup ordered on
      // the externally observable systemd state before checking the supervisor
      // marker. This distinguishes a still-managed service from a supervisor
      // shutdown that failed to release ownership.
      await waitForSystemdUserUnitInactive(serviceName);
      await waitFor(
        async () => !(await Bun.file(join(stateDirectory, "supervisor.lock", "owner")).exists()),
        "supervisor cleanup did not complete",
      );
      Bun.spawnSync(["systemctl", "--user", "disable", "--now", serviceName]);
      await rm(unitPath, { force: true });
      Bun.spawnSync(["systemctl", "--user", "daemon-reload"]);
      feed.stop(true);
    }
  },
  180_000,
);
