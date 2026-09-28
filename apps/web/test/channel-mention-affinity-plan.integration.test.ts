import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { PublicChannels } from "#src/server/conversations/public-channels.server";

/**
 * The composer's @-completion scores each candidate by the viewer's own recent mentions in the
 * channel. Those are read from the viewer's messages, not by walking the channel's mentions
 * newest first: a viewer who writes a lot but mentions rarely made that walk visit every mention
 * the channel's other members (usually Agents) ever wrote. Here the other member writes 50,000
 * newer mentions and the viewer 10,000 messages, of which only the oldest 5 mention anyone; each
 * read `mentionDirectory` issues runs once to record its SQL, which is then executed under
 * `EXPLAIN ANALYZE` to count the `message_mentions` rows it touched.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL, matching
 * `direct-open-thread-reads-plan.integration.test.ts`.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;

type PlanNode = {
  "Actual Rows"?: number;
  "Actual Loops"?: number;
  "Rows Removed by Filter"?: number;
  "Relation Name"?: string;
  Plans?: PlanNode[];
};

function planNodes(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(planNodes)];
}

/** Rows a plan read from a table: those an access node returned plus those its filter removed. */
function rowsTouched(node: PlanNode) {
  const loops = node["Actual Loops"] ?? 1;
  return ((node["Actual Rows"] ?? 0) + (node["Rows Removed by Filter"] ?? 0)) * loops;
}

test.skipIf(!connectionString)(
  "scoring @-completion reads the viewer's mentions without walking the channel's",
  async () => {
    const db = new PrismaClient({
      adapter: new PrismaPg({ connectionString: connectionString! }),
      log: [{ emit: "event", level: "query" }],
    });
    const reads: { query: string; params: unknown[] }[] = [];
    let recording = false;
    db.$on("query", (event) => {
      if (recording && event.query.trimStart().startsWith("SELECT"))
        reads.push({ query: event.query, params: JSON.parse(event.params) });
    });
    const handle = crypto.randomUUID().slice(0, 8);
    const viewer = await db.user.create({ data: { username: `affinity-viewer-${handle}` } });
    const talker = await db.user.create({ data: { username: `affinity-talker-${handle}` } });
    const target = await db.user.create({ data: { username: `affinity-target-${handle}` } });
    const workspace = await db.workspace.create({
      data: {
        slug: `affinity-${handle}`,
        name: "Mention affinity",
        members: {
          create: [
            { userId: viewer.id, role: "owner" },
            { userId: talker.id },
            { userId: target.id },
          ],
        },
      },
    });
    try {
      const channel = await db.conversation.create({
        data: {
          workspaceId: workspace.id,
          channelName: `affinity-${handle}`,
          members: {
            create: [viewer, talker, target].map((user) => ({ userId: user.id })),
          },
        },
        include: { members: true },
      });
      const memberOf = (userId: string) =>
        channel.members.find((member) => member.userId === userId)!.id;
      const [viewerMember, talkerMember, targetMember] = [viewer, talker, target].map((user) =>
        memberOf(user.id),
      );
      // The viewer's 10,000 messages come first; only the oldest 5 mention the target. The talker's
      // 50,000 later messages each mention the viewer.
      await db.$executeRaw`
        WITH sent AS (
          INSERT INTO messages (id, "conversationId", "workspaceId", "senderMemberId", body, sequence,
            "createdAt")
          SELECT gen_random_uuid(), ${channel.id}::uuid, ${workspace.id}::uuid,
            CASE WHEN n <= 10000 THEN ${viewerMember}::uuid ELSE ${talkerMember}::uuid END,
            'message ' || n, n, now() - interval '1 day' + n * interval '1 second'
          FROM generate_series(1, 60000) AS n
          RETURNING id, sequence, "createdAt"
        )
        INSERT INTO message_mentions ("messageId", "memberId", "conversationId", "workspaceId",
          kind, "actorId", handle, "createdAt")
        SELECT id,
          CASE WHEN sequence <= 5 THEN ${targetMember}::uuid ELSE ${viewerMember}::uuid END,
          ${channel.id}::uuid, ${workspace.id}::uuid, 'user',
          CASE WHEN sequence <= 5 THEN ${target.id}::uuid ELSE ${viewer.id}::uuid END,
          CASE WHEN sequence <= 5 THEN ${target.username} ELSE ${viewer.username} END,
          "createdAt"
        FROM sent
        WHERE sequence <= 5 OR sequence > 10000`;
      await db.$executeRaw`ANALYZE messages, message_mentions, conversation_members`;

      recording = true;
      const directory = await new PublicChannels(db).mentionDirectory(
        workspace.id,
        viewer.id,
        channel.id,
      );
      recording = false;
      const score = (userId: string) =>
        directory.find((entry) => entry.id === userId)?.mentionScore;
      expect(score(target.id)).toBeGreaterThan(0);
      expect(score(talker.id)).toBe(0);

      let touched = 0;
      for (const { query, params } of reads) {
        const [{ "QUERY PLAN": plan }] = await db.$queryRawUnsafe<
          [{ "QUERY PLAN": [{ Plan: PlanNode }] }]
        >(`EXPLAIN (ANALYZE, FORMAT JSON) ${query}`, ...params);
        for (const node of planNodes(plan[0].Plan))
          if (node["Relation Name"] === "message_mentions") touched += rowsTouched(node);
      }
      // The viewer's 5 mentions, far below the talker's 50,000.
      expect(touched).toBeLessThan(100);
    } finally {
      await db.workspace.delete({ where: { id: workspace.id } });
      await db.user.deleteMany({ where: { id: { in: [viewer.id, talker.id, target.id] } } });
      await db.$disconnect();
    }
  },
  60_000,
);
