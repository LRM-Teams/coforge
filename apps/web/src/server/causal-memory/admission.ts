import type { AdmittedSegmentIngestLedger, AdmittedSegmentKind, CausalAuditTurn } from "./contract";
import {
  detectAdmittedPublicChannelSegments,
  ingestOperationId,
  sourcePayloadHash,
  type AdmissionConversation,
  type AdmissionMessage,
  type AdmissionTask,
} from "../workspace-memory/detect-segments";

export { ingestOperationId, sourcePayloadHash };
export type { AdmissionConversation, AdmissionMessage, AdmissionTask };

export type DetectedAdmittedSegment = {
  ledger: AdmittedSegmentIngestLedger;
  session: { workspaceId: string; channelId: string };
  turns: CausalAuditTurn[];
};

export function detectAdmittedSegments(input: {
  conversations: AdmissionConversation[];
  messages: AdmissionMessage[];
  tasks: AdmissionTask[];
  admittedMessageIds: Set<string>;
  now: Date;
  quietAfterMs: number;
}): DetectedAdmittedSegment[] {
  return detectAdmittedPublicChannelSegments(input).map((detected) => ({
    ledger: {
      workspaceId: detected.workspace.workspaceId,
      admittedSegmentId: detected.segmentId,
      operationId: ingestOperationId(detected.segmentId),
      kind: detected.kind as AdmittedSegmentKind,
      sourceMessageIds: [...detected.sourceMessageIds],
      sourcePayloadHash: detected.sourcePayloadHash,
      state: "pending",
      attemptCount: 0,
    },
    session: {
      workspaceId: detected.workspace.workspaceId,
      channelId: detected.workspace.channelId,
    },
    turns: [...detected.turns],
  }));
}
