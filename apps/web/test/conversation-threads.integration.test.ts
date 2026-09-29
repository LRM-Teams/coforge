import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { THREAD_PREVIEW_BODY_MAX } from "#src/features/conversations/thread-summary-model";
import { ConversationHistory } from "#src/server/conversations/conversation-history.server";
import { DirectConversations } from "#src/server/conversations/direct-conversations.server";
import {
  PublicChannels,
  enrollGeneralChannel,
} from "#src/server/conversations/public-channels.server";

/**
 * What a conversation window carries about its threads, from the real reads against local
 * PostgreSQL: each root's summary (never its replies), the viewer's cursors and follows for the
 * roots the page holds, and the thread read that brings the full replies when a thread opens.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;

async function setup() {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: connectionString! }) });
  const suffix = crypto.randomUUID().slice(0, 8);
  const ada = await db.user.create({ data: { username: `th-ada-${suffix}` } });
  const bob = await db.user.create({ data: { username: `th-bob-${suffix}` } });
  const cy = await db.user.create({ data: { username: `th-cy-${suffix}` } });
  const outsider = await db.user.create({ data: { username: `th-out-${suffix}` } });
  const workspace = await db.workspace.create({
    data: {
      slug: `th-${suffix}`,
      name: "Threads",
      members: {
        create: [
          { userId: ada.id, role: "owner" },
          { userId: bob.id, role: "member" },
          { userId: cy.id, role: "member" },
        ],
      },
    },
  });
  await enrollGeneralChannel(db, workspace.id);
  const agent = await db.agent.create({
    data: {
      workspaceId: workspace.id,
      ownerId: ada.id,
      name: `nova-${suffix}`,
      displayName: "Nova",
      runtimeConfig: {},
    },
  });
  const channels = new PublicChannels(db);
  const team = await channels.create(workspace.id, ada.id, `team-${suffix}`);
  await channels.join(workspace.id, bob.id, team.id);
  await db.conversationMember.create({
    data: { conversationId: team.id, workspaceId: workspace.id, agentId: agent.id },
  });
  const memberOf = (conversationId: string, who: { userId: string } | { agentId: string }) =>
    db.conversationMember.findFirstOrThrow({ where: { conversationId, ...who } });
  /** Stores a message the way a send does: top-level, or a reply when `threadRootId` is given. */
  const post = async (
    conversationId: string,
    sender: { userId: string } | { agentId: string } | "system",
    body: string,
    threadRootId?: string,
  ) => {
    const member = sender === "system" ? undefined : await memberOf(conversationId, sender);
    const latest = await db.message.findFirst({
      where: { conversationId },
      orderBy: { sequence: "desc" },
    });
    return db.message.create({
      data: {
        conversationId,
        workspaceId: workspace.id,
        senderMemberId: member?.id ?? null,
        body,
        threadRootId,
        sequence: (latest?.sequence ?? 0) + 1,
      },
    });
  };
  const teardown = async () => {
    await db.workspace.delete({ where: { id: workspace.id } }).catch(() => {});
    await db.user.deleteMany({ where: { username: { endsWith: suffix } } }).catch(() => {});
    await db.$disconnect();
  };
  return { db, workspace, ada, bob, cy, outsider, agent, channels, team, memberOf, post, teardown };
}

