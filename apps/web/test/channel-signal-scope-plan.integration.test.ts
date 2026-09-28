import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { conversationSignalScopes } from "#src/server/conversations/conversation-realtime.server";

/**
 * Where a conversation's signals go is read on every Task write and action card. A channel's go to
 * the Workspace whatever its roster, so the read must not load the roster: `#general` holds every
 * member of the Workspace. The channel is given 2,000 members; each read the lookup issues runs
 * once to record its SQL, which is then executed under `EXPLAIN ANALYZE` to count the
 * `conversation_members` rows it touched. A direct message still names its human and Agent.
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
  "a channel's signal scope is read without its member roster; a DM's names its human and Agent",
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
    const user = await db.user.create({ data: { username: `signal-scope-${handle}` } });
    const workspace = await db.workspace.create({
      data: {
        slug: `signal-scope-${handle}`,
        name: "Signal scope",
        members: { create: [{ userId: user.id, role: "owner" }] },
        agents: {
          create: {
            name: `signal-scope-${handle}`,
            displayName: "Scope Agent",
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
          channelName: `general-${handle}`,
          members: { create: [{ userId: user.id }, { agentId: agent.id }] },
        },
      });
      await db.$executeRaw`
        WITH people AS (
          INSERT INTO users (id, username)
          SELECT gen_random_uuid(), ${`signal-scope-${handle}-`} || n
          FROM generate_series(1, 2000) AS n
          RETURNING id
        )
        INSERT INTO conversation_members (id, "conversationId", "workspaceId", "userId")
        SELECT gen_random_uuid(), ${channel.id}::uuid, ${workspace.id}::uuid, id FROM people`;
      const direct = await db.conversation.create({
        data: {
          workspaceId: workspace.id,
          directKey: `signal-scope-${handle}`,
          members: { create: [{ userId: user.id }, { agentId: agent.id }] },
        },
      });
      await db.$executeRaw`ANALYZE conversations, conversation_members`;

      recording = true;
      const channelScopes = await conversationSignalScopes(db, channel.id, workspace.id);
      recording = false;
      expect(channelScopes).toEqual({
        message: { workspaceId: workspace.id },
        task: { workspaceId: workspace.id },
      });

      let touched = 0;
      for (const { query, params } of reads) {
        const [{ "QUERY PLAN": plan }] = await db.$queryRawUnsafe<
          [{ "QUERY PLAN": [{ Plan: PlanNode }] }]
        >(`EXPLAIN (ANALYZE, FORMAT JSON) ${query}`, ...params);
        for (const node of planNodes(plan[0].Plan))
          if (node["Relation Name"] === "conversation_members") touched += rowsTouched(node);
      }
      // None of the channel's 2,002 member rows.
      expect(touched).toBeLessThan(10);

      expect(await conversationSignalScopes(db, direct.id, workspace.id)).toEqual({
        message: { userId: user.id, agentId: agent.id },
        task: { workspaceId: workspace.id, userId: user.id, agentId: agent.id },
      });
    } finally {
      await db.workspace.delete({ where: { id: workspace.id } });
      await db.user.deleteMany({ where: { username: { startsWith: `signal-scope-${handle}` } } });
      await db.$disconnect();
    }
  },
);
