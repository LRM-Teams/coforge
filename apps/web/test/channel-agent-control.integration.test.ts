import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { decodeAgentStopIntent } from "@lrm/coforge-sdk/internal";
import { PrismaClient } from "#src/generated/prisma/client";
import { isAppError } from "#src/lib/app-error";
import { AgentControl } from "#src/server/agents/agent-control.server";
import { ChannelAgentControl } from "#src/server/conversations/channel-agent-control.server";
import { PublicChannels } from "#src/server/conversations/public-channels.server";
import { PrismaAgentControlStore } from "#src/server/db/repositories/agent-control.repositories.server";
import { PrismaWorkspaceCatalogStore } from "#src/server/workspaces/catalog.server";

/**
 * Stopping every Agent in a channel at once, as any member of it may: each Agent that is not
 * already stopped gets the same durable stop a single Stop writes, and its Computer is sent the
 * stop command. The call returns once the stops are recorded and sent, without waiting for any
 * Computer to answer, and stops at most a few Agents at a time so one click cannot take every
 * database connection. A stop whose command could not be sent counts as failed and is sent again
 * by the next stop. Agents in other channels, Agents already stopped, and Agents that cannot be
 * controlled from this Workspace (their Computer is not attached to it) are left alone. A
 * non-member, and anyone on an archived channel, is refused. Drives the real services against
 * local PostgreSQL.
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
  "a channel member stops every running Agent in the channel without waiting for the Computers",
  async () => {
    const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: connectionString! }) });
    const suffix = crypto.randomUUID().slice(0, 8);
    const owner = await db.user.create({ data: { username: `sos-owner-${suffix}` } });
    const member = await db.user.create({ data: { username: `sos-member-${suffix}` } });
    const outsider = await db.user.create({ data: { username: `sos-outsider-${suffix}` } });
    const workspace = await new PrismaWorkspaceCatalogStore(db).createForUser({
      slug: `sos-${suffix}`,
      name: "Stop channel Agents",
      userId: owner.id,
    });
    const published: { channel: string; agentId: string }[] = [];
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
      await db.workspaceComputer.create({
        data: { workspaceId: workspace.id, computerId: computer.id },
      });
      const detachedComputer = await db.computer.create({
        data: { ownerId: owner.id, machineId: crypto.randomUUID() },
      });
      const agent = (name: string, stoppedAt: Date | null = null, computerId = computer.id) =>
        db.agent.create({
          data: {
            workspaceId: workspace.id,
            name: `${name}-${suffix}`,
            displayName: name,
            ownerId: owner.id,
            computerId,
            runtimeConfig,
            stoppedAt,
          },
        });
      const [detached, unreachable, alreadyStopped, elsewhere, ...running] = await Promise.all([
        agent("detached", null, detachedComputer.id),
        agent("unreachable"),
        agent("stopped", new Date("2026-09-24T00:00:00Z")),
        agent("elsewhere"),
        ...[1, 2, 3, 4, 5, 6].map((n) => agent(`running-${n}`)),
      ]);
      const toStop = [unreachable.id, ...running.map(({ id }) => id)];
      const channels = new PublicChannels(db, undefined, undefined, undefined, {
        async messageAvailable() {},
        async memberChanged() {},
        async channelUpdated() {},
      });
      const team = await channels.create(workspace.id, member.id, `team-${suffix}`);
      const other = await channels.create(workspace.id, member.id, `other-${suffix}`);
      await channels.addMembers(workspace.id, { userId: member.id }, team.id, {
        userIds: [],
        agentIds: [...toStop, alreadyStopped.id, detached.id],
      });
      await channels.addMembers(workspace.id, { userId: member.id }, other.id, {
        userIds: [],
        agentIds: [elsewhere.id],
      });

      // The Computer answers each stop only after the call has returned, behind a long timeout
      // the call must not wait out. The unreachable Agent's stop command cannot be sent the first
      // time round.
      let unreachableSends = 0;
      const answers: Promise<void>[] = [];
      let inFlight = 0;
      let mostInFlight = 0;
      const control = new AgentControl(
        new PrismaAgentControlStore(db),
        {
          async publish(channel, bytes) {
            const { agentId } = decodeAgentStopIntent(bytes);
            if (agentId === unreachable.id && ++unreachableSends <= 2)
              throw new Error("publish failed");
            published.push({ channel, agentId });
            const intent = decodeAgentStopIntent(bytes);
            answers.push(
              Bun.sleep(0).then(() =>
                control.result(intent, {
                  ...intent,
                  provider: intent.provider!,
                  epoch: intent.controlEpoch!,
                  phase: "stopped",
                  sequence: 1,
                }),
              ),
            );
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
      const stop = new ChannelAgentControl(db, control, { get: async () => true });

      // The panel offers the stop to the channel's members only.
      expect((await channels.open(workspace.id, member.id, team.id)).canStopAgents).toBe(true);
      expect((await channels.open(workspace.id, outsider.id, team.id)).canStopAgents).toBe(false);
      expect(await errorOf(stop.stopAll(workspace.id, outsider.id, team.id))).toBe("ACCESS_DENIED");

      const began = Date.now();
      expect(await stop.stopAll(workspace.id, member.id, team.id)).toEqual({
        stopped: 6,
        failed: 1,
      });
      expect(Date.now() - began).toBeLessThan(5_000);
      expect(mostInFlight).toBeLessThanOrEqual(4);
      await Promise.all(answers);
      // Trying again sends the unreachable Agent's stop once more.
      expect(await stop.stopAll(workspace.id, member.id, team.id)).toEqual({
        stopped: 1,
        failed: 0,
      });

      const stoppedAt = async (id: string) =>
        (await db.agent.findUniqueOrThrow({ where: { id } })).stoppedAt;
      for (const id of toStop) expect(await stoppedAt(id)).toBeInstanceOf(Date);
      expect(await stoppedAt(alreadyStopped.id)).toEqual(new Date("2026-09-24T00:00:00Z"));
      expect(await stoppedAt(elsewhere.id)).toBeNull();
      expect(await stoppedAt(detached.id)).toBeNull();
      expect(published.map(({ agentId }) => agentId).sort()).toEqual([...toStop].sort());
      expect(new Set(published.map(({ channel }) => channel)).size).toBe(1);

      // An archived channel offers no stop.
      await channels.setArchived(workspace.id, { userId: owner.id }, team.id, true);
      expect((await channels.open(workspace.id, member.id, team.id)).canStopAgents).toBe(false);
      expect(await errorOf(stop.stopAll(workspace.id, member.id, team.id))).toBe("CONFLICT");
    } finally {
      await db.workspace.delete({ where: { id: workspace.id } }).catch(() => {});
      await db.computer.deleteMany({ where: { ownerId: owner.id } });
      await db.user.deleteMany({ where: { id: { in: [owner.id, member.id, outsider.id] } } });
      await db.$disconnect();
    }
  },
);
