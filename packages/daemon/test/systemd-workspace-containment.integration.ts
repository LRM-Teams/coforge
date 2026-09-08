import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { SystemdWorkspaceInstance } from "../src/supervisor/systemd-workspace-instance";

// Explicit invocation: mise exec -- bun test ./packages/daemon/test/systemd-workspace-containment.integration.ts
// Requires an existing Linux user manager. Never installs one or changes lingering.
test("Workspace pre-readiness SIGKILL cleans live detached descendants without affecting B", async () => {
  expect(process.platform).toBe("linux");
  // An unrelated failed unit can mark a reachable manager degraded.
  // Check manager connectivity; this test asserts its own units' health below.
  await command(["show-environment"]);
  const root = await mkdtemp(join(tmpdir(), "coforge-containment-"));
  const units: SystemdWorkspaceInstance[] = [];
  const failures: unknown[] = [];
  try {
    const executablePath = join(root, "fixture");
    const build = Bun.spawn(
      [
        process.execPath,
        "build",
        "--compile",
        join(import.meta.dir, "fixtures/workspace-descendant-fixture.ts"),
        "--outfile",
        executablePath,
      ],
      { stdout: "ignore", stderr: "inherit" },
    );
    expect(await build.exited).toBe(0);
    const make = (workspaceId: string) => {
      const instance = new SystemdWorkspaceInstance(
        {
          stateRoot: root,
          workspaceId,
          executablePath,
          socketPath: join(root, workspaceId, "daemon.sock"),
          stateDirectory: join(root, workspaceId),
          unitDirectory: join(homedir(), ".config/systemd/user"),
        },
        async (args) => {
          await command(args);
          return 0;
        },
      );
      units.push(instance);
      return instance;
    };
    const b = make("b");
    const bPid = await b.ensureStarted();
    const bIdentity = await b.identity();
    expect(bIdentity).toMatchObject({ mainPid: bPid, active: true });
    const bAgent = await ready(root, "b", bPid, b.unitName);
    for (let iteration = 0; iteration < 5; iteration++) {
      const name = `a-${iteration}`;
      const a = make(name);
      const aPid = await a.ensureStarted();
      const aAgent = await ready(root, name, aPid, a.unitName);
      expect(await a.ensureStarted()).toBe(aPid);
      await Bun.write(join(root, name, "crash"), "SIGKILL");
      await wait(
        async () => !(await live(aPid)) && !(await live(aAgent)) && !(await a.identity())?.active,
      );
      expect(await b.identity()).toEqual(bIdentity);
      expect(await live(bPid)).toBe(true);
      expect(await live(bAgent)).toBe(true);
      console.log(
        JSON.stringify({
          iteration: iteration + 1,
          aPid,
          aAgent,
          bPid,
          bAgent,
          detachedAgentExited: true,
        }),
      );
    }
  } catch (error) {
    failures.push(error);
  } finally {
    for (const unit of units) {
      try {
        await command(["stop", unit.unitName]);
        await rm(unit.unitPath, { force: true });
        await command(["reset-failed", unit.unitName]).catch(() => {});
      } catch (error) {
        failures.push(error);
      }
    }
    await command(["daemon-reload"]).catch((error) => failures.push(error));
    if (!failures.length) await rm(root, { recursive: true, force: true });
  }
  if (failures.length)
    throw new AggregateError(failures, `Containment test failed; state retained: ${root}`);
}, 120_000);

async function command(args: string[]) {
  const child = Bun.spawn(["systemctl", "--user", ...args], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code) throw new Error(`systemctl ${args.join(" ")}: ${stderr || stdout}`);
  return stdout;
}

async function stat(pid: number) {
  const raw = await Bun.file(`/proc/${pid}/stat`)
    .text()
    .catch(() => "");
  return raw ? raw.slice(raw.lastIndexOf(")") + 2).split(" ") : undefined;
}
async function live(pid: number) {
  const fields = await stat(pid);
  return !!fields && fields[0] !== "Z" && fields[0] !== "X";
}
async function wait(condition: () => Promise<boolean>) {
  const deadline = Date.now() + 15_000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("Process observation timed out");
    await Bun.sleep(20);
  }
}
async function ready(root: string, name: string, pid: number, unit: string) {
  const directory = join(root, name);
  await wait(() => Bun.file(join(directory, "pre-ready")).exists());
  const agentPid = Number(await Bun.file(join(directory, "agent.pid")).text());
  expect(Number(await Bun.file(join(directory, "agent.ready")).text())).toBe(agentPid);
  expect(Number(await Bun.file(join(directory, "pre-ready")).text())).toBe(pid);
  expect(await live(pid)).toBe(true);
  expect(await live(agentPid)).toBe(true);
  expect(Number((await stat(agentPid))?.[2])).toBe(agentPid);
  expect(await Bun.file(`/proc/${agentPid}/cgroup`).text()).toContain(unit);
  expect(await Bun.file(join(directory, "workspace.ready")).exists()).toBe(false);
  return agentPid;
}
