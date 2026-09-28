import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";

/**
 * Opening a DM reads the viewer's own thread read boundaries, not the Agent's. The Agent records a
 * `thread_reads` row for every thread it drains, so a long-lived DM holds thousands of them, none
 * of which the open returns. The Agent is given 5,000 thread read rows and the viewer one; each
 * read the open issues runs once to record its SQL, which is then executed under
 * `EXPLAIN ANALYZE` to count the `thread_reads` rows it touched.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL, matching
 * `agent-thread-context-plan.integration.test.ts`.
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
  "opening a DM reads only the viewer's thread read boundaries, not the Agent's",
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
    const user = await db.user.create({ data: { username: `open-reads-${handle}` } });
    const workspace = await db.workspace.create({
      data: {
        slug: `open-reads-${handle}`,
        name: "Open reads",
        members: { create: [{ userId: user.id, role: "owner" }] },
        agents: {
          create: {
            name: `open-reads-${handle}`,
            displayName: "Reads Agent",
            ownerId: user.id,
            runtimeConfig: {},
          },
        },
      },
      include: { agents: true },
    });
    const agent = workspace.agents[0]!;
    try {
      const repo = new PrismaDirectConversationRepository(db);
      const { conversationId, senderMemberId } = await repo.memberForUser(
        workspace.id,
        user.id,
        agent.id,
      );
      const agentMember = await db.conversationMember.findFirstOrThrow({
        where: { conversationId, agentId: agent.id },
        select: { id: true },
      });
      // 5,000 top-level thread roots from the viewer; the Agent has read every thread, the viewer
      // only the newest.
      await db.$executeRaw`
        WITH roots AS (
          INSERT INTO messages (id, "conversationId", "workspaceId", "senderMemberId", body, sequence)
          SELECT gen_random_uuid(), ${conversationId}::uuid, ${workspace.id}::uuid,
            ${senderMemberId}::uuid, 'root ' || n, n
          FROM generate_series(1, 5000) AS n
          RETURNING id, sequence
        )
        INSERT INTO thread_reads ("memberId", "rootMessageId", "conversationId", "workspaceId",
          "readThroughSequence")
        SELECT ${agentMember.id}::uuid, id, ${conversationId}::uuid, ${workspace.id}::uuid,
          sequence
        FROM roots`;
      const newest = await db.message.findFirstOrThrow({
        where: { conversationId, sequence: 5000 },
        select: { id: true },
      });
      await db.threadRead.create({
        data: {
          memberId: senderMemberId,
          rootMessageId: newest.id,
          conversationId,
          workspaceId: workspace.id,
          readThroughSequence: 5000,
        },
      });
      await db.$executeRaw`ANALYZE messages, thread_reads, conversation_members`;

      recording = true;
      const opened = await repo.openForUser(workspace.id, user.id, agent.id);
      recording = false;
      expect(opened.threadReadThrough).toEqual({ [newest.id]: 5000 });
      expect(opened.messages).toHaveLength(50);

      let touched = 0;
      for (const { query, params } of reads) {
        const [{ "QUERY PLAN": plan }] = await db.$queryRawUnsafe<
          [{ "QUERY PLAN": [{ Plan: PlanNode }] }]
        >(`EXPLAIN (ANALYZE, FORMAT JSON) ${query}`, ...params);
        for (const node of planNodes(plan[0].Plan))
          if (node["Relation Name"] === "thread_reads") touched += rowsTouched(node);
      }
      // The viewer's one boundary, far below the Agent's 5,000.
      expect(touched).toBeLessThan(10);
    } finally {
      await db.workspace.delete({ where: { id: workspace.id } });
      await db.user.delete({ where: { id: user.id } });
      await db.$disconnect();
    }
  },
);
