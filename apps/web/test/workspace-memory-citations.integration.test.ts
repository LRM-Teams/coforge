import { expect, test } from "bun:test";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/client";
import { PrismaWorkspaceMemoryCitationStore } from "../src/server/db/repositories/workspace-memory-citation.repositories.server";
import { WorkspaceMemoryCitationKindError } from "../src/server/db/repositories/workspace-memory-errors.server";
import {
  createInMemoryCausalMemoryCitationBindings,
  createMemoryCitationBindings,
  MemoryCitationCorrectionError,
  MemoryCitationUngroundedError,
} from "../src/server/causal-memory/memory-citations";
import { createMemoryOffers } from "../src/server/causal-memory/memory-offers";
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
  "PG citation store persists OpenViking hits, mixed Offer kinds, and rejects forged or OV correction",
  async () => {
    const harness = await openHarness();
    try {
      const causal = createInMemoryCausalMemoryCitationBindings();
      const bindings = createMemoryCitationBindings({
        openviking: harness.citations,
        causal,
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

      await bindings.bindCausalHits(harness.workspaceA, "search-1", [
        {
          citationId: "cm:decision-1",
          causalItemId: "decision-1",
          factVersion: 3,
          admittedSegmentId: "segment-1",
          sourceMessageIds: ["11111111-1111-1111-1111-111111111111"],
          displayContent: "skipping tests caused a rollback",
        },
      ]);
      await harness.client.query(
        `INSERT INTO "causal_citation_records" ("id", "workspace_id", "citation_id") VALUES ($1, $2, 'cm:decision-1')`,
        [crypto.randomUUID(), harness.workspaceA],
      );

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
        corrections: {
          async propose(input) {
            return { accepted: true, duplicate: false, proposalId: input.operationId };
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

      const mixed = await offers.publish({
        workspaceId: harness.workspaceA,
        operationId: "offer-1",
        conversationId: "conv-1",
        targetAgentId: "agent-1",
        recipientRationale: "owns the task",
        citationRefs: ["ov:wiki/deploy", "cm:decision-1"],
        body: "mixed evidence",
        memoryAgentId: "memory-1",
      });
      expect(mixed.citations.map((citation) => citation.kind)).toEqual([
        "openviking",
        "causal_memory",
      ]);
      expect((await harness.citations.getOffer(harness.workspaceA, "offer-1"))?.citations).toEqual([
        { kind: "causal_memory", citationId: "cm:decision-1" },
        { kind: "openviking", citationId: "ov:wiki/deploy" },
      ]);

      await expect(
        offers.proposeCorrection({
          workspaceId: harness.workspaceA,
          operationId: "fix-ov",
          causalItemId: "decision-1",
          contradictoryCitationRefs: ["ov:wiki/deploy"],
          rationale: "OV is not admitted provenance",
        }),
      ).rejects.toBeInstanceOf(MemoryCitationCorrectionError);

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
