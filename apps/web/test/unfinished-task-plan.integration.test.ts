import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { TaskBoard } from "#src/server/tasks/task-board.server";

/**
 * The reads of unfinished Tasks (the Tasks page overview and an Agent's `task list --mine`) find
 * them as an index range over their statuses, instead of reading every Task the Workspace ever
 * finished and discarding it. A Workspace is given a finished history far larger than its open
 * work, as it has once in use; each read runs once to record its SQL, which is then planned.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL, matching
 * `message-search-plan.integration.test.ts`.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;

type PlanNode = {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Cond"?: string;
  Plans?: PlanNode[];
};

function planNodes(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(planNodes)];
}

test.skipIf(!connectionString)(
  "the unfinished Task reads range over the open statuses in a Task index",
  async () => {
    const db = new PrismaClient({
      adapter: new PrismaPg({ connectionString: connectionString! }),
      log: [{ emit: "event", level: "query" }],
    });
    const taskReads: { query: string; params: unknown[] }[] = [];
    db.$on("query", (event) => {
      if (event.query.includes('FROM "public"."tasks"'))
        taskReads.push({ query: event.query, params: JSON.parse(event.params) });
    });
    const handle = crypto.randomUUID().slice(0, 8);
    const user = await db.user.create({ data: { username: `unfinished-plan-${handle}` } });
    const workspace = await db.workspace.create({
      data: {
        slug: `unfinished-plan-${handle}`,
        name: "Unfinished plan",
        members: { create: [{ userId: user.id, role: "owner" }] },
        agents: {
          create: {
            name: `unfinished-plan-${handle}`,
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
      const channel = await db.conversation.create({
        data: {
          workspaceId: workspace.id,
          channelName: `unfinished-plan-${handle}`,
          members: { create: [{ userId: user.id }, { agentId: agent.id }] },
        },
        include: { members: true },
      });
      const creator = channel.members.find((member) => member.userId)!;
      const owner = channel.members.find((member) => member.agentId)!;
      // 4,000 finished Tasks and 4 open ones, all owned by the Agent.
      await db.$executeRaw`
        WITH numbered AS (
          INSERT INTO messages (id, "conversationId", "workspaceId", body, sequence)
          SELECT gen_random_uuid(), ${channel.id}::uuid, ${workspace.id}::uuid, 'task', n
          FROM generate_series(1, 4004) AS n
          RETURNING id, sequence
        )
        INSERT INTO tasks ("messageId", "conversationId", "workspaceId", number, title, status,
          "ownerMemberId", "creatorMemberId", "updatedAt")
        SELECT id, ${channel.id}::uuid, ${workspace.id}::uuid, sequence, 'task',
          CASE WHEN sequence > 4000 THEN 'in_progress' WHEN sequence % 2 = 0 THEN 'done' ELSE 'closed' END,
          ${owner.id}::uuid, ${creator.id}::uuid, now()
        FROM numbered`;
      await db.$executeRaw`ANALYZE tasks`;

      const board = new TaskBoard(db);
      expect((await board.overview(workspace.id, user.id)).tasks).toHaveLength(4);
      const mine = await board.execute(
        { workspaceId: workspace.id, agentId: agent.id },
        { idempotencyKey: crypto.randomUUID(), operation: "list", mine: true },
      );
      expect(mine.tasks).toHaveLength(4);
      const reads = taskReads.filter(({ query }) => query.includes('"public"."tasks"."status"'));
      expect(reads).toHaveLength(2);

      for (const { query, params } of reads) {
        const [{ "QUERY PLAN": plan }] = await db.$queryRawUnsafe<
          [{ "QUERY PLAN": [{ Plan: PlanNode }] }]
        >(`EXPLAIN (FORMAT JSON) ${query}`, ...params);
        const taskScans = planNodes(plan[0].Plan).filter(
          (node) => node["Relation Name"] === "tasks",
        );
        expect(taskScans).toHaveLength(1);
        expect(taskScans[0]!["Index Cond"]).toContain("status = ANY");
      }
    } finally {
      await db.workspace.delete({ where: { id: workspace.id } });
      await db.user.delete({ where: { id: user.id } });
      await db.$disconnect();
    }
  },
);