test.skipIf(!connectionString)(
  "a channel window carries each thread as a summary and never its replies",
  async () => {
    const { db, workspace, ada, bob, agent, channels, team, memberOf, post, teardown } =
      await setup();
    try {
      const quiet = await post(team.id, { userId: ada.id }, "root without replies");
      const busy = await post(team.id, { userId: ada.id }, "root with replies");
      const first = await post(team.id, { userId: bob.id }, "first reply", busy.id);
      const second = await post(team.id, { agentId: agent.id }, "second reply", busy.id);
      await post(team.id, "system", "Task #1 was created", busy.id);
      const third = await post(team.id, { agentId: agent.id }, "third reply", busy.id);
      const fourth = await post(team.id, { userId: ada.id }, "fourth reply", busy.id);
      const notice = await post(team.id, "system", "Task #1 was closed", busy.id);
      const newest = await post(team.id, { userId: ada.id }, "newest root");
      // A thread of notices only: no one replied, so it has nothing to preview.
      const bookkeeping = await post(team.id, { userId: ada.id }, "root with a notice");
      const onlyNotice = await post(team.id, "system", "Task #2 was created", bookkeeping.id);
      const adaMember = await memberOf(team.id, { userId: ada.id });
      // Ada has read the thread through Nova's first reply.
      await db.threadRead.create({
        data: {
          memberId: adaMember.id,
          rootMessageId: busy.id,
          conversationId: team.id,
          workspaceId: workspace.id,
          readThroughSequence: second.sequence,
        },
      });
      await db.threadFollow.createMany({
        data: [quiet.id, busy.id].map((rootMessageId) => ({
          memberId: adaMember.id,
          rootMessageId,
          conversationId: team.id,
          workspaceId: workspace.id,
        })),
      });

      const page = await channels.open(workspace.id, ada.id, team.id);

      // Only top-level messages travel with the window.
      expect(page.messages.map((message) => message.id)).toEqual([
        quiet.id,
        busy.id,
        newest.id,
        bookkeeping.id,
      ]);
      expect(page.messages.every((message) => message.threadRootId === undefined)).toBe(true);
      // A root without replies has no summary; the busy one counts people's replies only, reads
      // the newest reply of any kind as what it reflects, and shows at most the last three.
      expect(Object.keys(page.threads).sort()).toEqual([busy.id, bookkeeping.id].sort());
      expect(page.threads[bookkeeping.id]).toMatchObject({
        replyCount: 0,
        lastReplySequence: onlyNotice.sequence,
        latestReplies: [],
        unread: 0,
      });
      const summary = page.threads[busy.id]!;
      expect(summary.replyCount).toBe(4);
      expect(summary.lastReplySequence).toBe(notice.sequence);
      expect(summary.lastReplyAt).toBe(notice.createdAt.toISOString());
      expect(
        summary.latestReplies.map((reply) => [reply.id, reply.body, reply.senderName]),
      ).toEqual([
        [second.id, "second reply", "Nova"],
        [third.id, "third reply", "Nova"],
        [fourth.id, "fourth reply", expect.any(String)],
      ]);
      // Only Agent replies count as unread, and only those past Ada's cursor.
      expect(summary.unread).toBe(1);
      // The first reply's body never reaches the browser with the window.
      expect(JSON.stringify(page)).not.toContain(first.body);
      expect(page.threadReadThrough).toEqual({ [busy.id]: second.sequence });
      expect([...page.followedThreadRootIds].sort()).toEqual([busy.id, quiet.id].sort());
    } finally {
      await teardown();
    }
  },
);

test.skipIf(!connectionString)(
  "a page holds the reads and follows of its own roots, and a preview body is capped",
  async () => {
    const { db, workspace, ada, channels, team, memberOf, post, teardown } = await setup();
    try {
      const older = await post(team.id, { userId: ada.id }, "older root");
      await post(team.id, { userId: ada.id }, "older reply", older.id);
      const newer = await post(team.id, { userId: ada.id }, "newer root");
      // The cap falls inside the mention token, which is dropped whole rather than cut.
      const long = `${"a".repeat(THREAD_PREVIEW_BODY_MAX - 10)} <@agent:${crypto.randomUUID()}> tail`;
      const reply = await post(team.id, { userId: ada.id }, long, newer.id);
      const adaMember = await memberOf(team.id, { userId: ada.id });
      for (const root of [older, newer])
        await db.threadRead.create({
          data: {
            memberId: adaMember.id,
            rootMessageId: root.id,
            conversationId: team.id,
            workspaceId: workspace.id,
            readThroughSequence: 1,
          },
        });
      await db.threadFollow.create({
        data: {
          memberId: adaMember.id,
          rootMessageId: older.id,
          conversationId: team.id,
          workspaceId: workspace.id,
        },
      });

      const latest = await channels.open(workspace.id, ada.id, team.id, { limit: 1 });
      expect(latest.messages.map((message) => message.id)).toEqual([newer.id]);
      expect(Object.keys(latest.threads)).toEqual([newer.id]);
      expect(latest.threadReadThrough).toEqual({ [newer.id]: 1 });
      expect(latest.followedThreadRootIds).toEqual([]);
      // The preview is shorter than the reply, never ends inside a mention token, and is marked.
      const preview = latest.threads[newer.id]!.latestReplies[0]!;
      expect(preview.id).toBe(reply.id);
      expect(preview.body.length).toBeLessThanOrEqual(THREAD_PREVIEW_BODY_MAX + 1);
      expect(preview.body).toEndWith("…");
      expect(preview.body).not.toContain("<@");

      const earlier = await channels.open(workspace.id, ada.id, team.id, {
        limit: 1,
        beforeSequence: newer.sequence,
      });
      expect(earlier.messages.map((message) => message.id)).toEqual([older.id]);
      expect(earlier.threadReadThrough).toEqual({ [older.id]: 1 });
      expect(earlier.followedThreadRootIds).toEqual([older.id]);
    } finally {
      await teardown();
    }
  },
);

