import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DaemonCommandRejectedError,
  LocalDaemonLauncher,
  WorkspaceHealthJournal,
  workspaceHealthJournalPath,
  workspaceStateDirectory,
} from "@lrm/coforge-daemon";
import { UPGRADE_ERROR_CODE } from "@lrm/coforge-sdk/internal";
import {
  LIFECYCLE_ERROR_CODE,
  LIFECYCLE_EXIT_CODE,
  LifecycleAckSchema,
  LifecycleErrorSchema,
  LifecycleHoldSchema,
  LifecycleProtocolSchema,
  LifecycleStatusSchema,
} from "#src/release/installer-contract";

/*
 * `coforge-computer __lifecycle` is the only way the separately released installer controls a
 * running Computer, so its seam is the compiled executable: arguments in, one JSON object on
 * stdout, an exit status. Every response is parsed with the contract schema the installer's own
 * tests read (installer/contract/lifecycle.*.json).
 */

let root: string;
let executable: string;
let version: string;

/** macOS caps a Unix socket path at 104 bytes and its `TMPDIR` already spends 48 of them; the
 * Coordinator socket lives at `<home>/.coforge/daemon/daemon.sock`. See compiled-cli.test.ts.
 * `/tmp` is itself a symbolic link there, which the Coordinator refuses in its log path, so the
 * fixture root is resolved first. */
const FIXTURE_ROOT = process.platform === "darwin" ? "/tmp" : tmpdir();

/** Compiling the executable takes several seconds on a cold cache. */
const COMPILE_TIMEOUT_MS = 120_000;

/** How long a freshly spawned Coordinator gets to answer on its socket. */
const SUPERVISOR_READY_MS = 30_000;

beforeAll(async () => {
  root = await mkdtemp(join(await realpath(FIXTURE_ROOT), "cf-lifecycle-"));
  executable = join(root, "coforge-computer");
  const compiled = Bun.spawnSync([
    process.execPath,
    "build",
    "--compile",
    new URL("../src/main.ts", import.meta.url).pathname,
    "--outfile",
    executable,
  ]);
  if (compiled.exitCode !== 0) throw new Error(compiled.stderr.toString());
  version = Bun.spawnSync([executable, "--cli-version"]).stdout.toString().trim();
}, COMPILE_TIMEOUT_MS);

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

/** A fresh, empty home: nothing installed, no Coordinator state. */
async function freshHome(): Promise<string> {
  const home = join(root, crypto.randomUUID().slice(0, 8));
  await mkdir(home, { recursive: true });
  return home;
}

/** The Coordinator's state directory under `home` (installer/contract/paths.json). */
function stateDirectory(home: string): string {
  return join(home, ".coforge", "daemon");
}

/** Registers Workspace bindings the way the Coordinator persists them, without running it. */
async function writeBindings(home: string, bindings: { workspaceId: string; enabled: boolean }[]) {
  await mkdir(stateDirectory(home), { recursive: true });
  await writeFile(join(stateDirectory(home), "bindings.json"), `${JSON.stringify(bindings)}\n`);
}

/** Starts this build's Coordinator for `home`, with no Workspace bindings, and waits until it
 * answers on its socket. The returned client is the product's own local RPC client. */
async function startSupervisor(home: string) {
  const state = stateDirectory(home);
  const socketPath = join(state, "daemon.sock");
  const supervisor = Bun.spawn(
    [executable, "__daemon", "--socket", socketPath, "--state-directory", state],
    { env: { PATH: Bun.env.PATH, HOME: home }, stdout: "ignore", stderr: "ignore" },
  );
  const client = new LocalDaemonLauncher({
    executablePath: executable,
    socketPath,
    stateDirectory: state,
    spawn: () => {},
  });
  const deadline = Date.now() + SUPERVISOR_READY_MS;
  while (
    !(await client.identity().then(
      () => true,
      () => false,
    ))
  ) {
    if (supervisor.exitCode !== null) throw new Error("the supervisor exited before it answered");
    if (Date.now() >= deadline) throw new Error("the supervisor did not answer on its socket");
    await Bun.sleep(50);
  }
  return {
    client,
    async [Symbol.asyncDispose]() {
      supervisor.kill("SIGTERM");
      await supervisor.exited;
    },
  };
}

