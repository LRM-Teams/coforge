import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { decodeAgentStartIntent, type AgentStartIntent } from "@lrm/coforge-sdk/internal";
import { PrismaClient } from "#src/generated/prisma/client";
import { isAppError } from "#src/lib/app-error";
import { AgentControl } from "#src/server/agents/agent-control.server";
import { ChannelAgentControl } from "#src/server/conversations/channel-agent-control.server";
import { PublicChannels } from "#src/server/conversations/public-channels.server";
import { PrismaAgentControlStore } from "#src/server/db/repositories/agent-control.repositories.server";
import { PrismaWorkspaceCatalogStore } from "#src/server/workspaces/catalog.server";

/**
 * Resuming every stopped Agent in a channel with the member's guidance: each stopped Agent is
 * started again and its first turn is a prompt carrying the guidance, the channel and who gave
 * it, with no message recovery beside it. The call returns once the starts are recorded and sent,
 * without waiting for any Computer, and starts at most a few Agents at a time. An Agent whose
 * Computer is offline stays stopped and is reported, since it could not get the guidance; a later
 * re-send of a resumed Agent's Start (ready recovery) never carries the prompt again. Agents that
 * are not stopped, and Agents in other channels, are left alone. Blank or overlong guidance, a
 * non-member, and an archived channel are refused. Drives the real services against local
 * PostgreSQL.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;

async function errorOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (isAppError(error)) return error.code;
    throw error;
  }
  return undefined;
}

const runtimeConfig = {
  runtime: "pi",
  provider: { kind: "default" },
  model: "",
  modelProvider: "",
  reasoning: "",
};

test.skipIf(!connectionString)(
  "a channel member resumes every stopped Agent in the channel with their guidance",
  async () => {
    const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: connectionString! }) });
    const suffix = crypto.randomUUID().slice(0, 8);
    const owner = await db.user.create({ data: { username: `resume-owner-${suffix}` } });
    const member = await db.user.create({ data: { username: `resume-member-${suffix}` } });
    const outsider = await db.user.create({ data: { username: `resume-outsider-${suffix}` } });
    const workspace = await new PrismaWorkspaceCatalogStore(db).createForUser({
      slug: `resume-${suffix}`,
      name: "Resume channel Agents",
      userId: owner.id,
    });
    const started: { channel: string; intent: AgentStartIntent }[] = [];
    try {
      await db.workspaceMembership.createMany({
        data: [
          { workspaceId: workspace.id, userId: member.id, role: "member" },
          { workspaceId: workspace.id, userId: outsider.id, role: "member" },
        ],
      });
      const computer = await db.computer.create({
        data: { ownerId: owner.id, machineId: crypto.randomUUID() },
      });
      const offlineComputer = await db.computer.create({
        data: { ownerId: owner.id, machineId: crypto.randomUUID() },
      });
      await db.workspaceComputer.createMany({
        data: [
          { workspaceId: workspace.id, computerId: computer.id },
          { workspaceId: workspace.id, computerId: offlineComputer.id },
        ],
      });
      const stoppedAt = new Date("2026-09-24T00:00:00Z");
      const agent = (name: string, stopped: boolean, computerId = computer.id) =>
        db.agent.create({
          data: {
            workspaceId: workspace.id,
            name: `${name}-${suffix}`,
            displayName: name,
            ownerId: owner.id,
            computerId,
            runtimeConfig,
            stoppedAt: stopped ? stoppedAt : null,
          },
        });
      const [running, elsewhere, offline, ...stopped] = await Promise.all([
        agent("running", false),
        agent("elsewhere", true),
        agent("offline", true, offlineComputer.id),
        ...[1, 2, 3, 4, 5, 6].map((n) => agent(`stopped-${n}`, true)),
      ]);
      const toResume = stopped.map(({ id }) => id);
      const channels = new PublicChannels(db, undefined, undefined, undefined, {
        async messageAvailable() {},
        async memberChanged() {},
        async channelUpdated() {},
      });
      const team = await channels.create(workspace.id, member.id, `team-${suffix}`);
      const other = await channels.create(workspace.id, member.id, `other-${suffix}`);
      await channels.addMembers(workspace.id, { userId: member.id }, team.id, {
        userIds: [],
        agentIds: [...toResume, running.id, offline.id],
      });
      await channels.addMembers(workspace.id, { userId: member.id }, other.id, {
        userIds: [],
        agentIds: [elsewhere.id],
      });

      // The Computer never answers: a long timeout the call must not wait out.
      let inFlight = 0;
      let mostInFlight = 0;
      const control = new AgentControl(
        new PrismaAgentControlStore(db),
        {
          async publish(channel, bytes) {
            started.push({ channel, intent: decodeAgentStartIntent(bytes) });
          },
        },
        {
          async run(_id, work) {
            mostInFlight = Math.max(mostInFlight, ++inFlight);
            try {
              return await work();
            } finally {
              inFlight--;
            }
          },
        },
        { timeoutMs: 60_000 },
      );
      const agents = new ChannelAgentControl(db, control, {
        get: async ({ computerId }) => computerId === computer.id,
      });
      const guidance = "Stop changing the database schema; only the frontend.";

      expect(await errorOf(agents.resumeAll(workspace.id, outsider.id, team.id, guidance))).toBe(
        "ACCESS_DENIED",
      );
      expect(await errorOf(agents.resumeAll(workspace.id, member.id, team.id, "  "))).toBe(
        "INVALID_INPUT",
      );
      expect(
        await errorOf(agents.resumeAll(workspace.id, member.id, team.id, "x".repeat(4001))),
      ).toBe("INVALID_INPUT");

      const began = Date.now();
      expect(await agents.resumeAll(workspace.id, member.id, team.id, guidance)).toEqual({
        resumed: 6,
        failed: 0,
        offline: 1,
      });
      expect(Date.now() - began).toBeLessThan(5_000);
      expect(mostInFlight).toBeLessThanOrEqual(4);

      expect(started.map(({ intent }) => intent.agentId).sort()).toEqual([...toResume].sort());
      for (const { intent } of started) {
        expect(intent.resumePrompt).toContain(guidance);
        expect(intent.resumePrompt).toContain(`#team-${suffix}`);
        expect(intent.resumePrompt).toContain(`@resume-member-${suffix}`);
        expect(intent.wakeMessage).toBeUndefined();
        expect(intent.resumeMessages).toBeUndefined();
        expect(intent.unreadSummary).toBeUndefined();
      }
      const stoppedAtOf = async (id: string) =>
        (await db.agent.findUniqueOrThrow({ where: { id } })).stoppedAt;
      for (const id of toResume) expect(await stoppedAtOf(id)).toBeNull();
      expect(await stoppedAtOf(elsewhere.id)).toEqual(stoppedAt);
      expect(await stoppedAtOf(offline.id)).toEqual(stoppedAt);

      // A Daemon that reconnects before launching gets the same Start from ready recovery,
      // without the prompt.
      const [first] = started;
      const { resumePrompt: _prompt, ...recovered } = first!.intent;
      started.length = 0;
      await control.recover({ ...recovered, requestId: crypto.randomUUID() }, owner.id);
      expect(started).toHaveLength(1);
      expect(started[0]!.intent.agentId).toBe(first!.intent.agentId);
      expect(started[0]!.intent.resumePrompt).toBeUndefined();

      // Only the offline Agent is left to resume.
      expect(await agents.resumeAll(workspace.id, member.id, team.id, guidance)).toEqual({
        resumed: 0,
        failed: 0,
        offline: 1,
      });

      await channels.setArchived(workspace.id, { userId: owner.id }, team.id, true);
      expect(await errorOf(agents.resumeAll(workspace.id, member.id, team.id, guidance))).toBe(
        "CONFLICT",
      );
    } finally {
      await db.workspace.delete({ where: { id: workspace.id } }).catch(() => {});
      await db.computer.deleteMany({ where: { ownerId: owner.id } });
      await db.user.deleteMany({ where: { id: { in: [owner.id, member.id, outsider.id] } } });
      await db.$disconnect();
    }
  },
);
