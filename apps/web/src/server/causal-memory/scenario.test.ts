import { expect, test } from "bun:test";
import { decodeCausalAgentCommand } from "@lrm/coforge-sdk/agent";
import { CausalCitationUngroundedError, CausalMemory, CausalRuntimeRequestError } from "./module";
import { detectAdmittedSegments } from "./admission";
import type {
  AdmittedSegmentIngestLedger,
  CausalAdjudicateResponse,
  CausalCitationRecord,
  CausalOfferRecord,
  CausalReadResponse,
  CausalRuntimeCitation,
} from "./contract";

test("deterministic group-chat scenario: isolation, grounded offer, correction, non-blocking outage, retry", async () => {
  const tenants = new Map<string, CausalRuntimeCitation[]>();
  const ledgers: AdmittedSegmentIngestLedger[] = [];
  const citations = new Map<string, CausalCitationRecord>();
  const offers: CausalOfferRecord[] = [];
  const supersessions: Array<{ verdict: string; superseded: boolean; auditId: string }> = [];
  let runtimeUp = true;
  const published: string[] = [];

  const repository = {
    async putPendingLedger(input: AdmittedSegmentIngestLedger) {
      const existing = ledgers.find((row) => row.operationId === input.operationId);
      if (existing) return existing;
      const row = { ...input, state: "pending" as const };
      ledgers.push(row);
      return row;
    },
    async markLedgerState(
      _w: string,
      operationId: string,
      state: AdmittedSegmentIngestLedger["state"],
      sanitizedError?: string,
    ) {
      const row = ledgers.find((ledger) => ledger.operationId === operationId)!;
      row.state = state;
      row.sanitizedError = sanitizedError;
      if (state === "temporary_failure") row.attemptCount += 1;
      return row;
    },
    async putCitation(input: CausalCitationRecord) {
      citations.set(`${input.workspaceId}:${input.citationId}`, input);
      return input;
    },
    async getCitation(workspaceId: string, citationId: string) {
      return citations.get(`${workspaceId}:${citationId}`);
    },
    async putProposal(input: { proposalId: string }) {
      return input;
    },
    async putSupersession(input: { verdict: string; superseded: boolean; auditId: string }) {
      supersessions.push(input);
      return input;
    },
    async getOffer() {
      return undefined;
    },
    async putOffer(input: CausalOfferRecord) {
      offers.push(input);
      return input;
    },
    async isActiveChannelAgent() {
      return true;
    },
  };

  const runtime = {
    async request<T>(path: string, _operationId: string, token: string, body: unknown): Promise<T> {
      if (!runtimeUp) throw new CausalRuntimeRequestError("runtime_unavailable");
      const items = tenants.get(token) ?? [];
      if (path.endsWith("/audit/turns")) {
        return {
          protocol: "coforge.causal.runtime.v1",
          operationId: "op",
          outcome: "accepted",
          searchable: false,
        } as T;
      }
      if (path.endsWith("/segments/distill")) {
        const segment = (
          body as { segment: { admittedSegmentId: string; sourceMessageIds: string[] } }
        ).segment;
        const item: CausalRuntimeCitation = {
          citationId: `item:${token}`,
          causalItemId: token,
          admittedSegmentId: segment.admittedSegmentId,
          sourceMessageIds: segment.sourceMessageIds,
          displayContent: "workspace-local lesson",
          itemKind: "causal_edge",
        };
        tenants.set(token, [item]);
        return {
          protocol: "coforge.causal.runtime.v1",
          operationId: "op",
          outcome: "distilled",
          items: [item],
        } as T;
      }
      if (path.endsWith("/corrections/adjudicate")) {
        const response: CausalAdjudicateResponse = {
          protocol: "coforge.causal.runtime.v1",
          operationId: "fix-1",
          verdict: "accept",
          superseded: true,
          auditId: "audit-1",
        };
        return response as T;
      }
      return {
        protocol: "coforge.causal.runtime.v1",
        operationId: "op",
        duplicate: false,
        items,
      } as T;
    },
  };

  const memoryA = new CausalMemory(repository as never, runtime, async () => "tenant-a", "ws-a", {
    async publish(input) {
      published.push(input.body);
      return { messageId: "offer-a" };
    },
  });
  const memoryB = new CausalMemory(repository as never, runtime, async () => "tenant-b", "ws-b");

  const discussion = {
    id: "msg-a",
    conversationId: "ch-a",
    workspaceId: "ws-a",
    sequence: 1,
    createdAt: new Date("2026-09-21T10:00:00.000Z"),
    body: "MARKER-ROLLBACK skipped tests and the deploy rolled back",
    senderKind: "human" as const,
    senderHandle: "ada",
  };
  const unrelated = {
    ...discussion,
    id: "msg-unrelated",
    conversationId: "ch-a",
    sequence: 2,
    createdAt: new Date("2026-09-21T11:50:00.000Z"),
    body: "lunch plans",
  };
  const detected = detectAdmittedSegments({
    conversations: [{ id: "ch-a", workspaceId: "ws-a", channelName: "eng" }],
    messages: [discussion, unrelated],
    tasks: [
      {
        messageId: "msg-a",
        conversationId: "ch-a",
        workspaceId: "ws-a",
        status: "done",
        updatedAt: new Date("2026-09-21T10:05:00.000Z"),
      },
    ],
    admittedMessageIds: new Set(),
    now: new Date("2026-09-21T11:51:00.000Z"),
    quietAfterMs: 15 * 60 * 1000,
  });
  expect(detected).toHaveLength(1);
  expect(detected[0]?.ledger.kind).toBe("completed_task");

  runtimeUp = false;
  const failed = await memoryA.ingestAdmittedSegment({
    ...detected[0]!.ledger,
    session: detected[0]!.session,
    turns: detected[0]!.turns,
  });
  expect(failed.state).toBe("temporary_failure");
  expect(published).toEqual([]);

  runtimeUp = true;
  const ingested = await memoryA.ingestAdmittedSegment({
    ...detected[0]!.ledger,
    operationId: "ingest-a-retry",
    session: detected[0]!.session,
    turns: detected[0]!.turns,
  });
  expect(ingested.state).toBe("succeeded");

  const asked = decodeCausalAgentCommand({
    protocol: "coforge.causal.agent.v1",
    op: "search",
    operationId: "ask-memory",
    query: "@memory why did deploy roll back",
  });
  const found = (await memoryA.search({
    protocol: "coforge.causal.runtime.v1",
    operationId: asked.operationId,
    query: asked.op === "search" ? asked.query : "",
  })) as CausalReadResponse;
  expect(found.items[0]?.sourceMessageIds).toEqual(["msg-a"]);
  expect(found.items[0]?.admittedSegmentId).toBe(detected[0]?.ledger.admittedSegmentId);

  const offer = await memoryA.publishOffer({
    operationId: "offer-1",
    conversationId: "ch-a",
    targetAgentId: "helper-a",
    recipientRationale: "owns the deploy task",
    citationRefs: [found.items[0]!.citationId],
    body: "the rollback followed skipped tests",
    memoryAgentId: "memory-a",
  });
  expect(offer.messageId).toBe("offer-a");
  expect(offers).toHaveLength(1);
  expect(published).toEqual(["the rollback followed skipped tests"]);

  await expect(
    memoryA.publishOffer({
      operationId: "offer-forged",
      conversationId: "ch-a",
      targetAgentId: "helper-a",
      recipientRationale: "guess",
      citationRefs: ["forged"],
      body: "no",
      memoryAgentId: "memory-a",
    }),
  ).rejects.toBeInstanceOf(CausalCitationUngroundedError);

  const isolated = await memoryB.search({
    protocol: "coforge.causal.runtime.v1",
    operationId: "ask-b",
    query: "deploy",
  });
  expect(isolated.items).toEqual([]);

  const correction = await memoryA.proposeCorrection({
    operationId: "fix-1",
    causalItemId: found.items[0]!.causalItemId,
    contradictoryCitationRefs: [found.items[0]!.citationId],
    rationale: "later admitted evidence says tests were not skipped",
  });
  expect(correction.accepted).toBe(true);
  expect(supersessions[0]).toMatchObject({
    workspaceId: "ws-a",
    proposalId: "fix-1",
    verdict: "accept",
    superseded: true,
    auditId: "audit-1",
  });
});
