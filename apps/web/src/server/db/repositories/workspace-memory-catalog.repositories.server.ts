import type { PrismaClient } from "../../../../generated/client";
import type { WorkspaceMemoryCatalog } from "../../workspace-memory/catalog";
import type {
  AdmissionConversation,
  AdmissionMessage,
  AdmissionTask,
} from "../../workspace-memory/detect-segments";
import {
  DISPATCH_SINK_PROFILES,
  DISPATCH_STATES,
  type AdmittedSegmentDispatchRecord,
} from "../../workspace-memory/dispatch";
import { WorkspaceMemoryScopeError } from "./workspace-memory-errors.server";

export class PrismaWorkspaceMemoryCatalog implements WorkspaceMemoryCatalog {
  constructor(private readonly db: PrismaClient) {}

  async listKnownWorkspaceIds(): Promise<string[]> {
    const rows = await this.db.workspaceMemoryProfile.findMany({
      select: { workspaceId: true },
    });
    return rows.map((row) => row.workspaceId);
  }

  async listAdmittedMessageIds(workspaceId: string): Promise<Set<string>> {
    const rows = await this.db.admittedSegmentSourceMessage.findMany({
      where: { workspaceId },
      select: { messageId: true },
    });
    return new Set(rows.map((row) => row.messageId));
  }

  async listRetryableDispatches(workspaceId: string): Promise<AdmittedSegmentDispatchRecord[]> {
    const rows = await this.db.admittedSegmentDispatch.findMany({
      where: { workspaceId, state: { in: ["pending", "retryable_failure"] } },
    });
    return rows.map(toDispatch);
  }

  async loadAdmissionWindow(
    workspaceId: string,
    after: Date | null,
  ): Promise<{
    conversations: AdmissionConversation[];
    messages: AdmissionMessage[];
    tasks: AdmissionTask[];
  }> {
    const conversations = await this.db.conversation.findMany({
      where: { workspaceId, channelName: { not: null } },
      select: { id: true, workspaceId: true, channelName: true },
    });
    const conversationIds = conversations.map((row) => row.id);
    const createdAfter = after ? { createdAt: { gt: after } } : {};
    const updatedAfter = after ? { updatedAt: { gt: after } } : {};
    const [messages, tasks] = await Promise.all([
      conversationIds.length === 0
        ? Promise.resolve([])
        : this.db.message.findMany({
            where: { workspaceId, conversationId: { in: conversationIds }, ...createdAfter },
            select: messageSelect,
          }),
      conversationIds.length === 0
        ? Promise.resolve([])
        : this.db.task.findMany({
            where: {
              workspaceId,
              status: "done",
              conversationId: { in: conversationIds },
              ...updatedAfter,
            },
            select: {
              messageId: true,
              conversationId: true,
              workspaceId: true,
              status: true,
              updatedAt: true,
            },
          }),
    ]);
    return {
      conversations,
      messages: messages.map(toAdmissionMessage),
      tasks,
    };
  }

  async loadMessagesByIds(
    workspaceId: string,
    messageIds: readonly string[],
  ): Promise<AdmissionMessage[]> {
    if (messageIds.length === 0) return [];
    const rows = await this.db.message.findMany({
      where: { workspaceId, id: { in: [...messageIds] } },
      select: messageSelect,
    });
    return rows.map(toAdmissionMessage);
  }
}

const messageSelect = {
  id: true,
  conversationId: true,
  workspaceId: true,
  sequence: true,
  createdAt: true,
  body: true,
  sender: {
    select: {
      agentId: true,
      user: { select: { username: true } },
      agent: { select: { name: true } },
    },
  },
} as const;

type MessageRow = {
  id: string;
  conversationId: string;
  workspaceId: string;
  sequence: number;
  createdAt: Date;
  body: string;
  sender: {
    agentId: string | null;
    user: { username: string } | null;
    agent: { name: string } | null;
  } | null;
};

function toAdmissionMessage(row: MessageRow): AdmissionMessage {
  return {
    id: row.id,
    conversationId: row.conversationId,
    workspaceId: row.workspaceId,
    sequence: row.sequence,
    createdAt: row.createdAt,
    body: row.body,
    senderKind: row.sender?.agentId ? "agent" : row.sender ? "human" : "system",
    senderHandle: row.sender?.user?.username ?? row.sender?.agent?.name ?? "system",
  };
}

function toDispatch(row: {
  workspaceId: string;
  segmentId: string;
  operationId: string;
  sinkProfile: string;
  profileGeneration: number;
  state: string;
  attemptCount: number;
  sanitizedError: string | null;
}): AdmittedSegmentDispatchRecord {
  if (
    !(DISPATCH_SINK_PROFILES as readonly string[]).includes(row.sinkProfile) ||
    !(DISPATCH_STATES as readonly string[]).includes(row.state)
  ) {
    throw new WorkspaceMemoryScopeError();
  }
  return {
    workspaceId: row.workspaceId,
    segmentId: row.segmentId,
    operationId: row.operationId,
    sinkProfile: row.sinkProfile as AdmittedSegmentDispatchRecord["sinkProfile"],
    profileGeneration: row.profileGeneration,
    state: row.state as AdmittedSegmentDispatchRecord["state"],
    attemptCount: row.attemptCount,
    ...(row.sanitizedError ? { sanitizedError: row.sanitizedError } : {}),
  };
}
