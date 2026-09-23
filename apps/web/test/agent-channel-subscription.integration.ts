import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/client";
import { PublicChannels } from "../src/server/conversations/public-channels.server";
import { decodeAgentMessageDelivery } from "@lrm/coforge-sdk/internal";

test("human-managed channel subscriptions default off while mentions and followed threads still deliver", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString)
    throw new Error("CHANNEL_TEST_DATABASE_URL must point to local PostgreSQL");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const id = crypto.randomUUID();
  const owner = await db.user.create({ data: { username: `owner-${id}` } });
  const member = await db.user.create({ data: { username: `member-${id}` } });
  const workspace = await db.workspace.create({
    data: {
      slug: id,
      name: "Attention",
      members: { create: [{ userId: owner.id, role: "owner" }, { userId: member.id }] },
    },
  });
  const computer = await db.computer.create({ data: { ownerId: owner.id, machineId: id } });
  const agent = await db.agent.create({
    data: {
      workspaceId: workspace.id,
      ownerId: owner.id,
      computerId: computer.id,
      name: "helper",
      displayName: "Helper",
      runtimeConfig: {},
    },
  });
  const delivered: ReturnType<typeof decodeAgentMessageDelivery>[] = [];
  const channels = new PublicChannels(
    db,
    { execute: async (_scope, persist) => persist() },
    {
      publish: async (_channel, payload) => {
        delivered.push(decodeAgentMessageDelivery(payload));
      },
      publishJson: async () => {},
    },
  );
  try {
    const channel = await channels.create(workspace.id, owner.id, "engineering");
    await channels.addMembers(workspace.id, { userId: owner.id }, channel.id, {
      userIds: [member.id],
      agentIds: [agent.id],
    });
    const send = (body: string, threadRootId?: string) =>
      channels.send({
        workspaceId: workspace.id,
        userId: owner.id,
        channelId: channel.id,
        requestId: crypto.randomUUID(),
        body,
        threadRootId,
      });
    await send("Lunch anyone?");
    expect(delivered).toHaveLength(0);
    await expect(
      channels.setAgentChannelSubscribed(workspace.id, member.id, channel.id, agent.id, true),
    ).rejects.toThrow("ACCESS_DENIED");
    await channels.setAgentChannelSubscribed(workspace.id, owner.id, channel.id, agent.id, true);
    expect(
      (await channels.members(workspace.id, { userId: owner.id }, channel.id)).agents[0]
        ?.channelSubscribed,
    ).toBe(true);
    await send("A subscribed update");
    expect(delivered).toHaveLength(1);
    await channels.setAgentChannelSubscribed(workspace.id, owner.id, channel.id, agent.id, false);
    await channels.setAgentMuted(workspace.id, agent.id, "#engineering", false);
    await send("Legacy unmute must not subscribe");
    expect(delivered).toHaveLength(1);
    const root = await send("@helper please investigate");
    expect(delivered).toHaveLength(2);
    expect(delivered[1]?.mentionsAgent).toBe(true);
    await channels.setAgentThreadFollowed(workspace.id, agent.id, `#engineering:${root.id}`, true);
    await send("One more detail", root.id);
    expect(delivered).toHaveLength(3);
    await channels.setAgentThreadFollowed(workspace.id, agent.id, `#engineering:${root.id}`, false);
    await send("Unfollowed detail", root.id);
    expect(delivered).toHaveLength(3);
    await send("@helper come back", root.id);
    expect(delivered).toHaveLength(4);
    await channels.removeMember(workspace.id, owner.id, channel.id, { agentId: agent.id });
    await expect(
      channels.setAgentChannelSubscribed(workspace.id, owner.id, channel.id, agent.id, true),
    ).rejects.toThrow("NOT_FOUND");
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.computer.delete({ where: { id: computer.id } });
    await db.user.deleteMany({ where: { id: { in: [owner.id, member.id] } } });
    await db.$disconnect();
  }
});
