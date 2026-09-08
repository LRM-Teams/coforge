import { expect, test } from "bun:test";
import { RedisClient } from "bun";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/client";
import { findOwnedSkillsAssignment } from "../src/server/agents/agent-skills.server";
import { RedisAgentSkillsResults } from "../src/server/centrifugo/agent-skills-cache.server";
import type { AgentSkillsListResult } from "@coforge/protocol";

test("Skills authorization requires Agent ownership and current membership, not Computer ownership", async () => {
  if (!Bun.env.SKILLS_TEST_DATABASE_URL)
    throw new Error("SKILLS_TEST_DATABASE_URL must target local PostgreSQL");
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: Bun.env.SKILLS_TEST_DATABASE_URL }),
  });
  const suffix = crypto.randomUUID();
  const owner = await db.user.create({ data: { username: `skills-owner-${suffix}` } });
  const computerOwner = await db.user.create({ data: { username: `skills-computer-${suffix}` } });
  const workspace = await db.workspace.create({
    data: {
      slug: suffix,
      name: "Skills test",
      members: { create: [{ userId: owner.id }, { userId: computerOwner.id }] },
    },
  });
  const computer = await db.computer.create({
    data: {
      ownerId: computerOwner.id,
      machineId: suffix,
      workspaces: { create: { workspaceId: workspace.id } },
    },
  });
  try {
    const agent = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: owner.id,
        computerId: computer.id,
        name: "skills-test",
        displayName: "Skills test",
        runtimeConfig: {
          runtime: "codex",
          provider: { kind: "default" },
          model: "",
          reasoning: "",
        },
      },
    });
    const viewer = { userId: owner.id, workspaceId: workspace.id };
    const assignment = await findOwnedSkillsAssignment(db, viewer, agent.id);
    expect(assignment).toMatchObject({ computerId: computer.id, provider: "codex" });
    expect(
      await findOwnedSkillsAssignment(db, { ...viewer, userId: computerOwner.id }, agent.id),
    ).toBeUndefined();
    expect(
      await findOwnedSkillsAssignment(
        db,
        { ...viewer, workspaceId: crypto.randomUUID() },
        agent.id,
      ),
    ).toBeUndefined();
    await db.agent.update({
      where: { id: agent.id },
      data: {
        runtimeConfig: { runtime: "pi", provider: { kind: "default" }, model: "", reasoning: "" },
      },
    });
    expect((await findOwnedSkillsAssignment(db, viewer, agent.id))?.revision).not.toBe(
      assignment?.revision,
    );
    await db.workspaceMembership.deleteMany({
      where: { workspaceId: workspace.id, userId: owner.id },
    });
    expect(await findOwnedSkillsAssignment(db, viewer, agent.id)).toBeUndefined();
    await db.workspaceMembership.create({ data: { workspaceId: workspace.id, userId: owner.id } });
    await db.workspaceComputer.deleteMany({ where: { computerId: computer.id } });
    expect(await findOwnedSkillsAssignment(db, viewer, agent.id)).toBeUndefined();
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.computer.delete({ where: { id: computer.id } });
    await db.user.deleteMany({ where: { id: { in: [owner.id, computerOwner.id] } } });
    await db.$disconnect();
  }
});

test("Redis Skills results reject unsolicited, mismatched, duplicate and cancelled responses", async () => {
  if (!Bun.env.SKILLS_TEST_REDIS_URL)
    throw new Error("SKILLS_TEST_REDIS_URL must target local Redis");
  const redis = new RedisClient(Bun.env.SKILLS_TEST_REDIS_URL);
  const results = new RedisAgentSkillsResults(redis);
  const result: AgentSkillsListResult = {
    protocolMajor: 1,
    requestId: crypto.randomUUID(),
    workspaceId: "workspace",
    computerId: "computer",
    agentId: "agent",
    provider: "codex",
    scannedAtMs: 1,
    global: { status: "ok", entries: [], directories: [] },
    workspace: { status: "partial", entries: [], directories: [] },
  };
  try {
    await results.accept(result);
    expect(await results.read(result.requestId)).toBeUndefined();
    await results.begin({ request: result, userId: "owner", revision: "config" });
    for (const changed of [
      { agentId: "other" },
      { workspaceId: "other" },
      { computerId: "other" },
      { provider: "pi" as const },
    ]) {
      await results.accept({ ...result, ...changed });
      expect(await results.read(result.requestId)).toBeUndefined();
    }
    await results.accept(result);
    await results.accept({ ...result, scannedAtMs: 2 });
    expect(await results.read(result.requestId)).toEqual(result);
    await results.clear(result.requestId);
    await results.accept(result);
    expect(await results.read(result.requestId)).toBeUndefined();
    await results.begin({ request: result, userId: "owner", revision: "config" });
    await redis.send("PEXPIRE", [`coforge:agent-skills:v1:${result.requestId}:pending`, "0"]);
    await results.accept(result);
    expect(await results.read(result.requestId)).toBeUndefined();
  } finally {
    await results.clear(result.requestId);
    redis.close();
  }
});
