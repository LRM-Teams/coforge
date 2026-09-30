import { isAppError } from "#src/lib/app-error";
import { toPublicServerError } from "#src/server/errors/public-error.server";

/**
 * The steps of the browser sign-in callback, each with what its failure is called. A failed
 * sign-in redirects to `/login` and tells the browser nothing else, so this is the operator's
 * whole account of why.
 */
const FAILURE_REASONS = {
  state: "invalid login state",
  token_exchange: "failed to exchange authorization code",
  userinfo: "failed to fetch Authing user info",
  email: "email is required",
  user_resolution: "failed to resolve user",
  enrollment: "failed to enroll user in a Workspace",
} as const;

export type LoginFailureStage = keyof typeof FAILURE_REASONS;

/** What an OAuth error code looks like (RFC 6749 §5.2: `invalid_grant`); anything else is not one. */
const OAUTH_ERROR_CODE = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * A sign-in callback that failed at `stage`. It carries only what is safe to log: the step, its
 * fixed reason, Authing's HTTP status, and Authing's OAuth error code. The underlying exception,
 * whose message may hold an email, SQL, or a token, stays in `cause` and is never logged.
 */
export class LoginCallbackError extends Error {
  readonly stage: LoginFailureStage;
  readonly reason: string;
  readonly status?: number;
  readonly providerError?: string;

  constructor(
    stage: LoginFailureStage,
    options: {
      /** Only for a reason more precise than the step's own; it must be fixed text. */
      reason?: string;
      status?: number;
      /** Authing's `error` field; kept only when it is an OAuth error code. */
      providerError?: unknown;
      cause?: unknown;
    } = {},
  ) {
    const reason = options.reason ?? FAILURE_REASONS[stage];
    const providerError =
      typeof options.providerError === "string" && OAUTH_ERROR_CODE.test(options.providerError)
        ? options.providerError
        : undefined;
    const detail = providerError ?? options.status;
    super(detail === undefined ? reason : `${reason}: ${detail}`, { cause: options.cause });
    this.name = "LoginCallbackError";
    this.stage = stage;
    this.reason = reason;
    if (options.status !== undefined) this.status = options.status;
    if (providerError !== undefined) this.providerError = providerError;
  }
}

/**
 * Runs one step of the callback. Whatever it throws is that step's failure: an error that already
 * names its step passes through, anything else (a refused connection, an unreadable body, a
 * database error) is wrapped, so the step is known wherever the exception came from.
 */
export async function atLoginStage<T>(
  stage: LoginFailureStage,
  step: () => Promise<T>,
): Promise<T> {
  try {
    return await step();
  } catch (error) {
    throw error instanceof LoginCallbackError
      ? error
      : new LoginCallbackError(stage, { cause: error });
  }
}

/**
 * Logs why a sign-in callback failed as one `auth.login_callback_failed` line. An exception under
 * the failure is reported the way every server exception is (`server_operation_failed`, with
 * stack positions), and the `errorId` on both lines ties the two together.
 */
export function reportLoginCallbackFailure(error: unknown): void {
  const failure = error instanceof LoginCallbackError ? error : null;
  const cause = failure ? failure.cause : error;
  const record: Record<string, unknown> = {
    event: "auth.login_callback_failed",
    stage: failure?.stage ?? "unexpected",
    reason: failure?.reason ?? "unexpected error",
    ...(failure?.status !== undefined ? { status: failure.status } : {}),
    ...(failure?.providerError !== undefined ? { providerError: failure.providerError } : {}),
  };
  if (cause !== undefined) {
    const reported = toPublicServerError(cause);
    record.errorType = cause instanceof Error ? "error" : "non_error";
    // An AppError's code is a fixed public name (`ACCESS_DENIED`), safe to log.
    if (isAppError(cause)) record.errorCode = cause.code;
    if (isAppError(reported) && reported.errorId) record.errorId = reported.errorId;
  }
  console.error(JSON.stringify(record));
}
