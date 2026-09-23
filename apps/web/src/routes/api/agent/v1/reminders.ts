import { createFileRoute } from "@tanstack/react-router";
import {
  type AgentReminderOperationRequest,
  type AgentReminderOperationResponse,
  validateAgentReminderOperationRequest,
} from "@lrm/coforge-sdk/internal";
import { isAppError } from "@/lib/app-error";
import { agentAuthMiddleware } from "@/server/agents/agent-http-middleware.server";
import { createAgentReminderService } from "@/server/agents/agent-api-http.server";
import { ReminderRefusal } from "@/server/reminders/reminders.server";

export type AgentReminderPrincipal = {
  workspaceId: string;
  agentId: string;
  computerId: string;
  userId: string;
};

type AgentReminderService = (
  command: AgentReminderOperationRequest,
  userId: string,
) => Promise<AgentReminderOperationResponse>;

/**
 * The Agent API names the request's idempotency key `idempotencyKey`; the reminder command — whose
 * shape is shared with the protobuf codec, and whose rules refuse a request without one — names it
 * `requestId`. The two meet here, in one place, the way the Task route does it.
 *
 * Exported and taking its service as an argument so this boundary is testable on its own: a
 * mismatch here turns every reminder command into `400 invalid reminder request`.
 */

/** `null`, an array, a string and a number are all valid JSON and none of them is a command body. */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function malformedReminderRequest(): Response {
  return Response.json(
    { error: "invalid reminder request", code: "INVALID_INPUT" },
    { status: 400 },
  );
}

/**
 * How a refusal reaches the caller. An authorization refusal is a valid, well-formed request, so it
 * is a 403 — not the same 400 malformed JSON gets — and every other named refusal carries the
 * domain's own `code`. The Daemon reads `code` into its failure log as `upstream_code`, which is the
 * only reason a reminder refusal used to be recorded as `UNCLASSIFIED_PROXY_FAILURE` and nothing
 * could say which of the several causes it was.
 */
function refusalResponse(error: unknown): Response | undefined {
  if (error instanceof ReminderRefusal)
    return error.code === "ACCESS_DENIED"
      ? Response.json({ error: "reminder access denied", code: "ACCESS_DENIED" }, { status: 403 })
      : Response.json({ error: "invalid reminder request", code: error.code }, { status: 400 });
  // An `AppError` access denial is the same refusal from a path that still answers in `AppError`.
  if (isAppError(error) && error.code === "ACCESS_DENIED")
    return Response.json(
      { error: "reminder access denied", code: "ACCESS_DENIED" },
      { status: 403 },
    );
  return undefined;
}

export async function handleAgentReminderPost(
  request: Request,
  principal: AgentReminderPrincipal,
  service: AgentReminderService,
): Promise<Response> {
  let command: AgentReminderOperationRequest;
  let idempotencyKey: string | undefined;
  try {
    const raw: unknown = await request.json();
    if (!isRecord(raw)) return malformedReminderRequest();
    const { idempotencyKey: key, ...fields } = raw;
    idempotencyKey = typeof key === "string" ? key : undefined;
    // JSON in, JSON out: the request is validated against the same rules the codec applies, but
    // this route never becomes protobuf. Protobuf is the WebSocket path's contract, not HTTP's.
    command = validateAgentReminderOperationRequest({ ...fields, requestId: key });
  } catch {
    return malformedReminderRequest();
  }
  if (
    command.agentId !== principal.agentId ||
    command.workspaceId !== principal.workspaceId ||
    command.computerId !== principal.computerId
  )
    return Response.json({ error: "reminder scope denied" }, { status: 403 });
  try {
    const result = await service(command, principal.userId);
    // The caller's own name for the key is what it matches the answer against.
    return Response.json({ ...result, idempotencyKey });
  } catch (error) {
    const refusal = refusalResponse(error);
    if (refusal) return refusal;
    // A fault of ours, answered 500 after logging: blaming the caller for it with a 400 is what hid
    // the original defect behind "invalid reminder request".
    console.error("[agent] Reminder command failed", error);
    return Response.json(
      { error: "Reminder command failed", code: "INTERNAL_ERROR" },
      { status: 500 },
    );
  }
}

export const Route = createFileRoute("/api/agent/v1/reminders")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      POST: ({ request, context: { principal, db } }) =>
        handleAgentReminderPost(request, principal, (command, userId) =>
          createAgentReminderService(db).execute(command, userId),
        ),
    },
  },
});