test.skipIf(!connectionString)(
  "a thread read returns every reply in order, to whoever may read the channel",
  async () => {
    const { workspace, ada, bob, outsider, agent, channels, team, post, teardown, db } =
      await setup();
    try {
      const root = await post(team.id, { userId: ada.id }, "the root");
      const other = await post(team.id, { userId: ada.id }, "another root");
      const replies = [
        await post(team.id, { userId: bob.id }, "one", root.id),
        await post(team.id, "system", "Task #1 was created", root.id),
        await post(team.id, { agentId: agent.id }, "two", root.id),
        await post(team.id, { userId: ada.id }, "three", root.id),
      ];
      const history = new ConversationHistory(db);

      const thread = await history.loadThread(workspace.id, bob.id, team.id, root.id);
      expect(thread.replies.map((reply) => reply.id)).toEqual(replies.map((reply) => reply.id));
      expect(thread.replies.every((reply) => reply.threadRootId === root.id)).toBe(true);
      // A reply is the full message shape, not a preview.
      expect(thread.replies.at(-1)).toMatchObject({ body: "three", attachments: [], mentions: [] });

      // A reply is not a thread root, and neither is a message of another conversation.
      await expect(
        history.loadThread(workspace.id, bob.id, team.id, replies[0]!.id),
      ).rejects.toThrow("NOT_FOUND");
      const general = await db.conversation.findFirstOrThrow({
        where: { workspaceId: workspace.id, channelName: "general" },
      });
      await expect(history.loadThread(workspace.id, bob.id, general.id, root.id)).rejects.toThrow(
        "NOT_FOUND",
      );
      await expect(history.loadThread(workspace.id, outsider.id, team.id, root.id)).rejects.toThrow(
        "ACCESS_DENIED",
      );

      // A member who left keeps the read-only preview: the thread reads, and nothing is unread.
      await channels.leave(workspace.id, bob.id, team.id);
      expect(
        (await history.loadThread(workspace.id, bob.id, team.id, root.id)).replies,
      ).toHaveLength(4);
      const preview = await channels.open(workspace.id, bob.id, team.id);
      expect(preview.senderMemberId).toBe("");
      expect(preview.threads[root.id]!.unread).toBe(0);
      expect(preview.messages.map((message) => message.id)).toEqual([root.id, other.id]);
    } finally {
      await teardown();
    }
  },
);

test.skipIf(!connectionString)(
  "an around read names the root of a reply, and gives someone who left the read-only preview",
  async () => {
    const { db, workspace, bob, agent, channels, team, memberOf, post, teardown } = await setup();
    try {
      const root = await post(team.id, { userId: bob.id }, "the root");
      const reply = await post(team.id, { agentId: agent.id }, "the reply", root.id);
      const bobMember = await memberOf(team.id, { userId: bob.id });
      await db.threadRead.create({
        data: {
          memberId: bobMember.id,
          rootMessageId: root.id,
          conversationId: team.id,
          workspaceId: workspace.id,
          readThroughSequence: root.sequence,
        },
      });
      await db.threadFollow.create({
        data: {
          memberId: bobMember.id,
          rootMessageId: root.id,
          conversationId: team.id,
          workspaceId: workspace.id,
        },
      });
      const history = new ConversationHistory(db);

      // A link to the reply centres the window on its root, names it, and carries what the viewer
      // has of that thread.
      const joined = await history.loadAround(workspace.id, bob.id, team.id, reply.id);
      expect(joined.anchorThreadRootId).toBe(root.id);
      expect(joined.messages.map((message) => message.id)).toEqual([root.id]);
      expect(joined.threads[root.id]).toMatchObject({ replyCount: 1, unread: 1 });
      expect(joined.threadReadThrough).toEqual({ [root.id]: root.sequence });
      expect(joined.followedThreadRootIds).toEqual([root.id]);

      // Someone who left reads the same window as the read-only preview the page gives them:
      // nothing unread, and none of the cursors or follows their old membership row kept.
      await channels.leave(workspace.id, bob.id, team.id);
      const left = await history.loadAround(workspace.id, bob.id, team.id, reply.id);
      expect(left.threads[root.id]).toMatchObject({ replyCount: 1, unread: 0 });
      expect(left.threadReadThrough).toEqual({});
      expect(left.followedThreadRootIds).toEqual([]);
    } finally {
      await teardown();
    }
  },
);

