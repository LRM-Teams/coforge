/**
 * P4 port extension: profile-neutral admitted-segment detection.
 * C1 only froze the segment DTO and canAdmitSegment; detection lives here so
 * the OpenViking sink consumes one extractor window.
 */
import type { AdmittedSegmentKind } from "./admission";

export type AdmissionSenderKind = "human" | "agent" | "system";

export type AdmissionMessage = {
  id: string;
  conversationId: string;
  workspaceId: string;
  sequence: number;
  createdAt: Date;
  body: string;
  senderKind: AdmissionSenderKind;
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

export type AdmissionTurn = {
  messageId: string;
  sequence: number;
  occurredAt: string;
  payloadHash: string;
  senderKind: AdmissionSenderKind;
  senderHandle: string;
  body: string;
};

export type DetectedPublicChannelSegment = {
  segmentId: string;
  sourceMessageIds: readonly string[];
  workspace: { workspaceId: string; channelId: string };
  kind: AdmittedSegmentKind;
  conversationKind: "public_channel";
  sourcePayloadHash: string;
  closedAt: string;
  turns: readonly AdmissionTurn[];
};

export function sourcePayloadHash(
  messages: ReadonlyArray<Pick<AdmissionMessage, "id" | "body">>,
): string {
  const hasher = new Bun.CryptoHasher("sha256");
  for (const message of [...messages].sort((left, right) => left.id.localeCompare(right.id))) {
    hasher.update(message.id);
    hasher.update("\n");
    hasher.update(message.body);
    hasher.update("\n");
  }
  return `sha256:${hasher.digest("hex")}`;
}

export function ingestOperationId(admittedSegmentId: string): string {
  return `ingest-${admittedSegmentId}`;
}

export function detectAdmittedPublicChannelSegments(input: {
  conversations: AdmissionConversation[];
  messages: AdmissionMessage[];
  tasks: AdmissionTask[];
  admittedMessageIds: Set<string>;
  now: Date;
  quietAfterMs: number;
}): DetectedPublicChannelSegment[] {
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
  for (const list of byConversation.values()) {
    list.sort((left, right) => left.sequence - right.sequence);
  }

  const detected: DetectedPublicChannelSegment[] = [];
  const claimed = new Set(input.admittedMessageIds);

  for (const task of input.tasks) {
    if (task.status !== "done" || !publicChannels.has(task.conversationId)) continue;
    const segmentId = `task-${task.messageId}`;
    const window = (byConversation.get(task.conversationId) ?? []).filter(
      (message) => message.createdAt.getTime() <= task.updatedAt.getTime(),
    );
    if (window.every((message) => claimed.has(message.id))) continue;
    detected.push(
      toDetected(
        task.workspaceId,
        task.conversationId,
        segmentId,
        "completed_task",
        window,
        task.updatedAt,
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
    const segmentId = `quiet-${conversationId}-${unaudited[0]!.id}`;
    detected.push(
      toDetected(
        workspaceId,
        conversationId,
        segmentId,
        "quiet_window",
        unaudited,
        unaudited[unaudited.length - 1]!.createdAt,
      ),
    );
    for (const message of unaudited) claimed.add(message.id);
  }

  return detected;
}

function toDetected(
  workspaceId: string,
  channelId: string,
  segmentId: string,
  kind: AdmittedSegmentKind,
  messages: AdmissionMessage[],
  closedAt: Date,
): DetectedPublicChannelSegment {
  return {
    segmentId,
    sourceMessageIds: messages.map((message) => message.id),
    workspace: { workspaceId, channelId },
    kind,
    conversationKind: "public_channel",
    sourcePayloadHash: sourcePayloadHash(messages),
    closedAt: closedAt.toISOString(),
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
