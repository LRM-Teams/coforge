const SECRET_PATTERN = /Bearer\s+\S+|user_key|root_api_key|api[_-]?key|authorization/gi;

export function sanitizeDiagnostic(value: unknown): string {
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  return raw.replace(SECRET_PATTERN, "[redacted]");
}
