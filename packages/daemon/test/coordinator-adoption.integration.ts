import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { LocalDaemonLauncher } from "../src/daemon-host/launcher";
import { SystemdWorkspaceInstance } from "../src/supervisor/systemd-workspace-instance";
import { COFORGE_DAEMON_SERVER_URL } from "../src/connection/built-server";

test("signal termination is observed even when Bun exitCode remains null", async () => {
  const child = Bun.spawn([process.execPath, "-e", "await Bun.sleep(60000)"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  try {
    child.kill("SIGKILL");
    await wait(async () => child.exitCode !== null || child.signalCode !== null);
    expect(await child.exited).toBe(137);
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBe("SIGKILL");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await child.exited;
  }
});

// Explicit Linux prepared-user-manager test. No cloud, no real model, no existing service.
test("Coordinator killed before handshake adopts the same OS instances; stopped binding stays stopped", async () => {
  await command(["show-environment"]);
  const root = await mkdtemp(join(tmpdir(), "cf-adopt-"));
  const binary = join(root, "fixture");
  const socketPath = join(root, "coordinator.sock");
  const directory = (id: string) => join(root, "workspaces", Buffer.from(id).toString("base64url"));
  const client = new LocalDaemonLauncher({
    executablePath: binary,
    socketPath,
    timeoutMilliseconds: 20_000,
  });
  const processes: Bun.Subprocess[] = [];
  const failures: unknown[] = [];
  const spawn = () => {
    const child = Bun.spawn(
      [binary, "__daemon", "--socket", socketPath, "--state-directory", root],
      {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "inherit",
      },
    );
    processes.push(child);
    return child;
  };
  const configure = (id: string) =>
    client.ensureStarted({
      workspaceId: id,
      computerId: "fixture",
      workspaceRoot: join(root, "agent", id),
      daemonApiKey: "test-only-key",
      serverHttpUrl: COFORGE_DAEMON_SERVER_URL,
    });
  try {
    const build = Bun.spawn(
      [
        process.execPath,
        "build",
        "--compile",
        join(import.meta.dir, "fixtures/coordinator-adoption-fixture.ts"),
        "--outfile",
        binary,
      ],
      { stdout: "ignore", stderr: "inherit" },
    );
    expect(await build.exited).toBe(0);
    let coordinator = spawn();
    await client.ensureRunning();
    await mkdir(directory("b"), { recursive: true });
    await Bun.write(join(directory("b"), "allow-handshake"), "ready");
    await configure("b");
    const b = (await client.control("snapshot")).find((entry) => entry.workspaceId === "b")!;
    const pending = configure("a").catch(() => {});
    await wait(() => Bun.file(join(directory("a"), "before-handshake")).exists());
    const aPid = Number(await Bun.file(join(directory("a"), "before-handshake")).text());
    const aAgent = Number(await Bun.file(join(directory("a"), "agent.ready")).text());
    expect(await live(aPid)).toBe(true);
    expect(await live(aAgent)).toBe(true);
    coordinator.kill("SIGKILL");
    await coordinator.exited;
    await pending;
    await Bun.write(join(directory("a"), "allow-handshake"), "ready");
    coordinator = spawn();
    await client.ensureRunning();
    const adopted = await client.control("snapshot");
    expect(adopted.find((entry) => entry.workspaceId === "a")?.processId).toBe(aPid);
    expect(adopted.find((entry) => entry.workspaceId === "b")).toEqual(b);
    expect(await live(aAgent)).toBe(true);
    const bAgent = Number(await Bun.file(join(directory("b"), "agent.ready")).text());
    expect(await live(bAgent)).toBe(true);
    // Production Coordinator + file store + OS units, with persistence cutpoints
    // injected only by the replacement fixture. No model/transcript assertions.
    for (const phase of ["stopping", "starting", "completed"]) {
      for (const when of ["before", "after"]) {
        const previous = (await client.control("snapshot")).find(
          (entry) => entry.workspaceId === "a",
        )!;
        const previousAgent = Number(await Bun.file(join(directory("a"), "agent.ready")).text());
        expect(await live(previous.processId)).toBe(true);
        expect(await live(previousAgent)).toBe(true);
        const requestId = `${when}-${phase}`;
        await Bun.write(
          join(root, "restart-cutpoint.json"),
          JSON.stringify({ requestId, phase, when }),
        );
        const interrupted = client.control("restart", "a", requestId).catch(() => null);
        await wait(async () => coordinator.exitCode !== null || coordinator.signalCode !== null);
        await coordinator.exited;
        await interrupted;
        expect(await Bun.file(join(root, "cutpoint-reached")).text()).toBe(`${when}:${phase}`);
        const spawnedBeforeCrash =
          phase === "completed"
            ? Number(await Bun.file(join(directory("a"), "before-handshake")).text())
            : null;
        coordinator = spawn();
        await client.ensureRunning();
        const completed = await client.control("restart", "a", requestId);
        const replacement = completed.find((entry) => entry.workspaceId === "a")!;
        if (spawnedBeforeCrash !== null) expect(replacement.processId).toBe(spawnedBeforeCrash);
        expect(replacement.processId).not.toBe(previous.processId);
        expect(replacement.instanceId).not.toBe(previous.instanceId);
        await wait(async () => !(await live(previous.processId)) && !(await live(previousAgent)));
        expect(await client.control("restart", "a", requestId)).toEqual(completed);
        expect(completed.find((entry) => entry.workspaceId === "b")).toEqual(b);
        expect(Number(await Bun.file(join(directory("b"), "agent.ready")).text())).toBe(bAgent);
        expect(await live(bAgent)).toBe(true);
      }
    }
    // OS crash recovery overlaps a persisted stopping phase while Coordinator is down.
    const beforeOverlap = (await client.control("snapshot")).find(
      (entry) => entry.workspaceId === "a",
    )!;
    const overlapAgent = Number(await Bun.file(join(directory("a"), "agent.ready")).text());
    await Bun.write(
      join(root, "restart-cutpoint.json"),
      JSON.stringify({ requestId: "overlap", phase: "stopping", when: "after" }),
    );
    const overlap = client.control("restart", "a", "overlap").catch(() => null);
    await wait(async () => coordinator.exitCode !== null || coordinator.signalCode !== null);
    await coordinator.exited;
    await overlap;
    const scopedUnit = new SystemdWorkspaceInstance(
      {
        stateRoot: root,
        workspaceId: "a",
        executablePath: binary,
        socketPath: join(directory("a"), "daemon.sock"),
        stateDirectory: directory("a"),
        unitDirectory: join(homedir(), ".config/systemd/user"),
      },
      async () => 0,
    );
    await command(["kill", "--kill-whom=main", "--signal=SIGKILL", scopedUnit.unitName]);
    await wait(async () => {
      const identity = await scopedUnit.identity();
      return (
        !!identity?.active && identity.mainPid > 0 && identity.mainPid !== beforeOverlap.processId
      );
    });
    const automatic = await scopedUnit.identity();
    expect(await live(beforeOverlap.processId)).toBe(false);
    await wait(async () => !(await live(overlapAgent)));
    coordinator = spawn();
    await client.ensureRunning();
    const afterOverlap = await client.control("restart", "a", "overlap");
    expect(afterOverlap.find((entry) => entry.workspaceId === "a")?.processId).toBe(
      automatic!.mainPid,
    );
    expect(afterOverlap.find((entry) => entry.workspaceId === "b")).toEqual(b);
    expect(await client.control("restart", "a", "overlap")).toEqual(afterOverlap);
    // Recovery cannot persist the next phase, yet local stop remains available
    // and cancels the pending operation rather than silently retrying it later.
    const beforeCancel = (await client.control("snapshot")).find(
      (entry) => entry.workspaceId === "a",
    )!;
    const cancelAgent = Number(await Bun.file(join(directory("a"), "agent.ready")).text());
    expect(await live(cancelAgent)).toBe(true);
    await Bun.write(
      join(root, "restart-cutpoint.json"),
      JSON.stringify({ requestId: "cancel", phase: "starting", when: "before" }),
    );
    const cancelled = client.control("restart", "a", "cancel").catch(() => null);
    await wait(async () => coordinator.exitCode !== null || coordinator.signalCode !== null);
    await coordinator.exited;
    await cancelled;
    await Bun.write(join(root, "reject-starting"), "fail");
    coordinator = spawn();
    await client.ensureRunning();
    await client.control("stop", "a");
    await expect(client.control("restart", "a", "cancel")).rejects.toThrow();
    await wait(async () => !(await live(beforeCancel.processId)) && !(await live(cancelAgent)));
    coordinator.kill("SIGKILL");
    await coordinator.exited;
    coordinator = spawn();
    await client.ensureRunning();
    const recovered = await client.control("snapshot");
    expect(recovered.find((entry) => entry.workspaceId === "a")?.processId).toBe(0);
    expect(recovered.find((entry) => entry.workspaceId === "b")).toEqual(b);
    await expect(client.control("restart", "a", "cancel")).rejects.toThrow();
    expect(await live(bAgent)).toBe(true);
  } catch (error) {
    failures.push(error);
  } finally {
    for (const child of processes) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await child.exited;
    }
    for (const id of ["a", "b"]) {
      const unit = new SystemdWorkspaceInstance(
        {
          stateRoot: root,
          workspaceId: id,
          executablePath: binary,
          socketPath: join(directory(id), "daemon.sock"),
          stateDirectory: directory(id),
          unitDirectory: join(homedir(), ".config/systemd/user"),
        },
        async (args) => {
          await command(args);
          return 0;
        },
      );
      await unit.stop().catch((error) => failures.push(error));
    }
    if (!failures.length) await rm(root, { recursive: true, force: true });
  }
  if (failures.length)
    throw new AggregateError(failures, `Coordinator regression failed; evidence retained: ${root}`);
}, 240_000);

async function command(args: string[]) {
  const child = Bun.spawn(["systemctl", "--user", ...args], { stdout: "ignore", stderr: "pipe" });
  const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (code) throw new Error(`systemctl failed: ${error}`);
}
async function live(pid: number) {
  const raw = await Bun.file(`/proc/${pid}/stat`)
    .text()
    .catch(() => "");
  return !!raw && !["Z", "X"].includes(raw.slice(raw.lastIndexOf(")") + 2).split(" ")[0]!);
}
async function wait(condition: () => Promise<boolean>) {
  const deadline = Date.now() + 15_000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("Coordinator observation timed out");
    await Bun.sleep(20);
  }
}
