import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/client";
import { prepareDaemonApiKey } from "../src/server/auth/daemon-api-key.server";
import { DEV_BROWSER_USER } from "../src/server/auth/dev-skip-auth.server";
import { PrismaAgentControlStore } from "../src/server/db/repositories/agent-control.repositories.server";
import {
  DaemonConnection,
  DaemonRuntime,
  InMemoryDaemonCredentialStore,
  PiDriver,
} from "../../../packages/daemon";

// Explicit opt-in: real local Web/PostgreSQL/Redis/Centrifugo and browser, but a
// deterministic Pi-protocol child instead of paid model inference. No TRUNCATE/FLUSHDB.
test("Profile controls and Skills cross Web, WSS, native child and Session persistence", async () => {
  if (Bun.env.COFORGE_CONTROL_E2E !== "1") throw new Error("COFORGE_CONTROL_E2E=1 is required");
  const connectionString = Bun.env.DATABASE_URL;
  if (!connectionString || new URL(connectionString).hostname !== "127.0.0.1")
    throw new Error("DATABASE_URL must target local PostgreSQL");
  const browserEnvironment = { ...Bun.env };
  const browserPath = Bun.which("agent-browser");
  if (!browserPath) throw new Error("agent-browser is required");
  const browserSession = `control-${crypto.randomUUID()}`;
  async function browser(...args: string[]) {
    const process = Bun.spawn([browserPath!, "--session", browserSession, ...args], {
      env: browserEnvironment,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    if (code !== 0) throw new Error(`Browser ${args[0]} failed: ${stderr}`);
    return stdout;
  }
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const root = await mkdtemp(join(tmpdir(), "coforge-control-e2e-"));
  const originalHome = Bun.env.HOME;
  const ownerId = DEV_BROWSER_USER.id;
  const membership = await db.workspaceMembership.findFirstOrThrow({ where: { userId: ownerId } });
  const workspaceId = membership.workspaceId;
  const computer = await db.computer.create({
    data: { ownerId, machineId: `control-e2e-${crypto.randomUUID()}` },
  });
  let runtime: DaemonRuntime | undefined;
  let agentId: string | undefined;
  try {
    await db.workspaceComputer.create({ data: { workspaceId, computerId: computer.id } });
    const key = prepareDaemonApiKey({
      principal: { userId: ownerId },
      workspaceId,
      computerId: computer.id,
    });
    await db.daemonApiKey.create({ data: key.record });
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(workspaceId, computer.id, key.apiKey);
    Bun.env.HOME = join(root, "home");
    const globalSkill = join(Bun.env.HOME, ".pi/agent/skills/control-global/SKILL.md");
    await Bun.write(
      globalSkill,
      "---\nname: control-global\ndescription: Temporary global fixture\n---\nNever display this body.\n",
    );
    const connection = {
      workspaceId,
      computerId: computer.id,
      workspaceRoot: join(root, "workspaces"),
      serverHttpUrl: "http://127.0.0.1:8789",
    };
    const createRuntime = () =>
      new DaemonRuntime(
        connection,
        () =>
          new PiDriver({
            command: [
              process.execPath,
              join(import.meta.dir, "../../../packages/daemon/test/fixtures/pi-session-control.ts"),
            ],
          }),
        credentials,
        { create: () => new DaemonConnection("ws://127.0.0.1:8000/connection/websocket") },
        undefined,
        async () => ({
          runtimes: [{ provider: "pi", version: "fixture", displayName: "Pi protocol fixture" }],
          catalogs: [],
        }),
        join(root, "state"),
      );
    runtime = createRuntime();
    await runtime.start(connection);
    const agent = await db.agent.create({
      data: {
        workspaceId,
        ownerId,
        computerId: computer.id,
        name: `control-e2e-${crypto.randomUUID().slice(0, 8)}`,
        displayName: "Session control test (temporary)",
        description: "Isolated functional verification fixture",
        runtimeConfig: {
          runtime: "pi",
          provider: { kind: "default" },
          model: "",
          modelProvider: "",
          reasoning: "",
        },
      },
    });
    agentId = agent.id;
    const store = new PrismaAgentControlStore(db);
    const read = () => store.get(agent.id);
    const workspace = join(connection.workspaceRoot, workspaceId, "agents", agent.id);
    const marker = join(workspace, "keep.txt");
    const workspaceSkill = join(workspace, ".pi/skills/control-workspace/SKILL.md");
    const sibling = join(
      connection.workspaceRoot,
      workspaceId,
      "agents",
      "sibling-fixture",
      "keep.txt",
    );
    await Bun.write(sibling, "other Agent untouched");

    await browser("open", `http://127.0.0.1:8790/agents/${agent.id}`);
    await browser("set", "viewport", "1280", "900", "2");
    await browser(
      "wait",
      "--fn",
      "!!document.querySelector('[data-agent-control] button:not(:disabled)')",
    );
    async function openAction(action: "restart" | "reset-session" | "full-reset") {
      await browser("find", "role", "button", "click", "--name", "Restart", "--exact");
      await browser("click", `[data-control-action="${action}"]`);
    }
    async function capture() {
      await browser(
        "eval",
        "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
      );
      console.log(
        await browser(
          "screenshot",
          "--screenshot-dir",
          join(import.meta.dir, "../../../.amp/in/artifacts"),
        ),
      );
    }
    async function submitAction() {
      const before = (await read())?.state?.requestId;
      await browser("click", "[data-control-submit]");
      await browser(
        "wait",
        "--fn",
        "Array.from(document.querySelectorAll('[role=dialog]')).every(dialog => !dialog.getClientRects().length)",
      );
      await waitFor(async () => {
        const state = (await read())?.state;
        if (state?.requestId !== before && state?.phase === "failed")
          throw new Error(`Control failed: ${state.errorCode}`);
        return !!state && state.requestId !== before && state.phase === "completed";
      });
      // Completion is verified through persisted runtime facts, not a removed UI progress panel.
      expect(
        (
          await browser(
            "eval",
            "document.querySelector('[data-agent-control] [role=status]') === null",
          )
        ).trim(),
      ).toBe("true");
      return (await read())!.state!;
    }
    await openAction("restart");
    await capture();
    const initial = await submitAction();
    expect(initial.identity?.state).toBe("empty");
    await openAction("restart");
    const emptyRestart = await submitAction();
    expect(emptyRestart.identity?.sessionId).not.toBe(initial.identity?.sessionId);
    expect(emptyRestart.recovered).toBeUndefined();
    expect(emptyRestart.errorCode).toBeUndefined();

    await runtime.agentProcessManager.session(agent.id)!.sendMessage("persist fixture attention");
    await waitFor(async () => (await read())?.state?.identity?.state === "resumable");
    const resumableId = (await read())!.state!.identity!.sessionId;
    const oldPid = Number(await Bun.file(join(workspace, ".control-child-pid")).text());
    await openAction("restart");
    const restart = await submitAction();
    expect(restart.identity?.sessionId).toBe(resumableId);
    expect(() => process.kill(oldPid, 0)).toThrow();
    expect(Number(await Bun.file(join(workspace, ".control-child-pid")).text())).not.toBe(oldPid);
    await browser("find", "role", "link", "click", "--name", "Activity", "--exact");
    await browser(
      "wait",
      "--fn",
      "document.querySelector('main ol')?.textContent.includes('Starting') && document.querySelector('main ol')?.textContent.includes('Stopped')",
    );
    // Activity intentionally renders labels, not the redundant native status message.
    expect(await browser("get", "text", "main ol")).toContain("Starting");
    await capture();
    await browser("find", "role", "link", "click", "--name", "Profile", "--exact");

    await Bun.write(marker, "preserve on session reset");
    await Bun.write(
      workspaceSkill,
      "---\nname: control-workspace\ndescription: Temporary workspace fixture\n---\nNever display this body.\n",
    );
    await browser("find", "role", "button", "click", "--name", "Refresh skills", "--exact");
    await browser(
      "wait",
      "--fn",
      "document.querySelectorAll('table').length === 2 && document.body.textContent.includes('control-workspace')",
    );
    const skills = await browser("get", "text", "body");
    expect(skills).toContain("control-global");
    expect(skills).not.toContain("Never display this body.");
    await browser(
      "eval",
      "Array.from(document.querySelectorAll('section')).find(section => section.querySelector('h2')?.textContent === 'Skills').scrollIntoView({block: 'center'})",
    );
    await capture();
    await openAction("reset-session");
    await capture();
    const reset = await submitAction();
    expect(reset.identity?.sessionId).not.toBe(resumableId);
    expect(await Bun.file(marker).text()).toBe("preserve on session reset");
    expect(await Bun.file(workspaceSkill).exists()).toBe(true);

    await openAction("full-reset");
    await browser("find", "role", "button", "click", "--name", "Cancel", "--exact");
    await browser(
      "wait",
      "--fn",
      "Array.from(document.querySelectorAll('[role=dialog]')).every(dialog => !dialog.getClientRects().length)",
    );
    expect(await Bun.file(marker).exists()).toBe(true);
    await openAction("full-reset");
    await capture();
    await browser("set", "viewport", "390", "844", "2");
    expect(
      (
        await browser(
          "eval",
          "(() => { const button = document.querySelector('[data-control-submit]').getBoundingClientRect(); return button.top >= 0 && button.bottom <= innerHeight && button.right <= innerWidth; })()",
        )
      ).trim(),
    ).toBe("true");
    await capture();
    await browser(
      "eval",
      "document.querySelector('[role=dialog] [role=alert]').scrollIntoView({block: 'nearest'})",
    );
    expect(
      (
        await browser(
          "eval",
          "(() => { const warning = document.querySelector('[role=dialog] [role=alert]').getBoundingClientRect(); const footer = document.querySelector('[data-control-submit]').parentElement.getBoundingClientRect(); return warning.top >= 0 && warning.bottom <= footer.top; })()",
        )
      ).trim(),
    ).toBe("true");
    await capture();
    await browser("set", "viewport", "1280", "900", "2");
    const fullReset = await submitAction();
    expect(fullReset.identity?.sessionId).not.toBe(reset.identity?.sessionId);
    expect(await Bun.file(marker).exists()).toBe(false);
    expect(await Bun.file(workspaceSkill).exists()).toBe(false);
    expect(await Bun.file(sibling).text()).toBe("other Agent untouched");
    expect(await Bun.file(globalSkill).text()).toContain("Never display this body.");
    await browser("find", "role", "button", "click", "--name", "Refresh skills", "--exact");
    await browser(
      "wait",
      "--fn",
      "!document.body.textContent.includes('control-workspace') && document.body.textContent.includes('control-global')",
    );
    await browser(
      "eval",
      "document.querySelector('[data-agent-control]').scrollIntoView({block: 'center'})",
    );
    await capture();

    await runtime.stop();
    runtime = createRuntime();
    await runtime.start(connection);
    await waitFor(async () => {
      const state = (await read())?.state;
      return state?.requestId !== fullReset.requestId && state?.phase === "completed";
    });
    expect(runtime.agentProcessManager.size).toBe(1);
    expect((await read())?.state?.recovered).toBeUndefined();
    console.log(
      "Verified: empty fresh, exact resume, old child exit, session reset, Full Reset scope, Skills metadata, daemon restart",
    );
  } finally {
    await runtime?.stop();
    if (agentId) await db.agent.deleteMany({ where: { id: agentId } });
    await db.computer.delete({ where: { id: computer.id } });
    await db.$disconnect();
    if (originalHome === undefined) delete Bun.env.HOME;
    else Bun.env.HOME = originalHome;
    await browser("close").catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

async function waitFor(observe: () => Promise<boolean>) {
  const deadline = Date.now() + 15_000;
  while (!(await observe())) {
    if (Date.now() >= deadline)
      throw new Error("Timed out waiting for observable control completion");
    await Bun.sleep(50);
  }
}
