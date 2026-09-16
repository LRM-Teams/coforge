/** A safe, low-cardinality error identifier for structured logs. */
export function diagnosticErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) return String(error.code);
  return error instanceof Error ? error.name : "UnknownError";
}
