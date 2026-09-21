import { createHash } from "node:crypto";
import type { AdmittedSegmentIngestLedger, AdmittedSegmentKind, CausalAuditTurn } from "./contract";

export type AdmissionMessage = {
  id: string;
  conversationId: string;
  workspaceId: string;
  sequence: number;
  createdAt: Date;
  body: string;
  senderKind: CausalAuditTurn["senderKind"];
  senderHandle: string;
};

export type AdmissionTask = {
  messageId: string;
  conversationId: string;
  workspaceId: string;
  status: string;
  updatedAt: Date;
};

export type AdmissionConversation = {
  id: string;
  workspaceId: string;
  channelName: string | null;
};

export type DetectedAdmittedSegment = {
  ledger: AdmittedSegmentIngestLedger;
  session: { workspaceId: string; channelId: string };
  turns: CausalAuditTurn[];
};

export function sourcePayloadHash(
  messages: ReadonlyArray<Pick<AdmissionMessage, "id" | "body">>,
): string {
  const digest = createHash("sha256");
  for (const message of [...messages].sort((left, right) => left.id.localeCompare(right.id))) {
    digest.update(message.id);
    digest.update("\n");
    digest.update(message.body);
    digest.update("\n");
  }
  return `sha256:${digest.digest("hex")}`;
}

export function ingestOperationId(admittedSegmentId: string): string {
  return `ingest-${admittedSegmentId}`;
}

export function detectAdmittedSegments(input: {
  conversations: AdmissionConversation[];
  messages: AdmissionMessage[];
  tasks: AdmissionTask[];
  admittedMessageIds: Set<string>;
  now: Date;
  quietAfterMs: number;
}): DetectedAdmittedSegment[] {
  const publicChannels = new Set(
    input.conversations
      .filter((conversation) => conversation.channelName)
      .map((conversation) => conversation.id),
  );
  const byConversation = new Map<string, AdmissionMessage[]>();
  for (const message of input.messages) {
    if (!publicChannels.has(message.conversationId)) continue;
    const list = byConversation.get(message.conversationId) ?? [];
    list.push(message);
    byConversation.set(message.conversationId, list);
  }
  for (const list of byConversation.values())
    list.sort((left, right) => left.sequence - right.sequence);

  const detected: DetectedAdmittedSegment[] = [];
  const claimed = new Set(input.admittedMessageIds);

  for (const task of input.tasks) {
    if (task.status !== "done" || !publicChannels.has(task.conversationId)) continue;
    const admittedSegmentId = `task-${task.messageId}`;
    const window = (byConversation.get(task.conversationId) ?? []).filter(
      (message) => message.createdAt.getTime() <= task.updatedAt.getTime(),
    );
    if (window.length === 0 || window.every((message) => claimed.has(message.id))) continue;
    detected.push(
      toDetected(
        task.workspaceId,
        task.conversationId,
        admittedSegmentId,
        "completed_task",
        window,
      ),
    );
    for (const message of window) claimed.add(message.id);
  }

  for (const [conversationId, messages] of byConversation) {
    const latest = messages[messages.length - 1];
    if (!latest) continue;
    if (input.now.getTime() - latest.createdAt.getTime() < input.quietAfterMs) continue;
    const unaudited = messages.filter((message) => !claimed.has(message.id));
    if (unaudited.length === 0) continue;
    const workspaceId = unaudited[0]!.workspaceId;
    const admittedSegmentId = `quiet-${conversationId}-${unaudited[0]!.id}`;
    detected.push(
      toDetected(workspaceId, conversationId, admittedSegmentId, "quiet_window", unaudited),
    );
    for (const message of unaudited) claimed.add(message.id);
  }

  return detected;
}

function toDetected(
  workspaceId: string,
  channelId: string,
  admittedSegmentId: string,
  kind: AdmittedSegmentKind,
  messages: AdmissionMessage[],
): DetectedAdmittedSegment {
  return {
    ledger: {
      workspaceId,
      admittedSegmentId,
      operationId: ingestOperationId(admittedSegmentId),
      kind,
      sourceMessageIds: messages.map((message) => message.id),
      sourcePayloadHash: sourcePayloadHash(messages),
      state: "pending",
      attemptCount: 0,
    },
    session: { workspaceId, channelId },
    turns: messages.map((message) => ({
      messageId: message.id,
      sequence: message.sequence,
      occurredAt: message.createdAt.toISOString(),
      payloadHash: sourcePayloadHash([message]),
      senderKind: message.senderKind,
      senderHandle: message.senderHandle,
      body: message.body,
    })),
  };
}
