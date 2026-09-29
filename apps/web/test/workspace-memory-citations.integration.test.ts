import { expect, test } from "bun:test";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { PrismaWorkspaceMemoryCitationStore } from "../src/server/db/repositories/workspace-memory-citation.repositories.server";
import { WorkspaceMemoryCitationKindError } from "../src/server/db/repositories/workspace-memory-errors.server";
import {
  createMemoryCitationBindings,
  MemoryCitationUngroundedError,
} from "../src/server/workspace-memory/memory-citations";
import { createMemoryOffers } from "../src/server/workspace-memory/memory-offers";
import {
  applyWorkspaceMemoryPgStub,
  warnIfWorkspaceMemoryPgSkipped,
  WORKSPACE_MEMORY_PG_URL,
} from "./helpers/workspace-memory-pg";

const connectionString = WORKSPACE_MEMORY_PG_URL;
warnIfWorkspaceMemoryPgSkipped("workspace-memory citations");

async function openHarness() {
  const pool = new Pool({ connectionString });
  const schema = `wmp_cite_${crypto.randomUUID().replaceAll("-", "")}`;
  const client = await pool.connect();
  await client.query(`CREATE SCHEMA "${schema}"`);
  await client.query(`SET search_path TO "${schema}"`);
  const workspaceA = crypto.randomUUID();
  await applyWorkspaceMemoryPgStub(client, { workspaceIds: [workspaceA] });
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }, { schema }) });
  return {
    db,
    client,
    workspaceA,
    citations: new PrismaWorkspaceMemoryCitationStore(db),
    async dispose() {
      await db.$disconnect();
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      client.release();
      await pool.end();
    },
  };
}

test.skipIf(!connectionString)(
  "PG citation store persists OpenViking hits, Offer citations, and rejects forged or unserved refs",
  async () => {
    const harness = await openHarness();
    try {
      const bindings = createMemoryCitationBindings({
        openviking: harness.citations,
      });
      const [ov] = await bindings.bindOpenVikingHits(harness.workspaceA, "find-1", [
        {
          citationId: "ov:wiki/deploy",
          workspaceId: harness.workspaceA,
          accountId: "acct-a",
          uri: "viking://resources/docs/deploy.md",
          contentHash: "sha256:abc",
          matchedLevel: "L2",
          excerpt: "skipped tests",
        },
      ]);
      expect(ov?.kind).toBe("openviking");
      expect(
        (await harness.citations.getOpenVikingCitation(harness.workspaceA, "ov:wiki/deploy"))
          ?.boundOperationId,
      ).toBe("find-1");

      const offers = createMemoryOffers({
        citations: bindings,
        offers: harness.citations,
        publisher: {
          async publish() {
            return { messageId: "offer-msg" };
          },
        },
        channels: {
          async isActiveChannelAgent() {
            return true;
          },
        },
      });

      await expect(
        offers.publish({
          workspaceId: harness.workspaceA,
          operationId: "offer-forged",
          conversationId: "conv-1",
          targetAgentId: "agent-1",
          recipientRationale: "guess",
          citationRefs: ["forged"],
          body: "no",
          memoryAgentId: "memory-1",
        }),
      ).rejects.toBeInstanceOf(MemoryCitationUngroundedError);

      const published = await offers.publish({
        workspaceId: harness.workspaceA,
        operationId: "offer-1",
        conversationId: "conv-1",
        targetAgentId: "agent-1",
        recipientRationale: "owns the task",
        citationRefs: ["ov:wiki/deploy"],
        body: "cited evidence",
        memoryAgentId: "memory-1",
      });
      expect(published.citations.map((citation) => citation.kind)).toEqual(["openviking"]);
      expect((await harness.citations.getOffer(harness.workspaceA, "offer-1"))?.citations).toEqual([
        { kind: "openviking", citationId: "ov:wiki/deploy" },
      ]);

      expect(
        harness.citations.putOffer({
          workspaceId: harness.workspaceA,
          operationId: "offer-unserved",
          conversationId: "conv-1",
          recipientAgentId: "agent-1",
          recipientRationale: "owns the task",
          messageId: "msg-2",
          citations: [{ kind: "openviking", citationId: "missing" }],
        }),
      ).rejects.toBeInstanceOf(WorkspaceMemoryCitationKindError);
    } finally {
      await harness.dispose();
    }
  },
);
