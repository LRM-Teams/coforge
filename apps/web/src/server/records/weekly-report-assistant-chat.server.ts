import { AppError } from "#src/lib/app-error";
import type { PrismaClient } from "#src/generated/prisma/client";
import { SendDirectMessage } from "#src/server/conversations/direct-message.server";
import type { MessageRequestIdempotency } from "#src/server/conversations/message-request-idempotency.server";
import { getMessageRequestIdempotency } from "#src/server/conversations/redis-message-request-idempotency.server";
import {
  CentrifugoConversationRealtime,
  type ConversationRealtime,
} from "#src/server/conversations/conversation-realtime.server";
import {
  createCentrifugoServerApi,
  type CentrifugoServerApi,
} from "#src/server/centrifugo/server-api.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { RecordCatalog } from "./record-catalog.server";
import { ensureWeeklyReportAssistant } from "./weekly-report-assistant.server";
import { ensureWeeklyReportAssistantRuntimeSession } from "./weekly-report-assistant-runtime-session.server";
import {
  alignWeeklyReportAssistantSubjectRuntime,
  createWeeklyReportAssistantSubjectRuntime,
} from "./weekly-report-assistant-subject-launch.server";
import {
  buildWeeklyReportAssistantRequestBody,
  isWeeklyReportPlatformTurn,
  weeklyReportAssistantDisplayBody,
  weeklyReportAssistantSessionFromBody,
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

/** Keeps page+session-scoped turns by binding assistant replies to the latest user turn. */
export function selectWeeklyReportAssistantMessages(
  messages: readonly BrowserChatMessage[],
  subjectType: "report" | "cycle",
  subjectId: string,
  sessionId?: string | null,
  options?: { includeLegacyUnscoped?: boolean },
): WeeklyReportAssistantChatMessage[] {
  const subjectKey = `${subjectType}:${subjectId}`;
  let activeSubject: string | null = null;
  let activeSession: string | null = null;
  const selected: WeeklyReportAssistantChatMessage[] = [];
  for (const message of messages) {
    if (message.senderKind === "user") {
      activeSubject = weeklyReportAssistantSubjectFromBody(message.body);
      activeSession = weeklyReportAssistantSessionFromBody(message.body);
    }
    if (activeSubject !== subjectKey) continue;
    if (sessionId) {
      const matchesSession = activeSession === sessionId;
      const matchesLegacy = Boolean(options?.includeLegacyUnscoped) && activeSession === null;
      if (!matchesSession && !matchesLegacy) continue;
    }
    if (message.senderKind !== "user" && message.senderKind !== "agent") continue;
    // Platform synthesizer wakes still bind subject/session above, but stay out of the UI.
    if (message.senderKind === "user" && isWeeklyReportPlatformTurn(message.body)) continue;
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
    private readonly alignSubject: boolean = false,
  ) {}

  async postRequest(input: {
    workspaceId: string;
    userId: string;
    requestId: string;
    subjectType: "report" | "cycle";
    subjectId: string;
    sessionId: string;
    body: string;
    /** Collect→synthesize handoff: wake Agent, hide from side-panel member turns. */
    platformTurn?: boolean;
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

    const runtimeSession = await ensureWeeklyReportAssistantRuntimeSession(this.db, {
      workspaceId: input.workspaceId,
      agentId: assistant.agentId,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
    });
    if (this.alignSubject) {
      await alignWeeklyReportAssistantSubjectRuntime(
        createWeeklyReportAssistantSubjectRuntime(this.db),
        {
          workspaceId: input.workspaceId,
          userId: input.userId,
          agentId: assistant.agentId,
          sessionId: runtimeSession.sessionId,
          created: runtimeSession.created,
        },
      );
    }

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
        sessionId: input.sessionId,
        userText: text,
        contextManifest,
        platformTurn: input.platformTurn,
      }),
    });
    return {
      agentId: assistant.agentId,
      conversationId: opened.conversationId,
      runtimeSessionId: runtimeSession.sessionId,
      message: {
        id: message.id,
        sequence: message.sequence,
        body: message.body,
        displayBody: text,
        author: "user" as const,
        createdAt: message.createdAt.toISOString(),
        suggestion: null,
        hidden: Boolean(input.platformTurn),
      },
    };
  }

  async listMessages(input: {
    workspaceId: string;
    userId: string;
    subjectType: "report" | "cycle";
    subjectId: string;
    sessionId: string;
    includeLegacyUnscoped?: boolean;
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
        input.sessionId,
        { includeLegacyUnscoped: input.includeLegacyUnscoped },
      ),
    };
  }
}

/** Page wakes align the assistant onto that subject's Agent session before the DM is delivered. */
export function openWeeklyReportAssistantChat(db: PrismaClient) {
  const centrifugo = createCentrifugoServerApi();
  return new WeeklyReportAssistantChat(
    db,
    new PrismaDirectConversationRepository(db),
    getMessageRequestIdempotency(),
    centrifugo,
    new CentrifugoConversationRealtime(centrifugo),
    true,
  );
}
