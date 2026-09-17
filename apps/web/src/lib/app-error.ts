export const APP_ERROR_CODES = [
  "INVALID_INPUT",
  "NOT_FOUND",
  "ACCESS_DENIED",
  "CONFLICT",
  "TEMPORARILY_UNAVAILABLE",
  "INTERNAL_ERROR",
  "WORKSPACE_REQUIRED",
  "COMPUTER_OFFLINE",
  "COMPUTER_IDENTITY_UNKNOWN",
  "RELEASE_FEED_UNAVAILABLE",
] as const;

export type AppErrorCode = (typeof APP_ERROR_CODES)[number];

const APP_ERROR_PREFIX = "COFORGE_APP_ERROR:";

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly errorId?: string;

  constructor(code: AppErrorCode, options: { errorId?: string } = {}) {
    super(`${APP_ERROR_PREFIX}${code}${options.errorId ? `:${options.errorId}` : ""}`);
    this.name = "AppError";
    this.code = code;
    this.errorId = options.errorId;
    this.stack = undefined;
  }
}

export function isAppError(error: unknown): error is AppError {
  if (!(error instanceof Error)) return false;
  if (error.name === "AppError") {
    const code = Reflect.get(error, "code");
    if (!APP_ERROR_CODES.some((candidate) => candidate === code)) return false;
    if (!Reflect.get(error, "errorId") && error.message.startsWith(APP_ERROR_PREFIX)) {
      const [msgCode, ...idParts] = error.message.slice(APP_ERROR_PREFIX.length).split(":");
      if (msgCode === code && idParts.length > 0) {
        Object.assign(error, { errorId: idParts.join(":") });
      }
    }
    return true;
  }
  if (error.name !== "Error" || !error.message.startsWith(APP_ERROR_PREFIX)) return false;
  const [code, ...idParts] = error.message.slice(APP_ERROR_PREFIX.length).split(":");
  if (!APP_ERROR_CODES.some((candidate) => candidate === code)) return false;
  const errorId = idParts.length > 0 ? idParts.join(":") : undefined;
  error.name = "AppError";
  Object.assign(error, { code, ...(errorId ? { errorId } : {}) });
  error.stack = undefined;
  return true;
}
