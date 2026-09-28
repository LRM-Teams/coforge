import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { TaskBoard } from "#src/server/tasks/task-board.server";

/**
 * An Agent's `task list --mine` finds its own Tasks through an index on their owner, instead of
 * reading every Task in the Workspace with the matching statuses and discarding the ones other
 * members own. The Workspace is given far more Tasks owned by others than by the Agent, open and
 * finished; each read runs once to record its SQL, which is then planned.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL, matching
 * `unfinished-task-plan.integration.test.ts`.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;

type PlanNode = {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  "Index Cond"?: string;
  Plans?: PlanNode[];
};

function planNodes(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(planNodes)];
}

test.skipIf(!connectionString)(
  "an Agent's own Task reads range over the owner in a Task index",
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
    const user = await db.user.create({ data: { username: `owned-plan-${handle}` } });
    const workspace = await db.workspace.create({
      data: {
        slug: `owned-plan-${handle}`,
        name: "Owned plan",
        members: { create: [{ userId: user.id, role: "owner" }] },
        agents: {
          create: [
            {
              name: `owned-plan-${handle}`,
              displayName: "Plan Agent",
              ownerId: user.id,
              runtimeConfig: {},
            },
            ...Array.from({ length: 40 }, (_, index) => ({
              name: `owned-plan-other-${index}-${handle}`,
              displayName: "Other Agent",
              ownerId: user.id,
              runtimeConfig: {},
            })),
          ],
        },
      },
      include: { agents: true },
    });
    const agent = workspace.agents.find((row) => row.displayName === "Plan Agent")!;
    try {
      const channel = await db.conversation.create({
        data: {
          workspaceId: workspace.id,
          channelName: `owned-plan-${handle}`,
          members: {
            create: [{ userId: user.id }, ...workspace.agents.map((row) => ({ agentId: row.id }))],
          },
        },
        include: { members: true },
      });
      const creator = channel.members.find((member) => member.userId)!;
      const mine = channel.members.find((member) => member.agentId === agent.id)!;
      const theirs = channel.members.flatMap((member) =>
        member.agentId && member.agentId !== agent.id ? [member.id] : [],
      );
      // 4,000 Tasks spread over 40 other Agents, half open and half finished, and 4 open ones
      // owned by the Agent.
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
          CASE WHEN sequence > 4000 OR sequence % 2 = 0 THEN 'in_progress' ELSE 'done' END,
          CASE WHEN sequence > 4000 THEN ${mine.id}::uuid
            ELSE (${theirs}::uuid[])[1 + sequence % ${theirs.length}] END,
          ${creator.id}::uuid, now()
        FROM numbered`;
      await db.$executeRaw`ANALYZE tasks, conversation_members, conversations`;

      const board = new TaskBoard(db);
      for (const status of [undefined, "all"] as const) {
        const result = await board.execute(
          { workspaceId: workspace.id, agentId: agent.id },
          { idempotencyKey: crypto.randomUUID(), operation: "list", mine: true, status },
        );
        expect(result.tasks.map((task) => task.number)).toEqual([4001, 4002, 4003, 4004]);
      }
      const reads = taskReads.filter(({ query }) => query.includes('"public"."tasks"."status"'));
      expect(reads).toHaveLength(2);

      for (const { query, params } of reads) {
        const [{ "QUERY PLAN": plan }] = await db.$queryRawUnsafe<
          [{ "QUERY PLAN": [{ Plan: PlanNode }] }]
        >(`EXPLAIN (FORMAT JSON) ${query}`, ...params);
        const nodes = planNodes(plan[0].Plan);
        const taskScans = nodes.filter((node) => node["Relation Name"] === "tasks");
        expect(taskScans).toHaveLength(1);
        expect(taskScans[0]!["Node Type"]).not.toBe("Seq Scan");
        // A bitmap scan carries its index condition on the child Bitmap Index Scan.
        const taskIndexConds = nodes.flatMap((node) =>
          node["Index Name"]?.startsWith("tasks_") ? [node["Index Cond"] ?? ""] : [],
        );
        expect(taskIndexConds).toHaveLength(1);
        expect(taskIndexConds[0]).toContain("ownerMemberId");
      }
    } finally {
      await db.workspace.delete({ where: { id: workspace.id } });
      await db.user.delete({ where: { id: user.id } });
      await db.$disconnect();
    }
  },
);
