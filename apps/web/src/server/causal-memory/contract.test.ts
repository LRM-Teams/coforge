import { expect, test } from "bun:test";
import {
  ADMITTED_SEGMENT_KINDS,
  CAUSAL_ITEM_KINDS,
  CAUSAL_PROHIBITED_EVIDENCE_PATHS,
  CAUSAL_RUNTIME_ERROR_CODES,
  CAUSAL_RUNTIME_PROTOCOL,
  CAUSAL_RUNTIME_ROUTES,
  CORRECTION_VERDICTS,
  INGEST_LEDGER_STATES,
  decodeCausalAuditTurnRequest,
  decodeCausalDistillRequest,
  isCausalRuntimeError,
  isProhibitedEvidencePath,
  type CausalMemoryModule,
} from "./contract";
import { CAUSAL_MEMORY_TEST_SEAMS } from "./seams";
import { join } from "node:path";

test("pins the reviewed Causal Memory commit and refuses a floating main", async () => {
  const buildManifest = (await Bun.file(
    join(import.meta.dir, "../../../../../docs/causal-memory-build-manifest.json"),
  ).json()) as {
    implementationBase: { gitRef: string; legacyGroupMemory: string };
    upstream: { reviewedCommit: string; followMain: boolean };
    patch: { coforgeEvidencePath: string };
  };
  expect(buildManifest.implementationBase.gitRef).toBe("origin/main");
  expect(buildManifest.implementationBase.legacyGroupMemory).toBe("not-imported");
  expect(buildManifest.upstream.reviewedCommit).toBe("9657b2414ce7c56047d8273c9c0c8ebaf63985ee");
  expect(buildManifest.upstream.followMain).toBe(false);
  expect(buildManifest.patch.coforgeEvidencePath).toBe("/coforge/v1");
});

test("freezes the four implementation test seams and excludes UI", () => {
  expect(CAUSAL_MEMORY_TEST_SEAMS).toEqual([
    "extension-http",
    "web-causal-memory-module",
    "agent-local-proxy",
    "public-channel-scenario",
  ]);
});

test("freezes tenant-authenticated extension routes and health probes", () => {
  expect(CAUSAL_RUNTIME_ROUTES).toEqual({
    healthz: { method: "GET", path: "/healthz" },
    readyz: { method: "GET", path: "/readyz" },
    auditTurns: { method: "POST", path: "/coforge/v1/audit/turns" },
    distillSegment: { method: "POST", path: "/coforge/v1/segments/distill" },
    search: { method: "POST", path: "/coforge/v1/search" },
    trace: { method: "POST", path: "/coforge/v1/trace" },
    intervene: { method: "POST", path: "/coforge/v1/intervene" },
    adjudicateCorrection: { method: "POST", path: "/coforge/v1/corrections/adjudicate" },
  });
  expect(CAUSAL_PROHIBITED_EVIDENCE_PATHS).toEqual(["/debug/", "/mcp", "/"]);
  expect(isProhibitedEvidencePath("/debug/recall")).toBe(true);
  expect(isProhibitedEvidencePath("/coforge/v1/search")).toBe(false);
});

test("decodes an idempotent audit-only turn and marks it not searchable", () => {
  const request = decodeCausalAuditTurnRequest({
    protocol: CAUSAL_RUNTIME_PROTOCOL,
    operationId: "turn-msg-1",
    session: { workspaceId: "ws-a", channelId: "ch-1" },
    turn: {
      messageId: "11111111-1111-1111-1111-111111111111",
      sequence: 3,
      occurredAt: "2026-09-21T00:00:00.000Z",
      payloadHash: "sha256:abc",
      senderKind: "human",
      senderHandle: "ada",
      body: "we skipped tests and the deploy rolled back",
    },
  });
  expect(request.turn.messageId).toBe("11111111-1111-1111-1111-111111111111");
  const response = {
    protocol: CAUSAL_RUNTIME_PROTOCOL,
    operationId: request.operationId,
    outcome: "replayed" as const,
    turnId: "turn-1",
    searchable: false as const,
  };
  expect(response.searchable).toBe(false);
});

test("requires an explicit admitted-segment distill and never an implicit every-message one", () => {
  const request = decodeCausalDistillRequest({
    protocol: CAUSAL_RUNTIME_PROTOCOL,
    operationId: "distill-seg-1",
    segment: {
      admittedSegmentId: "segment-1",
      kind: "completed_task",
      sourceMessageIds: ["11111111-1111-1111-1111-111111111111"],
      sourcePayloadHash: "sha256:abc",
    },
  });
  expect(ADMITTED_SEGMENT_KINDS).toEqual(["completed_task", "quiet_window"]);
  expect(request.segment.kind).toBe("completed_task");
  expect(() =>
    decodeCausalDistillRequest({
      protocol: CAUSAL_RUNTIME_PROTOCOL,
      operationId: "distill-seg-1",
      segment: {
        admittedSegmentId: "segment-1",
        kind: "every_message",
        sourceMessageIds: ["11111111-1111-1111-1111-111111111111"],
        sourcePayloadHash: "sha256:abc",
      },
    }),
  ).toThrow("invalid admitted segment");
});

test("enumerates replay conflict, raw-not-searchable, and sanitized runtime errors", () => {
  expect(CAUSAL_RUNTIME_ERROR_CODES).toEqual([
    "unauthorized",
    "tenant_not_found",
    "replay_conflict",
    "invalid_request",
    "raw_not_searchable",
    "citation_ungrounded",
    "runtime_unavailable",
    "distill_failed_temporary",
    "correction_rejected",
  ]);
  expect(
    isCausalRuntimeError({
      protocol: CAUSAL_RUNTIME_PROTOCOL,
      operationId: "turn-msg-1",
      error: { code: "replay_conflict", message: "operation payload drifted" },
    }),
  ).toBe(true);
  expect(
    isCausalRuntimeError({
      protocol: CAUSAL_RUNTIME_PROTOCOL,
      error: { code: "sql_error", message: "/var/lib/causal.db" },
    }),
  ).toBe(false);
});

test("freezes ledger, citation, and correction DTO names for W1-C", () => {
  expect(INGEST_LEDGER_STATES).toEqual([
    "pending",
    "auditing",
    "distilling",
    "succeeded",
    "temporary_failure",
  ]);
  expect(CAUSAL_ITEM_KINDS).toEqual(["fact", "causal_edge", "intervention"]);
  expect(CORRECTION_VERDICTS).toEqual(["accept", "reject"]);
});

test("the Web module seam is four intent-level operations", () => {
  const keys: Array<keyof CausalMemoryModule> = [
    "ingestAdmittedSegment",
    "search",
    "trace",
    "intervene",
    "adjudicateCorrection",
  ];
  expect(keys).toHaveLength(5);
});
