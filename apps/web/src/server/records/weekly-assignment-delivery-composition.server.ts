import type { PrismaClient } from "../../../generated/client";
import { CentrifugoConversationRealtime } from "../conversations/conversation-realtime.server";
import { createCentrifugoServerApi } from "../centrifugo/server-api.server";
import { bestEffortMessageNotifier } from "../notifications/web-push-composition.server";
import {
  GeneralChannelWeeklyAssignmentDelivery,
  type WeeklyAssignmentDelivery,
} from "./weekly-assignment-channel-delivery.server";

/**
 * Best-effort #general notice after Leader send (ADR 0011).
 * Returns undefined when Centrifugo is not configured so assignments still persist.
 */
export function tryCreateWeeklyAssignmentDelivery(
  db: PrismaClient,
  env: NodeJS.ProcessEnv = process.env,
): WeeklyAssignmentDelivery | undefined {
  if (!env.COFORGE_CENTRIFUGO_API_URL || !env.COFORGE_CENTRIFUGO_API_KEY) {
    return undefined;
  }
  const centrifugo = createCentrifugoServerApi(env);
  return GeneralChannelWeeklyAssignmentDelivery.withDeps(db, {
    publisher: centrifugo,
    notifications: bestEffortMessageNotifier(db),
    realtime: new CentrifugoConversationRealtime(centrifugo),
  });
}
