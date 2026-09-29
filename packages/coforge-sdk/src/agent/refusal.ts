import { isRecord } from "#src/internal/json-record";

/**
 * The Agent API's explained refusal: the body a route answers when it refuses a request for a
 * reason the Agent can act on (`{ error, code, retryable }` from the Web route helper
 * `errorResponse`; a plain validation answer may carry `{ error }` alone). `error` is written for
 * the Agent; `code` is a stable UPPER_SNAKE code; `retryable` says whether the same request can
 * succeed later.
 */
export type AgentApiRefusal = { error: string; code?: string; retryable?: boolean };

const REFUSAL_FIELDS: ReadonlySet<string> = new Set(["error", "code", "retryable"]);
const STABLE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * Decodes a refusal body, or `undefined` when the value is anything else. A body with any other
 * field, a code outside the stable grammar, or a non-boolean `retryable` is not a refusal, so an
 * arbitrary upstream body is never mistaken for one.
 */
export function decodeAgentApiRefusal(value: unknown): AgentApiRefusal | undefined {
  if (!isRecord(value)) return undefined;
  if (Object.keys(value).some((field) => !REFUSAL_FIELDS.has(field))) return undefined;
  if (typeof value.error !== "string" || !value.error.trim()) return undefined;
  if (value.code !== undefined && (typeof value.code !== "string" || !STABLE_CODE.test(value.code)))
    return undefined;
  if (value.retryable !== undefined && typeof value.retryable !== "boolean") return undefined;
  return value as AgentApiRefusal;
}