async function lifecycle(home: string, ...args: string[]) {
  const child = Bun.spawn([executable, "__lifecycle", ...args], {
    env: { PATH: Bun.env.PATH, HOME: home },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr, json: () => JSON.parse(stdout) as unknown };
}

test("protocol answers with the lifecycle protocol and this build's version", async () => {
  const result = await lifecycle(await freshHome(), "protocol");

  expect(result.exitCode).toBe(0);
  expect(LifecycleProtocolSchema.parse(result.json())).toEqual({
    lifecycle_protocol: 1,
    version,
  });
});

test("an unknown command is a usage error on stdout with exit status 2", async () => {
  const result = await lifecycle(await freshHome(), "explode");

  expect(result.exitCode).toBe(LIFECYCLE_EXIT_CODE.USAGE);
  expect(LifecycleErrorSchema.parse(result.json())).toMatchObject({
    ok: false,
    code: LIFECYCLE_ERROR_CODE.USAGE,
  });
});

test("status without a running supervisor reports the persisted bindings as unhealthy when one should be running", async () => {
  const home = await freshHome();
  await writeBindings(home, [
    { workspaceId: "ws_on", enabled: true },
    { workspaceId: "ws_off", enabled: false },
  ]);

  const result = await lifecycle(home, "status");

  expect(result.exitCode).toBe(0);
  const status = LifecycleStatusSchema.parse(result.json());
  expect(status).toEqual({
    lifecycle_protocol: 1,
    version,
    supervisor: { running: false },
    bindings: [
      { binding_id: "ws_on", enabled: true, running: false, process_id: null },
      { binding_id: "ws_off", enabled: false, running: false, process_id: null },
    ],
    healthy: false,
    problems: [expect.stringContaining("coforge-computer start")],
  });
});

test("status without a running supervisor is healthy when every enabled binding is parked", async () => {
  const home = await freshHome();
  await writeBindings(home, [{ workspaceId: "ws_parked", enabled: true }]);
  await new WorkspaceHealthJournal(
    workspaceHealthJournalPath(workspaceStateDirectory(stateDirectory(home), "ws_parked")),
  ).markParked("workspace_deleted");

  const result = await lifecycle(home, "status");

  expect(result.exitCode).toBe(0);
  expect(LifecycleStatusSchema.parse(result.json())).toMatchObject({
    supervisor: { running: false },
    healthy: true,
    problems: [],
  });
});

test("status on a machine with nothing configured is healthy and lists no bindings", async () => {
  const result = await lifecycle(await freshHome(), "status");

  expect(result.exitCode).toBe(0);
  expect(LifecycleStatusSchema.parse(result.json())).toMatchObject({
    supervisor: { running: false },
    bindings: [],
    healthy: true,
  });
});

test(
  "status reports the running supervisor's identity and version",
  async () => {
    const home = await freshHome();
    await using supervisor = await startSupervisor(home);
    const { daemonId } = await supervisor.client.identity();

    const result = await lifecycle(home, "status");

    expect(result.exitCode).toBe(0);
    expect(LifecycleStatusSchema.parse(result.json())).toEqual({
      lifecycle_protocol: 1,
      version,
      supervisor: { running: true, id: daemonId, version },
      bindings: [],
      healthy: true,
      problems: [],
    });
  },
  SUPERVISOR_READY_MS + 10_000,
);

test(
  "pause refuses Workspace lifecycle commands until resume lifts it",
  async () => {
    const home = await freshHome();
    await using supervisor = await startSupervisor(home);
    const requestId = crypto.randomUUID();

    const paused = await lifecycle(home, "pause", "--request-id", requestId);
    expect(paused.exitCode).toBe(0);
    expect(LifecycleAckSchema.parse(paused.json())).toEqual({ lifecycle_protocol: 1, ok: true });
    const refusal = await supervisor.client.control("stop").catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(DaemonCommandRejectedError);
    expect((refusal as DaemonCommandRejectedError).code).toBe(UPGRADE_ERROR_CODE.LAUNCHES_PAUSED);

    const resumed = await lifecycle(home, "resume", "--request-id", requestId);
    expect(resumed.exitCode).toBe(0);
    expect(LifecycleAckSchema.parse(resumed.json())).toEqual({ lifecycle_protocol: 1, ok: true });
    expect(await supervisor.client.control("stop")).toEqual([]);
  },
  SUPERVISOR_READY_MS + 10_000,
);

test(
  "hold reports an idle Computer quiescent at once, and release lifts it",
  async () => {
    const home = await freshHome();
    await using _supervisor = await startSupervisor(home);

    const held = await lifecycle(home, "hold", "--request-id", crypto.randomUUID());
    expect(held.exitCode).toBe(0);
    expect(LifecycleHoldSchema.parse(held.json())).toMatchObject({
      lifecycle_protocol: 1,
      quiescent: true,
      busy_agent_count: 0,
    });

    const released = await lifecycle(home, "release");
    expect(released.exitCode).toBe(0);
    expect(LifecycleAckSchema.parse(released.json())).toEqual({ lifecycle_protocol: 1, ok: true });
  },
  SUPERVISOR_READY_MS + 10_000,
);

test("pause without a running supervisor fails with a stable code and exit status 1", async () => {
  const result = await lifecycle(await freshHome(), "pause", "--request-id", crypto.randomUUID());

  expect(result.exitCode).toBe(LIFECYCLE_EXIT_CODE.FAILED);
  expect(LifecycleErrorSchema.parse(result.json())).toMatchObject({
    ok: false,
    code: LIFECYCLE_ERROR_CODE.SUPERVISOR_NOT_RUNNING,
  });
});
