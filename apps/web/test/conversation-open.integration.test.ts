import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { PublicChannels } from "#src/server/conversations/public-channels.server";
import { DirectConversations } from "#src/server/conversations/direct-conversations.server";

/**
 * What opening a channel or a DM returns for each kind of viewer, and that a channel open reads the
 * viewer's Workspace membership and their own member row once each. The open used to read the
 * membership twice and the member row three times (the page's member state, the @-completion
 * scores, the settings panel's capabilities); each read is one more database round trip on every
 * conversation open.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL, matching
 * `channel-mention-affinity-plan.integration.test.ts`.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;

const NO_CAPABILITIES = {
  post: false,
  leave: false,
  add_member: false,
  update: false,
  archive: false,
  unarchive: false,
  remove_member: false,
  manage_roles: false,
};

test.skipIf(!connectionString)(
  "opening a channel shows each viewer their own place in it, reading their rows once",
  async () => {
    const db = new PrismaClient({
      adapter: new PrismaPg({ connectionString: connectionString! }),
      log: [{ emit: "event", level: "query" }],
    });
    const statements: { query: string; params: unknown[] }[] = [];
    db.$on("query", (event) =>
      statements.push({ query: event.query, params: JSON.parse(event.params) }),
    );
    const handle = crypto.randomUUID().slice(0, 8);
    const [owner, member, leaver, bystander, stranger] = await Promise.all(
      ["owner", "member", "leaver", "bystander", "stranger"].map((name) =>
        db.user.create({ data: { username: `open-${name}-${handle}` } }),
      ),
    );
    const workspace = await db.workspace.create({
      data: {
        slug: `open-${handle}`,
        name: "Open",
        members: {
          create: [
            { userId: owner!.id, role: "owner" },
            { userId: member!.id },
            { userId: leaver!.id },
            { userId: bystander!.id },
          ],
        },
        agents: {
          create: {
            name: `open-agent-${handle}`,
            displayName: "Open Agent",
            ownerId: owner!.id,
            runtimeConfig: {},
          },
        },
      },
      include: { agents: true },
    });
    const agent = workspace.agents[0]!;
    try {
      const channel = await db.conversation.create({
        data: {
          workspaceId: workspace.id,
          channelName: `open-${handle}`,
          coordinatorAgentId: agent.id,
          members: {
            create: [
              { userId: owner!.id, readThroughSequence: 2 },
              { userId: member!.id },
              { userId: leaver!.id },
              { agentId: agent.id },
            ],
          },
        },
        include: { members: true },
      });
      const memberRow = (where: { userId?: string; agentId?: string }) =>
        channel.members.find((row) =>
          where.userId ? row.userId === where.userId : row.agentId === where.agentId,
        )!;
      const [ownerRow, memberMemberRow, leaverRow, agentRow] = [
        memberRow({ userId: owner!.id }),
        memberRow({ userId: member!.id }),
        memberRow({ userId: leaver!.id }),
        memberRow({ agentId: agent.id }),
      ];
      const send = (sender: string, sequence: number, threadRootId?: string) =>
        db.message.create({
          data: {
            conversationId: channel.id,
            workspaceId: workspace.id,
            senderMemberId: sender,
            body: `message ${sequence}`,
            sequence,
            threadRootId,
          },
        });
      const mention = (
        messageId: string,
        target: { id: string },
        kind: "user" | "agent",
        actorId: string,
      ) =>
        db.messageMention.create({
          data: {
            messageId,
            memberId: target.id,
            conversationId: channel.id,
            workspaceId: workspace.id,
            kind,
            actorId,
            handle: "someone",
          },
        });
      // The owner mentions the member; the leaver, before leaving, mentioned the Agent; the
      // member's message opens a thread the Agent replies in.
      const ownerMessage = await send(ownerRow.id, 1);
      await mention(ownerMessage.id, memberMemberRow, "user", member!.id);
      const threadRoot = await send(memberMemberRow.id, 2);
      const leaverMessage = await send(leaverRow.id, 3);
      await mention(leaverMessage.id, agentRow, "agent", agent.id);
      const reply = await send(agentRow.id, 4, threadRoot.id);
      await send(agentRow.id, 5);
      await db.conversationMember.update({
        where: { id: leaverRow.id },
        data: { leftAt: new Date() },
      });
      await db.threadRead.create({
        data: {
          memberId: ownerRow.id,
          rootMessageId: threadRoot.id,
          conversationId: channel.id,
          workspaceId: workspace.id,
          readThroughSequence: reply.sequence,
        },
      });
      await db.threadFollow.create({
        data: {
          memberId: ownerRow.id,
          rootMessageId: threadRoot.id,
          conversationId: channel.id,
          workspaceId: workspace.id,
        },
      });
      await db.conversationPin.create({
        data: { conversationId: channel.id, workspaceId: workspace.id, memberId: ownerRow.id },
      });

      const channels = new PublicChannels(db);
      const scores = (page: { mentionables: { handle: string; mentionScore: number }[] }) =>
        Object.fromEntries(page.mentionables.map((entry) => [entry.handle, entry.mentionScore]));

      statements.length = 0;
      const ownerPage = await channels.open(workspace.id, owner!.id, channel.id);
      const ownerStatements = [...statements];
      expect(ownerPage).toMatchObject({
        conversationId: channel.id,
        archived: false,
        coordinatorAgent: { id: agent.id, name: agent.name, displayName: agent.displayName },
        senderMemberId: ownerRow.id,
        viewerId: owner!.id,
        viewerHandle: owner!.username,
        muted: false,
        collapseLongMessages: true,
        pinned: true,
        channelCapabilities: {
          post: true,
          leave: true,
          add_member: true,
          update: true,
          archive: true,
          unarchive: true,
          remove_member: true,
          manage_roles: true,
        },
        canHideGeneral: false,
        canDelete: true,
        canCreateAgents: true,
        canStopAgents: true,
        readThroughSequence: 2,
        threadReadThrough: { [threadRoot.id]: reply.sequence },
        followedThreadRootIds: [threadRoot.id],
        hasOlder: false,
        hasNewer: false,
      });
      // The window holds the top-level messages, the thread's reply only as its summary, which the
      // owner has read.
      expect(ownerPage.messages.map((message) => message.sequence)).toEqual([1, 2, 3, 5]);
      expect(ownerPage.threads).toMatchObject({
        [threadRoot.id]: { replyCount: 1, lastReplySequence: reply.sequence, unread: 0 },
      });
      // The leaver left, so the directory holds the three active members only.
      expect(ownerPage.mentionables.map((entry) => entry.handle)).toEqual(
        [agent.name, member!.username, owner!.username].sort((a, b) => a.localeCompare(b)),
      );
      expect(scores(ownerPage)[member!.username]).toBeGreaterThan(0);
      expect(scores(ownerPage)[agent.name]).toBe(0);

      const memberPage = await channels.open(workspace.id, member!.id, channel.id);
      expect(memberPage).toMatchObject({
        senderMemberId: memberMemberRow.id,
        pinned: false,
        channelCapabilities: { ...NO_CAPABILITIES, post: true, leave: true, add_member: true },
        canDelete: false,
        canCreateAgents: false,
        canStopAgents: true,
        readThroughSequence: 0,
        threadReadThrough: {},
        followedThreadRootIds: [],
      });
      expect(Object.values(scores(memberPage))).toEqual([0, 0, 0]);
      // The member never read the thread, so the Agent's reply is unread for them.
      expect(memberPage.threads[threadRoot.id]!.unread).toBe(1);

      // Someone who left reads the channel like someone who never joined, but their own earlier
      // mentions still rank the directory.
      const leaverPage = await channels.open(workspace.id, leaver!.id, channel.id);
      expect(leaverPage).toMatchObject({
        senderMemberId: "",
        viewerId: undefined,
        viewerHandle: undefined,
        pinned: false,
        channelCapabilities: NO_CAPABILITIES,
        canStopAgents: false,
        readThroughSequence: undefined,
        threadReadThrough: {},
        followedThreadRootIds: [],
      });
      expect(scores(leaverPage)[agent.name]).toBeGreaterThan(0);
      const leaverDirectory = await channels.mentionDirectory(workspace.id, leaver!.id, channel.id);
      expect(leaverDirectory).toEqual(leaverPage.mentionables);

      const bystanderPage = await channels.open(workspace.id, bystander!.id, channel.id);
      expect(bystanderPage).toMatchObject({
        senderMemberId: "",
        channelCapabilities: NO_CAPABILITIES,
        canDelete: false,
        canCreateAgents: false,
      });
      expect(bystanderPage.messages).toHaveLength(4);
      expect(bystanderPage.threads[threadRoot.id]!.unread).toBe(0);

      await expect(channels.open(workspace.id, stranger!.id, channel.id)).rejects.toMatchObject({
        code: "ACCESS_DENIED",
      });
      await expect(
        channels.open(workspace.id, owner!.id, crypto.randomUUID()),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });

      // One read of the owner's Workspace membership and one of their member row in the channel.
      const reads = (table: string, param?: string) =>
        ownerStatements.filter(
          ({ query, params }) =>
            query.includes(`FROM "public"."${table}"`) &&
            (param === undefined || params.includes(param)),
        ).length;
      expect(reads("workspace_memberships")).toBe(1);
      expect(reads("conversation_members", owner!.id)).toBe(1);
    } finally {
      await db.workspace.delete({ where: { id: workspace.id } });
      await db.user.deleteMany({
        where: { id: { in: [owner, member, leaver, bystander, stranger].map((user) => user!.id) } },
      });
      await db.$disconnect();
    }
  },
  60_000,
);

test.skipIf(!connectionString)(
  "opening a DM returns the viewer's own read positions and who a mention can name",
  async () => {
    const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: connectionString! }) });
    const handle = crypto.randomUUID().slice(0, 8);
    const viewer = await db.user.create({ data: { username: `dm-open-${handle}` } });
    const workspace = await db.workspace.create({
      data: {
        slug: `dm-open-${handle}`,
        name: "DM open",
        members: { create: [{ userId: viewer.id, role: "owner" }] },
        agents: {
          create: {
            name: `dm-agent-${handle}`,
            displayName: "DM Agent",
            ownerId: viewer.id,
            runtimeConfig: {},
          },
        },
      },
      include: { agents: true },
    });
    const agent = workspace.agents[0]!;
    try {
      const conversations = new DirectConversations(db, { viewerChanged: async () => {} });
      const { conversationId } = await conversations.open(workspace.id, viewer.id, {
        agentId: agent.id,
      });
      const rows = await db.conversationMember.findMany({ where: { conversationId } });
      const viewerRow = rows.find((row) => row.userId === viewer.id)!;
      const agentRow = rows.find((row) => row.agentId === agent.id)!;
      const send = (sender: string, sequence: number, threadRootId?: string) =>
        db.message.create({
          data: {
            conversationId,
            workspaceId: workspace.id,
            senderMemberId: sender,
            body: `message ${sequence}`,
            sequence,
            threadRootId,
          },
        });
      const root = await send(viewerRow.id, 1);
      const reply = await send(agentRow.id, 2, root.id);
      await send(agentRow.id, 3);
      await db.conversationMember.update({
        where: { id: viewerRow.id },
        data: { readThroughSequence: 1 },
      });
      // The Agent's own thread read is never the viewer's.
      await db.threadRead.createMany({
        data: [
          { memberId: viewerRow.id, readThroughSequence: reply.sequence },
          { memberId: agentRow.id, readThroughSequence: 3 },
        ].map((read) => ({
          ...read,
          rootMessageId: root.id,
          conversationId,
          workspaceId: workspace.id,
        })),
      });

      const page = await conversations.page(workspace.id, viewer.id, conversationId);
      expect(page).toMatchObject({
        conversationId,
        senderMemberId: viewerRow.id,
        readThroughSequence: 1,
        threadReadThrough: { [root.id]: reply.sequence },
        kind: "agent",
        agent: { id: agent.id, name: agent.name, displayName: agent.displayName },
        dmWritable: true,
        viewerId: viewer.id,
        viewerHandle: viewer.username,
        hasOlder: false,
        hasNewer: false,
      });
      expect(page.messages.map((message) => message.sequence)).toEqual([1, 3]);
      expect(page.threads).toMatchObject({
        [root.id]: { replyCount: 1, lastReplySequence: reply.sequence, unread: 0 },
      });
      expect(page.mentionables.map((entry) => [entry.kind, entry.id])).toEqual(
        [
          ["agent", agent.id, agent.name],
          ["user", viewer.id, viewer.username],
        ]
          .sort((left, right) => left[2]!.localeCompare(right[2]!))
          .map(([kind, id]) => [kind, id]),
      );

      const older = await conversations.page(workspace.id, viewer.id, conversationId, {
        beforeSequence: 3,
        limit: 1,
      });
      expect(older.messages.map((message) => message.sequence)).toEqual([1]);
      expect(older.threads[root.id]!.replyCount).toBe(1);
      expect(older.hasOlder).toBe(false);
    } finally {
      await db.workspace.delete({ where: { id: workspace.id } });
      await db.user.delete({ where: { id: viewer.id } });
      await db.$disconnect();
    }
  },
  60_000,
);
