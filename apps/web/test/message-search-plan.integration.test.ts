import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "#src/generated/prisma/client";
import {
  findMessageSearchIds,
  type MessageSearchCriteria,
} from "#src/server/db/repositories/message-search.repositories.server";

/**
 * A message search with filters but no text, newest first, reads the Workspace's messages in
 * `createdAt` order from an index and stops after one page, instead of reading every message in
 * the Workspace and sorting them. The query is planned against the migrated schema with
 * sequential scans disabled, since the test database is too small for the planner to prefer an
 * index on cost alone.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL, matching
 * `agent-deletion.integration.test.ts`.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;

type PlanNode = { "Node Type": string; "Index Name"?: string; Plans?: PlanNode[] };

function planNodes(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(planNodes)];
}

test.skipIf(!connectionString)(
  "a filter-only message search reads the Workspace's messages newest first from an index",
  async () => {
    const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: connectionString! }) });
    try {
      await db.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
        // Plans the search's own query instead of running it, and keeps the plan.
        let plan: [{ Plan: PlanNode }] | undefined;
        const explain = {
          $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
            [{ "QUERY PLAN": plan }] = await tx.$queryRaw<[{ "QUERY PLAN": [{ Plan: PlanNode }] }]>`
              EXPLAIN (FORMAT JSON) ${Prisma.sql(strings, ...values)}`;
            return [];
          },
        } as unknown as PrismaClient;
        for (const filters of [
          {},
          { senderKind: "agent" as const },
          { senderId: crypto.randomUUID() },
          { mentionsViewer: true },
        ] satisfies Pick<MessageSearchCriteria, "senderId" | "senderKind" | "mentionsViewer">[]) {
          await findMessageSearchIds(explain, {
            workspaceId: crypto.randomUUID(),
            viewerUserId: crypto.randomUUID(),
            terms: [],
            query: "",
            before: new Date(),
            sort: "recent",
            limit: 20,
            offset: 40,
            ...filters,
          });
          const nodes = planNodes(plan![0].Plan);
          expect(nodes.map((node) => node["Index Name"])).toContain(
            "messages_workspaceId_createdAt_id_idx",
          );
          expect(nodes.map((node) => node["Node Type"])).not.toContain("Sort");
        }
      });
    } finally {
      await db.$disconnect();
    }
  },
);
