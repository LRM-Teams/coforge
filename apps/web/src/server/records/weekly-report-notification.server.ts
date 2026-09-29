import type { PrismaClient } from "#src/generated/prisma/client";
import { ensureWeeklyReportAssistant } from "./weekly-report-assistant.server";
import type { WeeklyReportNotifier } from "./weekly-report-distribution.server";
import { SendDirectMessage } from "#src/server/conversations/direct-message.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { getMessageRequestIdempotency } from "#src/server/conversations/redis-message-request-idempotency.server";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { CentrifugoConversationRealtime } from "#src/server/conversations/conversation-realtime.server";
import { createWebPushNotifications } from "#src/server/notifications/web-push-composition.server";

/** Platform invitation in the recipient's own assistant DM; never impersonates a human. */
export function weeklyReportNotifier(
  db: PrismaClient,
  sender?: Pick<SendDirectMessage, "executeFromAgent">,
): WeeklyReportNotifier {
  return {
    async notify(input) {
      const assistant = await ensureWeeklyReportAssistant(db, {
        workspaceId: input.workspaceId,
        userId: input.userId,
      });
      const [user, workspace, agent] = await Promise.all([
        db.user.findUniqueOrThrow({ where: { id: input.userId }, select: { username: true } }),
        db.workspace.findUniqueOrThrow({
          where: { id: input.workspaceId },
          select: { slug: true },
        }),
        db.agent.findUniqueOrThrow({
          where: { id: assistant.agentId },
          select: { computerId: true },
        }),
      ]);
      const url = `/w/${workspace.slug}/records/${input.reportId}`;
      const body = `请填写 ${input.year} 年第 ${input.week} 周的「${input.templateName}」周报。\n\n直接回复本周工作和下周计划，我会按模板整理；说“提交”后发送给发起人。\n\n[查看本期周报](${url})`;
      const existing = await db.message.findFirst({
        where: {
          workspaceId: input.workspaceId,
          sender: { agentId: assistant.agentId },
          body: { endsWith: `[查看本期周报](${url})` },
        },
        select: { id: true },
      });
      if (!existing) {
        let messages = sender;
        if (!messages) {
          const api = createCentrifugoServerApi();
          messages = new SendDirectMessage(
            new PrismaDirectConversationRepository(db),
            getMessageRequestIdempotency(),
            api,
            new CentrifugoConversationRealtime(api),
            await createWebPushNotifications(db),
          );
        }
        await messages.executeFromAgent({
          workspaceId: input.workspaceId,
          agentId: assistant.agentId,
          target: `@${user.username}`,
          idempotencyKey: `weekly-report-invite:${input.reportId}`,
          body,
        });
      }
      return { status: agent.computerId ? "notified" : "assistant_unconfigured" };
    },
  };
}
