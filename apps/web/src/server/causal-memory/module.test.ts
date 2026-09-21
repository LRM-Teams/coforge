import { expect, test } from "bun:test";
import { CausalCitationUngroundedError, CausalMemory, CausalRuntimeRequestError } from "./module";
import type { AdmittedSegmentIngestLedger, CausalCitationRecord } from "./contract";

function ledgerRepo(ledgers: AdmittedSegmentIngestLedger[]) {
  return {
    async putPendingLedger(input: AdmittedSegmentIngestLedger) {
      const existing = ledgers.find((row) => row.operationId === input.operationId);
      if (existing) return existing;
      const row = { ...input, state: "pending" as const };
      ledgers.push(row);
      return row;
    },
    async markLedgerState(
      _workspaceId: string,
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
    async putCitation() {
      throw new Error("unused");
    },
    async getCitation() {
      return undefined;
    },
    async putProposal() {
      throw new Error("unused");
    },
    async putSupersession() {
      throw new Error("unused");
    },
    async getOffer() {
      return undefined;
    },
    async putOffer() {
      throw new Error("unused");
    },
    async isActiveChannelAgent() {
      return true;
    },
  };
}

test("a runtime outage marks the ledger temporary_failure instead of throwing", async () => {
  const ledgers: AdmittedSegmentIngestLedger[] = [];
  const memory = new CausalMemory(
    ledgerRepo(ledgers) as never,
    {
      request: async () => {
        throw new CausalRuntimeRequestError("runtime_unavailable");
      },
    },
    async () => "tok",
    "ws-a",
  );
  const result = await memory.ingestAdmittedSegment({
    workspaceId: "ws-a",
    admittedSegmentId: "seg-1",
    operationId: "op-1",
    kind: "completed_task",
    sourceMessageIds: ["m1"],
    sourcePayloadHash: "hash",
    state: "pending",
    attemptCount: 0,
    session: { workspaceId: "ws-a", channelId: "ch-1" },
    turns: [
      {
        messageId: "m1",
        sequence: 1,
        occurredAt: "2026-09-21T00:00:00.000Z",
        payloadHash: "hash",
        senderKind: "human",
        senderHandle: "ada",
        body: "deploy rolled back",
      },
    ],
  });
  expect(result.state).toBe("temporary_failure");
  expect(result.sanitizedError).toBe("runtime temporarily unavailable");
});

test("ingest audits turns before an explicit distill", async () => {
  const ledgers: AdmittedSegmentIngestLedger[] = [];
  const paths: string[] = [];
  const memory = new CausalMemory(
    ledgerRepo(ledgers) as never,
    {
      request: async <T>(path: string) => {
        paths.push(path);
        return {
          protocol: "coforge.causal.runtime.v1",
          operationId: "op-1",
          outcome: "accepted",
        } as T;
      },
    },
    async () => "tok",
    "ws-a",
  );
  const result = await memory.ingestAdmittedSegment({
    workspaceId: "ws-a",
    admittedSegmentId: "seg-1",
    operationId: "op-1",
    kind: "completed_task",
    sourceMessageIds: ["m1"],
    sourcePayloadHash: "hash",
    state: "pending",
    attemptCount: 0,
    session: { workspaceId: "ws-a", channelId: "ch-1" },
    turns: [
      {
        messageId: "m1",
        sequence: 1,
        occurredAt: "2026-09-21T00:00:00.000Z",
        payloadHash: "hash",
        senderKind: "human",
        senderHandle: "ada",
        body: "deploy rolled back",
      },
    ],
  });
  expect(paths).toEqual(["/coforge/v1/audit/turns", "/coforge/v1/segments/distill"]);
  expect(result.state).toBe("succeeded");
});

test("a forged citation cannot create an offer or a correction", async () => {
  const memory = new CausalMemory(
    ledgerRepo([]) as never,
    { request: async <T>() => ({}) as T },
    async () => "tok",
    "ws-a",
    { publish: async () => ({ messageId: "msg" }) },
  );
  await expect(
    memory.publishOffer({
      operationId: "offer-1",
      conversationId: "ch-1",
      targetAgentId: "agent-1",
      recipientRationale: "owns the rollback",
      citationRefs: ["missing"],
      body: "cited offer",
      memoryAgentId: "memory-1",
    }),
  ).rejects.toBeInstanceOf(CausalCitationUngroundedError);
  await expect(
    memory.proposeCorrection({
      operationId: "fix-1",
      causalItemId: "item-1",
      contradictoryCitationRefs: ["missing"],
      rationale: "later evidence contradicts it",
    }),
  ).rejects.toBeInstanceOf(CausalCitationUngroundedError);
});

test("a grounded offer persists recipient rationale and one public delivery", async () => {
  const citation: CausalCitationRecord = {
    workspaceId: "ws-a",
    citationId: "cite-1",
    causalItemId: "item-1",
    admittedSegmentId: "seg-1",
    sourceMessageIds: ["m1"],
    boundOperationId: "ask-1",
    displayContent: "skipped tests caused the rollback",
  };
  const published: Array<{ recipientAgentId: string; body: string }> = [];
  const memory = new CausalMemory(
    {
      ...ledgerRepo([]),
      async getCitation() {
        return citation;
      },
      async putOffer(input: never) {
        return input;
      },
    } as never,
    { request: async <T>() => ({}) as T },
    async () => "tok",
    "ws-a",
    {
      async publish(input) {
        published.push({ recipientAgentId: input.recipientAgentId, body: input.body });
        return { messageId: "offer-msg" };
      },
    },
  );
  const offer = await memory.publishOffer({
    operationId: "offer-1",
    conversationId: "ch-1",
    targetAgentId: "agent-1",
    recipientRationale: "owns the deploy task",
    citationRefs: ["cite-1"],
    body: "tests were skipped",
    memoryAgentId: "memory-1",
  });
  expect(offer.messageId).toBe("offer-msg");
  expect(offer.recipientRationale).toBe("owns the deploy task");
  expect(published).toEqual([{ recipientAgentId: "agent-1", body: "tests were skipped" }]);
});
