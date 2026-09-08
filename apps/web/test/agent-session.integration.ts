import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/client";
import { AgentControl, agentControlRevision } from "../src/server/agents/agent-control.server";
import { decodeAgentStartIntent, type AgentStartIntent } from "@coforge/protocol";
import { AgentSessions } from "../src/server/agents/agent-sessions.server";
import { PrismaAgentControlStore } from "../src/server/db/repositories/agent-control.repositories.server";
import { PrismaAgentSessionRepository } from "../src/server/db/repositories/agent-session.repositories.server";

test("recovery creates a new current AgentSession and preserves the previous native identity", async () => {
  const connectionString = Bun.env.AGENT_SESSION_TEST_DATABASE_URL;
  if (!connectionString)
    throw new Error("AGENT_SESSION_TEST_DATABASE_URL is required (local PostgreSQL)");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const fixture = crypto.randomUUID();
  const runtimeConfig = { runtime: "pi", provider: { kind: "default" }, model: "", reasoning: "" };
  const owner = await db.user.create({ data: { username: `session-${fixture}` } });
  const workspace = await db.workspace.create({
    data: {
      slug: `session-${fixture}`,
      name: "Session repository test",
      members: { create: { userId: owner.id } },
    },
  });
  try {
    const computer = await db.computer.create({
      data: { ownerId: owner.id, machineId: `session-${fixture}` },
    });
    await db.workspaceComputer.create({
      data: { workspaceId: workspace.id, computerId: computer.id },
    });
    const agent = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: owner.id,
        computerId: computer.id,
        name: "recovery",
        displayName: "Recovery",
        runtimeConfig,
      },
    });
    const oldSession = await db.agentSession.create({
      data: {
        agentId: agent.id,
        workspaceId: workspace.id,
        computerId: computer.id,
        provider: "pi",
        nativeSessionId: "native-old",
        state: "resumable",
      },
    });
    const control = {
      version: 1 as const,
      protocolMajor: 1 as const,
      requestId: fixture,
      workspaceId: workspace.id,
      computerId: computer.id,
      agentId: agent.id,
      provider: "pi" as const,
      epoch: 1,
      action: "start" as const,
      phase: "starting" as const,
      configRevision: agentControlRevision(runtimeConfig),
      launchId: "launch-a",
      controlSequence: 0,
      sessionSequence: 0,
    };
    await db.agent.update({
      where: { id: agent.id },
      data: { currentSessionId: oldSession.id, controlState: control },
    });

    const sessions = new AgentSessions(
      new PrismaAgentSessionRepository(db),
      async () => "daemon-current",
    );
    const prepared = await sessions.prepare({
      protocolMajor: 1,
      requestId: control.requestId,
      workspaceId: workspace.id,
      computerId: computer.id,
      agentId: agent.id,
      provider: "pi",
      model: "",
      reasoning: "",
      controlEpoch: control.epoch,
      sessionId: "native-old",
    });
    expect(prepared.sessionId).toBe("native-old");
    expect((await db.agent.findUniqueOrThrow({ where: { id: agent.id } })).currentSessionId).toBe(
      oldSession.id,
    );

    const store = new PrismaAgentControlStore(db);
    const before = await store.get(agent.id);
    expect(before?.state?.identity?.sessionId).toBe("native-old");
    if (!before?.state) throw new Error("Session fixture was not readable");
    expect(
      await store.replace(before, {
        ...before.state,
        identity: { sessionId: "native-recovered", state: "resumable" },
        launchIdentityBound: true,
        recovered: true,
        sessionSequence: 1,
      }),
    ).toBe(true);

    const rows = await db.agentSession.findMany({
      where: { agentId: agent.id },
      orderBy: { createdAt: "asc" },
    });
    expect(rows.map(({ nativeSessionId }) => nativeSessionId).sort()).toEqual(
      ["native-old", "native-recovered"].sort(),
    );
    expect(
      (await db.agent.findUniqueOrThrow({ where: { id: agent.id } })).currentSessionId,
    ).not.toBe(oldSession.id);
    const rebound = await store.get(agent.id);
    if (!rebound?.state) throw new Error("Recovered Session was not readable");
    await expect(
      store.replace(rebound, {
        ...rebound.state,
        identity: { sessionId: "illegal-change", state: "resumable" },
        sessionSequence: 2,
      }),
    ).rejects.toThrow("Native Session identity changed");
    for (const writer of ["control", "session"] as const) {
      const sessionRepository = new PrismaAgentSessionRepository(db);
      await db.agentSession.update({
        where: { id: rebound.currentSessionId! },
        data: { state: "empty" },
      });
      const beforeControl = (await store.get(agent.id))!;
      const beforeSession = (await sessionRepository.read(agent.id))!.reference!;
      const entered = Promise.withResolvers<number>();
      const release = Promise.withResolvers<void>();
      const updating = db.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM agents WHERE id = ${agent.id}::uuid FOR UPDATE`;
          const [backend] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
          await tx.agentSession.update({
            where: { id: rebound.currentSessionId! },
            data: { state: "resumable" },
          });
          entered.resolve(backend!.pid);
          await release.promise;
        },
        { timeout: 10_000 },
      );
      const blocker = await entered.promise;
      const stale =
        writer === "control"
          ? store.replace(beforeControl, { ...beforeControl.state!, sessionSequence: 2 })
          : sessionRepository.replace(agent.id, beforeSession, beforeSession, {
              workspaceId: workspace.id,
              requestId: control.requestId,
              controlEpoch: 1,
            });
      try {
        const deadline = Date.now() + 4_000;
        // Observe an actual PostgreSQL lock wait, not a guessed async scheduling delay.
        for (;;) {
          const [waiting] = await db.$queryRaw<{ blocked: boolean }[]>`SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity WHERE ${blocker}::int = ANY(pg_blocking_pids(pid))
          ) AS blocked`;
          if (waiting?.blocked) break;
          if (Date.now() >= deadline) throw new Error("Session writer did not reach its row lock");
          await Bun.sleep(5);
        }
        release.resolve();
        await updating;
        expect(await stale).toBe(false);
        expect((await store.get(agent.id))?.identity?.state).toBe("resumable");
      } finally {
        release.resolve();
        await Promise.allSettled([updating, stale]);
      }
    }
    expect(
      await store.replace(rebound, { ...rebound.state, action: "stop", phase: "completed" }),
    ).toBe(true);
    await db.agent.update({
      where: { id: agent.id },
      data: {
        runtimeConfig: { ...runtimeConfig, runtime: "codex" },
      },
    });
    const starts: AgentStartIntent[] = [];
    const controller = new AgentControl(
      store,
      {
        publish: async (_channel, bytes) => {
          starts.push(decodeAgentStartIntent(bytes));
        },
      },
      { run: async (_id, work) => work() },
      undefined,
      sessions,
    );
    await controller.publishStart(
      {
        ...prepared,
        provider: "codex",
        requestId: "switch-provider",
        sessionId: undefined,
      },
      owner.id,
    );
    expect(starts[0]?.sessionId).toBeUndefined();
    expect(starts[0]?.provider).toBe("codex");
    const switched = await store.get(agent.id);
    expect(switched?.identity).toBeUndefined();
    expect(switched?.currentSessionId).not.toBe(rebound.currentSessionId);
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.computer.deleteMany({ where: { ownerId: owner.id } });
    await db.user.delete({ where: { id: owner.id } });
    await db.$disconnect();
  }
});
