import { createFileRoute } from "@tanstack/react-router";

import { createCentrifugoServerApi } from "@/server/centrifugo/server-api.server";
import { CentrifugoConversationRealtime } from "@/server/conversations/conversation-realtime.server";
import { getDatabaseClient } from "@/server/db/client.server";
import { bestEffortMessageNotifier } from "@/server/notifications/web-push-composition.server";
import { recordCatalog } from "@/server/records/record-catalog.server";
import { GeneralChannelWeeklyAssignmentDelivery } from "@/server/records/weekly-assignment-channel-delivery.server";

/**
 * External cron tick for periodic weekly-report send.
 * Authorize with header `x-coforge-weekly-report-cron-secret` matching
 * `COFORGE_WEEKLY_REPORT_CRON_SECRET`.
 */
export const Route = createFileRoute("/api/internal/weekly-report-schedule")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = process.env.COFORGE_WEEKLY_REPORT_CRON_SECRET;
        if (!secret || request.headers.get("x-coforge-weekly-report-cron-secret") !== secret) {
          return Response.json({ error: "unauthorized" }, { status: 403 });
        }
        const db = getDatabaseClient();
        if (!db) {
          return Response.json({ error: "database unavailable" }, { status: 503 });
        }
        const centrifugo = createCentrifugoServerApi();
        const delivery = GeneralChannelWeeklyAssignmentDelivery.withDeps(db, {
          publisher: centrifugo,
          notifications: bestEffortMessageNotifier(db),
          realtime: new CentrifugoConversationRealtime(centrifugo),
        });
        const result = await recordCatalog(db, delivery).runDueScheduledWeeklyAssignments();
        return Response.json(result);
      },
    },
  },
});
