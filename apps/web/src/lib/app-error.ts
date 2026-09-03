export const APP_ERROR_CODES = [
  "INVALID_INPUT",
  "NOT_FOUND",
  "ACCESS_DENIED",
  "CONFLICT",
  "TEMPORARILY_UNAVAILABLE",
  "INTERNAL_ERROR",
  "WORKSPACE_REQUIRED",
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
    return APP_ERROR_CODES.some((candidate) => candidate === code);
  }
  if (error.name !== "Error" || !error.message.startsWith(APP_ERROR_PREFIX)) return false;
  const [code, errorId, ...extra] = error.message.slice(APP_ERROR_PREFIX.length).split(":");
  if (extra.length > 0 || !APP_ERROR_CODES.some((candidate) => candidate === code)) return false;
  error.name = "AppError";
  Object.assign(error, { code, ...(errorId ? { errorId } : {}) });
  error.stack = undefined;
  return true;
}
