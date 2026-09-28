import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { searchMessages } from "#src/server/conversations/message-search.server";

/**
 * Workspace message search as a signed-in human sees it: every public channel (joined or not,
 * archived included) and only their own direct conversations, never another Workspace. Terms
 * match case-insensitive substrings, Chinese included, all terms required; `%` and `_` are
 * literal. Filters narrow by sender, sender kind, mentions of the viewer, conversation, and time;
 * paging is offset + `hasMore`.
 */
test("searches the messages a human may read, with filters, sorting and paging", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString)
    throw new Error("CHANNEL_TEST_DATABASE_URL must point to local PostgreSQL");

  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const suffix = crypto.randomUUID();
  const slugs = [`search-${suffix}`, `search-other-${suffix}`];
  const usernames = ["alice", "bob", "outsider"].map((name) => `search-${name}-${suffix}`);
  try {
    const [alice, bob, outsider] = await Promise.all(
      usernames.map((username, index) =>
        db.user.create({ data: { username, displayName: ["Alice", "Bob", "Out"][index] } }),
      ),
    );
    const [workspace, otherWorkspace] = await Promise.all(
      slugs.map((slug) => db.workspace.create({ data: { slug, name: "Search" } })),
    );
    const workspaceId = workspace!.id;
    await db.workspaceMembership.createMany({
      data: [alice!, bob!].map((user) => ({ workspaceId, userId: user.id, role: "member" })),
    });
    const agent = await db.agent.create({
      data: {
        workspaceId,
        ownerId: alice!.id,
        name: `builder-${suffix.slice(0, 8)}`,
        displayName: "Builder",
        runtimeConfig: {},
      },
    });

    const conversation = (data: { channelName?: string; directKey?: string; archived?: boolean }) =>
      db.conversation.create({
        data: {
          workspaceId,
          channelName: data.channelName,
          directKey: data.directKey,
          archivedAt: data.archived ? new Date() : undefined,
        },
      });
    const general = await conversation({ channelName: "general" });
    const unjoined = await conversation({ channelName: "ops" });
    const archived = await conversation({ channelName: "old", archived: true });
    const aliceDm = await conversation({ directKey: `agent:${agent.id}|user:${alice!.id}` });
    const bobDm = await conversation({ directKey: `agent:${agent.id}|user:${bob!.id}` });
    const foreign = await db.conversation.create({
      data: { workspaceId: otherWorkspace!.id, channelName: "general" },
    });

    const member = (
      conversationId: string,
      who: { userId?: string; agentId?: string },
      ws = workspaceId,
    ) => db.conversationMember.create({ data: { conversationId, workspaceId: ws, ...who } });
    const aliceInGeneral = await member(general.id, { userId: alice!.id });
    const agentInGeneral = await member(general.id, { agentId: agent.id });
    const bobInOps = await member(unjoined.id, { userId: bob!.id });
    const bobInOld = await member(archived.id, { userId: bob!.id });
    const aliceInDm = await member(aliceDm.id, { userId: alice!.id });
    const agentInAliceDm = await member(aliceDm.id, { agentId: agent.id });
    await member(bobDm.id, { userId: bob!.id });
    const agentInBobDm = await member(bobDm.id, { agentId: agent.id });
    const foreignMember = await member(foreign.id, { userId: outsider!.id }, otherWorkspace!.id);

    const sequences = new Map<string, number>();
    const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);
    const post = async (
      conversationId: string,
      senderMemberId: string | null,
      body: string,
      options: { minutesAgo: number; threadRootId?: string; ws?: string },
    ) => {
      const sequence = (sequences.get(conversationId) ?? 0) + 1;
      sequences.set(conversationId, sequence);
      return db.message.create({
        data: {
          conversationId,
          workspaceId: options.ws ?? workspaceId,
          senderMemberId,
          body,
          sequence,
          threadRootId: options.threadRootId,
          createdAt: minutesAgo(options.minutesAgo),
        },
      });
    };

    const exact = await post(general.id, aliceInGeneral.id, "部署发版 staging today", {
      minutesAgo: 50,
    });
    const scattered = await post(
      general.id,
      agentInGeneral.id,
      "部署 the new build, then wait for the long queue to drain before staging",
      { minutesAgo: 40 },
    );
    const reply = await post(general.id, agentInGeneral.id, "Deploy finished: 部署发版 OK", {
      minutesAgo: 30,
      threadRootId: exact.id,
    });
    const inUnjoined = await post(unjoined.id, bobInOps.id, "ops 部署发版 checklist", {
      minutesAgo: 20,
    });
    const inArchived = await post(archived.id, bobInOld.id, "old 部署发版 notes", {
      minutesAgo: 10,
    });
    const inOwnDm = await post(aliceDm.id, agentInAliceDm.id, "your 部署发版 is ready", {
      minutesAgo: 5,
    });
    await post(bobDm.id, agentInBobDm.id, "bob's private 部署发版", { minutesAgo: 4 });
    await post(general.id, null, "system notice about 部署发版", { minutesAgo: 3 });
    await post(foreign.id, foreignMember.id, "foreign 部署发版", {
      minutesAgo: 2,
      ws: otherWorkspace!.id,
    });
    const percent = await post(aliceDm.id, aliceInDm.id, "coverage is 100% now", {
      minutesAgo: 60,
    });
    await post(aliceDm.id, aliceInDm.id, "coverage is 1000 lines", { minutesAgo: 61 });
    const mentioned = await post(general.id, agentInGeneral.id, `<@human:${alice!.id}> 部署 done`, {
      minutesAgo: 70,
    });
    await db.messageMention.create({
      data: {
        messageId: mentioned.id,
        memberId: aliceInGeneral.id,
        conversationId: general.id,
        workspaceId,
        kind: "user",
        actorId: alice!.id,
        handle: alice!.username,
      },
    });

    const search = (input: Partial<Parameters<typeof searchMessages>[1]>) =>
      searchMessages(db, {
        workspaceId,
        userId: alice!.id,
        sort: "recent",
        limit: 20,
        offset: 0,
        ...input,
      });
    const ids = async (input: Partial<Parameters<typeof searchMessages>[1]>) =>
      (await search(input)).results.map((hit) => hit.message.id);

    // Every readable place, newest first: joined, unjoined and archived channels, the viewer's
    // own DM and thread replies. Bob's DM, the system row and the other Workspace never appear.
    expect(await ids({ query: "部署发版" })).toEqual([
      inOwnDm.id,
      inArchived.id,
      inUnjoined.id,
      reply.id,
      exact.id,
    ]);

    // Each hit carries its place: the channel name and archived state, or the DM's Agent.
    const hits = (await search({ query: "部署发版" })).results;
    expect(hits[0]!.conversation).toMatchObject({
      id: aliceDm.id,
      channelName: null,
      archived: false,
    });
    expect(hits[0]!.conversation.directAgent).toMatchObject({ id: agent.id });
    expect(hits[1]!.conversation).toMatchObject({ channelName: "old", archived: true });
    expect(hits[3]!.message.threadRootId).toBe(exact.id);
    expect(hits[4]!.message.senderName).toBe("Alice");

    // Case-insensitive, all terms required, and `%` is literal.
    expect(await ids({ query: "DEPLOY" })).toEqual([reply.id]);
    expect(await ids({ query: "部署 staging" })).toEqual([scattered.id, exact.id]);
    expect(await ids({ query: "100%" })).toEqual([percent.id]);

    // Relevance puts the closest match first, even when it is older.
    expect(await ids({ query: "部署发版 staging", sort: "relevance" })).toEqual([exact.id]);
    expect(await ids({ query: "部署 staging", sort: "relevance" })).toEqual([
      exact.id,
      scattered.id,
    ]);

    // Filters work with or without a query.
    expect(await ids({ query: "部署", senderId: agent.id })).toEqual([
      inOwnDm.id,
      reply.id,
      scattered.id,
      mentioned.id,
    ]);
    expect(await ids({ query: "部署", senderKind: "user" })).toEqual([
      inArchived.id,
      inUnjoined.id,
      exact.id,
    ]);
    expect(await ids({ mentionsViewer: true })).toEqual([mentioned.id]);
    expect(await ids({ query: "部署", conversationId: unjoined.id })).toEqual([inUnjoined.id]);
    expect(await ids({ query: "部署发版", after: minutesAgo(35), before: minutesAgo(8) })).toEqual([
      inArchived.id,
      inUnjoined.id,
      reply.id,
    ]);
    // Bob's DM stays hidden even when asked for by id.
    expect(await ids({ conversationId: bobDm.id })).toEqual([]);

    // Offset paging reports whether another page exists.
    const first = await search({ query: "部署发版", limit: 2 });
    expect(first.results.map((hit) => hit.message.id)).toEqual([inOwnDm.id, inArchived.id]);
    expect(first.hasMore).toBe(true);
    const last = await search({ query: "部署发版", limit: 2, offset: 4 });
    expect(last.results.map((hit) => hit.message.id)).toEqual([exact.id]);
    expect(last.hasMore).toBe(false);

    // A page reports the server's moment it searched at; passing it back as `before` keeps later
    // pages to that moment, so a message posted while paging never shifts the offsets.
    const pinned = await search({ query: "部署发版", limit: 2 });
    const late = await post(general.id, aliceInGeneral.id, "late 部署发版", { minutesAgo: 0 });
    expect(pinned.searchedAt).toBeInstanceOf(Date);
    expect(
      (await search({ query: "部署发版", limit: 2, before: pinned.searchedAt })).results.map(
        (hit) => hit.message.id,
      ),
    ).toEqual([inOwnDm.id, inArchived.id]);
    expect((await ids({ query: "部署发版" }))[0]).toBe(late.id);

    // Someone outside the Workspace cannot search it.
    await expect(
      searchMessages(db, {
        workspaceId,
        userId: outsider!.id,
        query: "部署",
        sort: "recent",
        limit: 20,
        offset: 0,
      }),
    ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  } finally {
    // Workspace deletion cascades conversations, members, messages and mentions with them.
    await db.workspace.deleteMany({ where: { slug: { in: slugs } } });
    await db.user.deleteMany({ where: { username: { in: usernames } } });
    await db.$disconnect();
  }
});
