import type {
  OpenVikingAdmittedSessionWrite,
  OpenVikingTypedSessionExtract,
} from "../openviking/typed-session-extract.server";
import type { AdmissionSink, AdmissionSinkDelivery, AdmissionSinkResult } from "./dispatch";

export const OPENVIKING_ADMITTED_SESSION_ID_PREFIX = "coforge-";

const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

export type OpenVikingAdmittedSessionLineage = {
  segmentId: string;
  sourceMessageIds: readonly string[];
  workspaceId: string;
  channelId: string;
  kind: string;
  conversationKind: "public_channel";
  sourcePayloadHash: string;
};

export function derivedOfferContent(body: string): string {
  const head: string[] = [];
  for (const line of body.split("\n")) {
    if (line.includes("viking://")) break;
    head.push(line);
  }
  const conclusion = head.join("\n").trim();
  if (conclusion.length > 0 && !conclusion.includes("viking://")) return conclusion;
  return "[memory offer — 结论:无独立结论;引用内容不入库]";
}

export function openVikingSessionIdForSegment(segmentId: string): string {
  return `${OPENVIKING_ADMITTED_SESSION_ID_PREFIX}${segmentId}`;
}

export function admittedSessionLineageFromDelivery(
  delivery: AdmissionSinkDelivery,
): OpenVikingAdmittedSessionLineage {
  return {
    segmentId: delivery.segment.segmentId,
    sourceMessageIds: [...delivery.segment.sourceMessageIds],
    workspaceId: delivery.segment.workspace.workspaceId,
    channelId: delivery.segment.workspace.channelId,
    kind: delivery.segment.kind,
    conversationKind: delivery.segment.conversationKind,
    sourcePayloadHash: delivery.segment.sourcePayloadHash,
  };
}

export function admittedSessionWriteFromDelivery(
  delivery: AdmissionSinkDelivery,
): OpenVikingAdmittedSessionWrite {
  const lineage = admittedSessionLineageFromDelivery(delivery);
  const tags = [
    `coforge_segment=${lineage.segmentId}`,
    `coforge_workspace=${lineage.workspaceId}`,
    `coforge_channel=${lineage.channelId}`,
    `coforge_kind=${lineage.kind}`,
    `coforge_source_message_ids=${lineage.sourceMessageIds.join(",")}`,
  ];
  return {
    sessionId: openVikingSessionIdForSegment(lineage.segmentId),
    workspaceId: lineage.workspaceId,
    tags,
    messages: delivery.turns.map((turn) => {
      const derived = delivery.offerMessageIds?.has(turn.messageId) ?? false;
      return {
        role: turn.senderKind === "agent" ? "assistant" : "user",
        content: derived ? derivedOfferContent(turn.body) : turn.body,
        createdAt: turn.occurredAt,
        sourceMessageIds: [turn.messageId],
        ...(turn.senderKind === "agent" ? { peerId: `coforge__${turn.senderHandle}` } : {}),
        ...(derived ? { derived: true } : {}),
      };
    }),
  };
}

export function createOpenVikingAdmittedDeliverySink(deps: {
  sessions: OpenVikingTypedSessionExtract;
  owner: string;
}): AdmissionSink {
  return {
    async deliver(input): Promise<AdmissionSinkResult> {
      const write = admittedSessionWriteFromDelivery(input);
      if (!SESSION_ID_PATTERN.test(write.sessionId)) {
        return {
          outcome: "retryable_failure",
          sanitizedError: "openviking native session unavailable",
        };
      }
      const result = await deps.sessions.writeCommitAndExtract({
        owner: deps.owner,
        write,
      });
      if (result.ok) return { outcome: "delivered" };
      return { outcome: "retryable_failure", sanitizedError: result.sanitizedError };
    },
  };
}
