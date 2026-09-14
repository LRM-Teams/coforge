import type { PrismaClient } from "../../../generated/client";
import { PublicChannels } from "../conversations/public-channels.server";
import type { MessageRequestIdempotency } from "../conversations/message-request-idempotency.server";
import type { MessageNotifier } from "../notifications/web-push-composition.server";
import type { ConversationRealtime } from "../conversations/conversation-realtime.server";
import type { CentrifugoServerApi } from "../centrifugo/server-api.server";
import {
  buildWeeklyAssignmentChannelBody,
  weeklyAssignmentChannelRequestId,
} from "./weekly-assignment-channel-notify";

/** Best-effort side effect after weekly assignments are persisted (ADR 0011). */
export type WeeklyAssignmentDelivery = {
  notifyChannel(input: {
    workspaceId: string;
    senderUserId: string;
    parentReportId: string;
    week: number;
    senderDisplayName: string;
  }): Promise<void>;
};

/**
 * Posts one #general notice as the Leader. Failures are the caller's responsibility
 * to swallow; this module throws on channel errors so tests can observe them.
 */
export class GeneralChannelWeeklyAssignmentDelivery implements WeeklyAssignmentDelivery {
  constructor(
    private readonly db: PrismaClient,
    private readonly channels: PublicChannels = new PublicChannels(db),
  ) {}

  static withDeps(
    db: PrismaClient,
    deps: {
      idempotency?: MessageRequestIdempotency;
      publisher?: CentrifugoServerApi;
      notifications?: MessageNotifier;
      realtime?: ConversationRealtime;
    } = {},
  ) {
    return new GeneralChannelWeeklyAssignmentDelivery(
      db,
      new PublicChannels(db, deps.idempotency, deps.publisher, deps.notifications, deps.realtime),
    );
  }

  async notifyChannel(input: {
    workspaceId: string;
    senderUserId: string;
    parentReportId: string;
    week: number;
    senderDisplayName: string;
  }) {
    const general = await this.db.conversation.findFirst({
      where: { workspaceId: input.workspaceId, channelName: "general" },
      select: { id: true },
    });
    if (!general) return;

    await this.channels.send({
      workspaceId: input.workspaceId,
      userId: input.senderUserId,
      channelId: general.id,
      requestId: weeklyAssignmentChannelRequestId(input.parentReportId),
      body: buildWeeklyAssignmentChannelBody({
        senderDisplayName: input.senderDisplayName,
        week: input.week,
      }),
    });
  }
}
