import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";

/**
 * An Agent's send into a channel thread reads that thread's delivered replies (pending context,
 * its count, and first-touch recent context) from the thread itself, instead of walking every
 * delivery the Agent has in the whole channel and discarding the ones outside the thread. The
 * Agent is given thousands of top-level deliveries and a short thread it has never replied to, so
 * the read boundary is 0; each read runs once to record its SQL, which is then executed under
 * `EXPLAIN ANALYZE` to count the rows it touched.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL, matching
 * `owned-task-plan.integration.test.ts`.
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
  "an Agent's thread send context reads only the thread's rows, not the channel's deliveries",
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
    const user = await db.user.create({ data: { username: `thread-plan-${handle}` } });
    const workspace = await db.workspace.create({
      data: {
        slug: `thread-plan-${handle}`,
        name: "Thread plan",
        members: { create: [{ userId: user.id, role: "owner" }] },
        agents: {
          create: {
            name: `thread-plan-${handle}`,
            displayName: "Plan Agent",
            ownerId: user.id,
            runtimeConfig: {},
          },
        },
      },
      include: { agents: true },
    });
    const agent = workspace.agents[0]!;
    try {
      const channelName = `thread-plan-${handle}`;
      const channel = await db.conversation.create({
        data: {
          workspaceId: workspace.id,
          channelName,
          members: { create: [{ userId: user.id }, { agentId: agent.id }] },
        },
        include: { members: true },
      });
      const human = channel.members.find((member) => member.userId)!;
      // Messages `first..last` from the human, each delivered to the Agent; a null
      // `threadRootId` posts them at the channel's top level.
      const postDelivered = (first: number, last: number, threadRootId: string | null) =>
        db.$executeRaw`
          WITH numbered AS (
            INSERT INTO messages (id, "conversationId", "workspaceId", "senderMemberId",
              "threadRootId", body, sequence)
            SELECT gen_random_uuid(), ${channel.id}::uuid, ${workspace.id}::uuid,
              ${human.id}::uuid, ${threadRootId}::uuid, 'message ' || n, n
            FROM generate_series(${first}::int, ${last}::int) AS n
            RETURNING id, sequence
          )
          INSERT INTO agent_message_deliveries ("deliveryId", "messageId", "workspaceId",
            "conversationId", "agentId", sequence)
          SELECT gen_random_uuid(), id, ${workspace.id}::uuid, ${channel.id}::uuid,
            ${agent.id}::uuid, sequence
          FROM numbered`;
      // 20,000 top-level messages delivered to the Agent, then a thread root and 5 delivered
      // replies.
      await postDelivered(1, 20000, null);
      const root = await db.message.create({
        data: {
          conversationId: channel.id,
          workspaceId: workspace.id,
          senderMemberId: human.id,
          body: "root",
          sequence: 20001,
        },
      });
      await postDelivered(20002, 20006, root.id);
      await db.$executeRaw`ANALYZE messages, agent_message_deliveries, conversation_members`;

      const repo = new PrismaDirectConversationRepository(db);
      const target = `#${channelName}:${root.id}`;
      recording = true;
      const pending = await repo.readPendingAgentContext(workspace.id, agent.id, target);
      const count = await repo.countPendingAgentContext(workspace.id, agent.id, target);
      const recent = await repo.readRecentAgentContext(workspace.id, agent.id, target, 3);
      recording = false;
      const bodies = (rows: readonly { body: string }[]) => rows.map((row) => row.body);
      expect(bodies(pending)).toEqual(["message 20004", "message 20005", "message 20006"]);
      expect(count).toBe(5);
      expect(bodies(recent)).toEqual(["message 20004", "message 20005", "message 20006"]);

      let touched = 0;
      for (const { query, params } of reads) {
        const [{ "QUERY PLAN": plan }] = await db.$queryRawUnsafe<
          [{ "QUERY PLAN": [{ Plan: PlanNode }] }]
        >(`EXPLAIN (ANALYZE, FORMAT JSON) ${query}`, ...params);
        for (const node of planNodes(plan[0].Plan))
          if (
            node["Relation Name"] === "messages" ||
            node["Relation Name"] === "agent_message_deliveries"
          )
            touched += rowsTouched(node);
      }
      // Every read together stays within a small multiple of the thread, far below the 20,000
      // channel deliveries.
      expect(touched).toBeLessThan(200);
    } finally {
      await db.workspace.delete({ where: { id: workspace.id } });
      await db.user.delete({ where: { id: user.id } });
      await db.$disconnect();
    }
  },
);
