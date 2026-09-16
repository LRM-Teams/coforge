import { formatValidationError, isValidationError } from "@lrm/coforge-sdk/internal";
import { isAppError } from "@/lib/app-error";
import { AgentMessageValidationError } from "../conversations/agent-message-validation-error.server";
import { MessageRequestInProgressError } from "../conversations/message-request-idempotency.server";
import { ComputerRegistrationError } from "../computers/registration.server";
import { WorkspaceQueryError } from "../workspaces/query.server";

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
      RELEASE_FEED_UNAVAILABLE: 503,
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
