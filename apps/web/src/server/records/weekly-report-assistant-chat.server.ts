import { AppError } from "../../lib/app-error";
import type { PrismaClient } from "../../../generated/client";
import { SendDirectMessage } from "../conversations/direct-message.server";
import type { MessageRequestIdempotency } from "../conversations/message-request-idempotency.server";
import type { ConversationRealtime } from "../conversations/conversation-realtime.server";
import type { CentrifugoServerApi } from "../centrifugo/server-api.server";
import { PrismaDirectConversationRepository } from "../db/repositories/direct-conversation.repositories.server";
import { RecordCatalog } from "./record-catalog.server";
import { ensureWeeklyReportAssistant } from "./weekly-report-assistant.server";
import {
  buildWeeklyReportAssistantRequestBody,
  weeklyReportAssistantDisplayBody,
  weeklyReportAssistantSubjectFromBody,
} from "./weekly-report-assistant-request.server";
import {
  parseWeeklyReportAssistantSuggestion,
  weeklyReportAssistantSuggestionDisplayBody,
  type WeeklyReportAssistantSuggestion,
} from "./weekly-report-assistant-suggestion.server";

export type WeeklyReportAssistantChatMessage = {
  id: string;
  sequence: number;
  body: string;
  displayBody: string;
  author: "user" | "assistant";
  createdAt: string;
  suggestion: WeeklyReportAssistantSuggestion | null;
};

type BrowserChatMessage = {
  id: string;
  sequence: number;
  body: string;
  senderKind: "user" | "agent" | "system";
  createdAt: Date | string;
};

/** Keeps page-scoped turns by binding assistant replies to the latest user subject. */
export function selectWeeklyReportAssistantMessages(
  messages: readonly BrowserChatMessage[],
  subjectType: "report" | "highlight" | "cycle",
  subjectId: string,
): WeeklyReportAssistantChatMessage[] {
  const subjectKey = `${subjectType}:${subjectId}`;
  let activeSubject: string | null = null;
  const selected: WeeklyReportAssistantChatMessage[] = [];
  for (const message of messages) {
    if (message.senderKind === "user") {
      activeSubject = weeklyReportAssistantSubjectFromBody(message.body);
    }
    if (activeSubject !== subjectKey) continue;
    if (message.senderKind !== "user" && message.senderKind !== "agent") continue;
    const isAssistant = message.senderKind === "agent";
    selected.push({
      id: message.id,
      sequence: message.sequence,
      body: message.body,
      displayBody: isAssistant
        ? weeklyReportAssistantSuggestionDisplayBody(message.body)
        : weeklyReportAssistantDisplayBody(message.body),
      author: isAssistant ? "assistant" : "user",
      createdAt:
        typeof message.createdAt === "string" ? message.createdAt : message.createdAt.toISOString(),
      suggestion: isAssistant ? parseWeeklyReportAssistantSuggestion(message.body) : null,
    });
  }
  return selected;
}

/** Posts page-scoped weekly-report assistant requests over the existing User–Agent DM. */
export class WeeklyReportAssistantChat {
  constructor(
    private readonly db: PrismaClient,
    private readonly conversations: PrismaDirectConversationRepository,
    private readonly idempotency: MessageRequestIdempotency,
    private readonly centrifugo: Pick<CentrifugoServerApi, "publish">,
    private readonly realtime?: ConversationRealtime,
  ) {}

  async postRequest(input: {
    workspaceId: string;
    userId: string;
    requestId: string;
    subjectType: "report" | "highlight" | "cycle";
    subjectId: string;
    body: string;
  }) {
    const text = input.body.trim();
    if (!text) throw new AppError("INVALID_INPUT");
    const assistant = await ensureWeeklyReportAssistant(this.db, {
      workspaceId: input.workspaceId,
      userId: input.userId,
    });
    const agent = await this.db.agent.findUnique({
      where: { id_workspaceId: { id: assistant.agentId, workspaceId: input.workspaceId } },
      select: { ownerId: true, computerId: true },
    });
    if (!agent || agent.ownerId !== input.userId) throw new AppError("ACCESS_DENIED");
    if (!agent.computerId) throw new AppError("INVALID_INPUT");

    const catalog = new RecordCatalog(this.db);
    const contextManifest = await catalog.loadAssistantContextManifest({
      workspaceId: input.workspaceId,
      userId: input.userId,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
    });
    const opened = await this.conversations.memberForUser(
      input.workspaceId,
      input.userId,
      assistant.agentId,
    );
    const message = await new SendDirectMessage(
      this.conversations,
      this.idempotency,
      this.centrifugo,
      this.realtime,
    ).execute({
      requestId: input.requestId,
      workspaceId: input.workspaceId,
      conversationId: opened.conversationId,
      senderMemberId: opened.senderMemberId,
      senderUserId: input.userId,
      body: buildWeeklyReportAssistantRequestBody({
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        userText: text,
        contextManifest,
      }),
    });
    return {
      agentId: assistant.agentId,
      conversationId: opened.conversationId,
      message: {
        id: message.id,
        sequence: message.sequence,
        body: message.body,
        displayBody: text,
        author: "user" as const,
        createdAt: message.createdAt.toISOString(),
        suggestion: null,
      },
    };
  }

  async listMessages(input: {
    workspaceId: string;
    userId: string;
    subjectType: "report" | "highlight" | "cycle";
    subjectId: string;
  }): Promise<{
    agentId: string;
    conversationId: string;
    messages: WeeklyReportAssistantChatMessage[];
  }> {
    const assistant = await ensureWeeklyReportAssistant(this.db, {
      workspaceId: input.workspaceId,
      userId: input.userId,
    });
    const opened = await this.conversations.openForUser(
      input.workspaceId,
      input.userId,
      assistant.agentId,
      { limit: 100 },
    );
    return {
      agentId: assistant.agentId,
      conversationId: opened.conversationId,
      messages: selectWeeklyReportAssistantMessages(
        opened.messages,
        input.subjectType,
        input.subjectId,
      ),
    };
  }
}
