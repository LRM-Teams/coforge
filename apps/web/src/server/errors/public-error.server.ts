import { isNotFound, isRedirect } from "@tanstack/react-router";

import { AppError, isAppError } from "@/lib/app-error";

type ErrorReport = {
  event: "server_operation_failed";
  errorId: string;
  errorType: "error" | "non_error";
};

export function toPublicServerError(
  cause: unknown,
  report: (record: ErrorReport) => void = reportServerError,
  createId: () => string = () => crypto.randomUUID(),
): unknown {
  if (isAppError(cause) || isRedirect(cause) || isNotFound(cause)) return cause;

  const errorId = createId();
  report({
    event: "server_operation_failed",
    errorId,
    errorType: cause instanceof Error ? "error" : "non_error",
  });
  return new AppError("INTERNAL_ERROR", { errorId });
}

function reportServerError(record: ErrorReport): void {
  console.error(JSON.stringify(record));
}
