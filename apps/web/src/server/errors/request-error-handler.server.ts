import { formatValidationError, isValidationError } from "@lrm/coforge-sdk/internal";
import { isAppError } from "#src/lib/app-error";
import { AgentMessageValidationError } from "#src/server/conversations/agent-message-validation-error.server";
import { MessageRequestInProgressError } from "#src/server/conversations/message-request-idempotency.server";
import { ComputerRegistrationError } from "#src/server/computers/registration.server";
import { WorkspaceQueryError } from "#src/server/workspaces/query.server";

export type HandledRequestError = { code: number; message: string };
export class RequestAuthenticationError extends Error {}

export function handleRequestError(error: unknown): HandledRequestError {
  if (error instanceof ComputerRegistrationError || error instanceof WorkspaceQueryError)
    return { code: error.code, message: error.message };
  if (error instanceof AgentMessageValidationError) return { code: 400, message: error.message };
  if (error instanceof RequestAuthenticationError)
    return { code: 401, message: "authentication required" };
  if (error instanceof MessageRequestInProgressError) return { code: 409, message: error.message };
  if (isValidationError(error)) return { code: 400, message: formatValidationError(error) };
  if (isAppError(error)) {
    const code = {
      INVALID_INPUT: 400,
      NOT_FOUND: 404,
      ACCESS_DENIED: 403,
      CONFLICT: 409,
      TEMPORARILY_UNAVAILABLE: 503,
      WORKSPACE_REQUIRED: 400,
      INTERNAL_ERROR: 500,
      COMPUTER_OFFLINE: 409,
      COMPUTER_IDENTITY_UNKNOWN: 409,
      RELEASE_FEED_UNAVAILABLE: 503,
      AGENT_CONTEXT_UNAVAILABLE: 404,
      // A private Agent the viewer cannot see: 404 status, no Agent details.
      AGENT_NOT_VISIBLE: 404,
      // A private Agent's direct conversation is scoped to its creator: the caller can
      // see the Agent but its DM stays read-only for them, so this is a 403, not a 404.
      AGENT_DM_RESTRICTED: 403,
      // The server could not reach this browser's push service: the caller should
      // retry another way, not treat it as a permanent failure.
      PUSH_SERVICE_UNREACHABLE: 503,
    }[error.code];
    return { code, message: error.message };
  }
  console.error(
    JSON.stringify({
      event: "server_request_failed",
      errorType: error instanceof Error ? error.name : typeof error,
    }),
  );
  return { code: 500, message: "RPC method failed" };
}
