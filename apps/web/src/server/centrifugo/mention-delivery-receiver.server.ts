import {
  decodeAgentMentionDeliveryTerminalError,
  decodeAgentMentionDeliveryTransition,
} from "@lrm/coforge-sdk/internal";
import type { MentionDeliveryReports } from "#src/server/conversations/mention-deliveries.server";
import type { CentrifugoRpcMethod } from "./rpc-handler.server";
import { rejectNonDaemonPrincipal } from "./daemon-principal.server";
import { rejectionReason } from "./rejection-reason.server";

/** The fixed messages a malformed report is refused with. A report whose delivery is gone,
 * already settled, or re-issued since is `MentionDeliveryReports`' own no-op, never a rejection. */
const KNOWN_REJECTION_REASONS = new Set([
  "invalid mention delivery envelope",
  "invalid mention delivery transition",
  "invalid mention delivery terminal error",
  "mention delivery transition payload too large",
  "mention delivery terminal error payload too large",
]);

/**
 * A fire-and-forget daemon report on a tracked mention. Answers 403 on any rejection and logs it
 * with an allowlisted reason, like the Session receivers.
 */
function createMentionDeliveryReportMethod<Report extends { workspaceId: string }>(
  decode: (payload: Uint8Array) => Report,
  receive: (report: Report, computerId: string) => Promise<void>,
  name: "transition" | "terminal_error",
): CentrifugoRpcMethod {
  return async (payload, metadata) => {
    const rejection = rejectNonDaemonPrincipal(metadata.principal);
    if (rejection) return rejection;
    try {
      const report = decode(payload);
      if (metadata.principal.workspaceId !== report.workspaceId)
        return { code: 403, message: "mention delivery scope is not authorized" };
      await receive(report, metadata.principal.computerId);
      return new Uint8Array();
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: `mention_delivery:${name}_rejected`,
          workspace_id: metadata.principal.workspaceId,
          computer_id: metadata.principal.computerId,
          reason: rejectionReason(error, KNOWN_REJECTION_REASONS),
        }),
      );
      return { code: 403, message: `mention delivery ${name} is not authorized` };
    }
  };
}

export const createMentionDeliveryTransitionMethod = (
  reports: Pick<MentionDeliveryReports, "receiveTransition">,
) =>
  createMentionDeliveryReportMethod(
    decodeAgentMentionDeliveryTransition,
    (report, computerId) => reports.receiveTransition(report, computerId),
    "transition",
  );

export const createMentionDeliveryTerminalErrorMethod = (
  reports: Pick<MentionDeliveryReports, "receiveTerminalError">,
) =>
  createMentionDeliveryReportMethod(
    decodeAgentMentionDeliveryTerminalError,
    (report, computerId) => reports.receiveTerminalError(report, computerId),
    "terminal_error",
  );