test.skipIf(!connectionString)(
  "the updates after a window read return every root past its cursor and only the replies past its reply cursor",
  async () => {
    const { db, workspace, ada, bob, agent, channels, team, post, teardown } = await setup();
    try {
      const dms = new DirectConversations(db);
      const { conversationId: dm } = await dms.open(workspace.id, ada.id, { userId: bob.id });
      for (const [conversationId, actors] of [
        [team.id, { first: { userId: ada.id }, second: { agentId: agent.id } }],
        [dm, { first: { userId: ada.id }, second: { userId: bob.id } }],
      ] as const) {
        const read = (afterSequence: number, afterReplySequence?: number) =>
          conversationId === dm
            ? dms.updates(workspace.id, ada.id, dm, afterSequence, afterReplySequence)
            : channels.updates(workspace.id, ada.id, team.id, afterSequence, afterReplySequence);
        const root = await post(conversationId, actors.first, "root");
        const reflected = await post(
          conversationId,
          actors.second,
          "a reply the window holds",
          root.id,
        );
        const laterRoot = await post(
          conversationId,
          actors.first,
          "a root after the window's newest",
        );
        const laterReply = await post(
          conversationId,
          actors.second,
          "a reply after the window",
          root.id,
        );
        const ids = async (afterSequence: number, afterReplySequence?: number) =>
          (await read(afterSequence, afterReplySequence)).map((message) => message.id);

        // Without a reply cursor everything after the cursor comes back, as it always has.
        expect(await ids(root.sequence)).toEqual([reflected.id, laterRoot.id, laterReply.id]);
        // With one, a reply the window already reflects is not read again.
        expect(await ids(root.sequence, reflected.sequence)).toEqual([laterRoot.id, laterReply.id]);
        // A root past its own cursor is never skipped, whatever replies came after it: the reply
        // cursor only ever spares replies.
        expect(await ids(root.sequence, laterReply.sequence)).toEqual([laterRoot.id]);
      }
    } finally {
      await teardown();
    }
  },
);

test.skipIf(!connectionString)(
  "a direct conversation carries the same summaries, and its thread reads only for its people",
  async () => {
    const { workspace, ada, bob, cy, outsider, agent, post, teardown, db } = await setup();
    try {
      const dms = new DirectConversations(db);
      const { conversationId: people } = await dms.open(workspace.id, ada.id, { userId: bob.id });
      const { conversationId: withAgent } = await dms.open(workspace.id, ada.id, {
        agentId: agent.id,
      });
      const root = await post(people, { userId: ada.id }, "hello Bob");
      const reply = await post(people, { userId: bob.id }, "hello Ada", root.id);
      const agentRoot = await post(withAgent, { userId: ada.id }, "hello Nova");
      const agentReply = await post(withAgent, { agentId: agent.id }, "hello Ada", agentRoot.id);

      const peoplePage = await dms.page(workspace.id, ada.id, people);
      expect(peoplePage.messages.map((message) => message.id)).toEqual([root.id]);
      expect(peoplePage.threads[root.id]).toMatchObject({
        replyCount: 1,
        lastReplySequence: reply.sequence,
        unread: 0,
      });
      expect(peoplePage.threads[root.id]!.latestReplies.map((preview) => preview.id)).toEqual([
        reply.id,
      ]);

      const agentPage = await dms.page(workspace.id, ada.id, withAgent);
      expect(agentPage.messages.map((message) => message.id)).toEqual([agentRoot.id]);
      // Nova's reply has not been read.
      expect(agentPage.threads[agentRoot.id]).toMatchObject({
        replyCount: 1,
        lastReplySequence: agentReply.sequence,
        unread: 1,
      });
      await dms.markThreadRead(workspace.id, ada.id, withAgent, agentRoot.id, agentReply.sequence);
      const read = await dms.page(workspace.id, ada.id, withAgent);
      expect(read.threads[agentRoot.id]!.unread).toBe(0);
      expect(read.threadReadThrough).toEqual({ [agentRoot.id]: agentReply.sequence });

      const history = new ConversationHistory(db);
      const thread = await history.loadThread(workspace.id, bob.id, people, root.id);
      expect(thread.replies.map((message) => message.id)).toEqual([reply.id]);
      // The same shape a direct conversation's window and updates give a message.
      expect("senderMemberId" in thread.replies[0]!).toBe(false);
      // A member outside the DM, and someone outside the Workspace, read nothing.
      await expect(history.loadThread(workspace.id, cy.id, people, root.id)).rejects.toThrow(
        "ACCESS_DENIED",
      );
      await expect(history.loadThread(workspace.id, outsider.id, people, root.id)).rejects.toThrow(
        "ACCESS_DENIED",
      );
      await expect(
        history.loadThread(workspace.id, cy.id, withAgent, agentRoot.id),
      ).rejects.toThrow("ACCESS_DENIED");
    } finally {
      await teardown();
    }
  },
);
