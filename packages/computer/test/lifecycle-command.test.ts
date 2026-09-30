import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LocalDaemonLauncher,
  WorkspaceHealthJournal,
  workspaceHealthJournalPath,
  workspaceStateDirectory,
} from "@lrm/coforge-daemon";
import {
  LIFECYCLE_ERROR_CODE,
  LIFECYCLE_EXIT_CODE,
  LifecycleErrorSchema,
  LifecycleProtocolSchema,
  LifecycleStatusSchema,
} from "#src/release/installer-contract";
import { SUPERVISOR_PROBLEM_CODE } from "#src/release/supervisor-status";

/*
 * `coforge-computer __lifecycle` is the only way the separately released installer reads a
 * Computer's state, so its seam is the compiled executable: arguments in, one JSON object on
 * stdout, an exit status. Every response is parsed with the contract schema the installer's own
 * tests read (crates/installer/contract/lifecycle.*.json).
 */

let root: string;
let executable: string;
let version: string;

/** macOS caps a Unix socket path at 104 bytes and its `TMPDIR` already spends 48 of them; the
 * supervisor socket lives at `<home>/.coforge/daemon/daemon.sock`. See compiled-cli.test.ts.
 * `/tmp` is itself a symbolic link there, which the supervisor refuses in its log path, so the
 * fixture root is resolved first. */
const FIXTURE_ROOT = process.platform === "darwin" ? "/tmp" : tmpdir();

/** Compiling the executable takes several seconds on a cold cache. */
const COMPILE_TIMEOUT_MS = 120_000;

/** How long a freshly spawned supervisor gets to answer on its socket. */
const SUPERVISOR_READY_MS = 30_000;

/** A test that starts a supervisor: its readiness bound plus one `__lifecycle status` call. */
const SUPERVISOR_TEST_TIMEOUT_MS = SUPERVISOR_READY_MS + 10_000;

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

/** A fresh, empty home: nothing installed, no supervisor state. */
async function freshHome(): Promise<string> {
  const home = join(root, crypto.randomUUID().slice(0, 8));
  await mkdir(home, { recursive: true });
  return home;
}

/** The supervisor's state directory under `home` (crates/installer/contract/paths.json). */
function stateDirectory(home: string): string {
  return join(home, ".coforge", "daemon");
}

/** Registers Workspace bindings the way the supervisor persists them, without running it. */
async function writeBindings(home: string, bindings: { workspaceId: string; enabled: boolean }[]) {
  await mkdir(stateDirectory(home), { recursive: true });
  await writeFile(join(stateDirectory(home), "bindings.json"), `${JSON.stringify(bindings)}\n`);
}

/** Starts this build's supervisor for `home`, with no Workspace bindings, and waits until it
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
    timeoutMilliseconds: SUPERVISOR_READY_MS,
  });
  try {
    await client.ensureRunning();
  } catch (error) {
    supervisor.kill("SIGKILL");
    await supervisor.exited;
    throw error;
  }
  return {
    client,
    async [Symbol.asyncDispose]() {
      supervisor.kill("SIGTERM");
      await supervisor.exited;
    },
  };
}

/** Asserts that `actual` has exactly the top-level fields of the named golden in
 * crates/installer/contract/, the files the installer's own tests read. */
async function expectGoldenFields(actual: unknown, golden: string) {
  const expected = await Bun.file(
    new URL(`../../../crates/installer/contract/${golden}`, import.meta.url),
  ).json();
  expect(Object.keys(actual as object).sort()).toEqual(Object.keys(expected).sort());
}

async function lifecycle(home: string, ...args: string[]) {
  const child = Bun.spawn([executable, "__lifecycle", ...args], {
    env: { PATH: Bun.env.PATH, HOME: home },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return { exitCode, json: () => JSON.parse(stdout) as unknown };
}

test("protocol answers with the lifecycle protocol and this build's version", async () => {
  const result = await lifecycle(await freshHome(), "protocol");

  expect(result.exitCode).toBe(0);
  expect(LifecycleProtocolSchema.parse(result.json())).toEqual({
    lifecycle_protocol: 1,
    version,
  });
  await expectGoldenFields(result.json(), "lifecycle.protocol.json");
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
    problems: [
      {
        code: SUPERVISOR_PROBLEM_CODE.SUPERVISOR_NOT_RUNNING,
        message: expect.stringContaining("coforge-computer start"),
      },
    ],
  });
  await expectGoldenFields(status, "lifecycle.status.absent.json");
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
    await expectGoldenFields(result.json(), "lifecycle.status.running.json");
  },
  SUPERVISOR_TEST_TIMEOUT_MS,
);

test.each(["pause", "hold", "release", "resume"])(
  "%s is not a lifecycle command: upgrades stop the service without pausing it",
  async (command) => {
    const result = await lifecycle(
      await freshHome(),
      command,
      "--request-id",
      "0f8b6d5e-2a41-4c3b-9e7d-1a2b3c4d5e6f",
    );

    expect(result.exitCode).toBe(LIFECYCLE_EXIT_CODE.USAGE);
    const error = LifecycleErrorSchema.parse(result.json());
    expect(error).toMatchObject({ code: LIFECYCLE_ERROR_CODE.USAGE });
    await expectGoldenFields(error, "lifecycle.error.json");
  },
);

test("protocol and status write nothing, so the installer can probe a binary that never ran", async () => {
  const home = await freshHome();

  expect((await lifecycle(home, "protocol")).exitCode).toBe(0);
  expect((await lifecycle(home, "status")).exitCode).toBe(0);

  expect(await readdir(home)).toEqual([]);
});

test("help is not offered: --help is a usage error like any unknown option", async () => {
  const result = await lifecycle(await freshHome(), "status", "--help");

  expect(result.exitCode).toBe(LIFECYCLE_EXIT_CODE.USAGE);
  expect(LifecycleErrorSchema.parse(result.json())).toMatchObject({
    code: LIFECYCLE_ERROR_CODE.USAGE,
  });
});
