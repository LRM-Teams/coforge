/** Only allow in-app Records return paths (no open redirect). */
export function sanitizeRecordsReturnTo(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (!value.startsWith("/records/")) return undefined;
  if (value.includes("://") || value.includes("\\") || value.includes("\n")) return undefined;
  if (value.length > 200) return undefined;
  return value;
}
