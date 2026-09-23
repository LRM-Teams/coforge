/**
 * Wire contract for `coforge manual get|search`, CoForge's server-served Agent Manual.
 * Modelled on Raft 1.0.32's `raft manual` / `/knowledge` routes: same response field names and
 * shape (`docId`, `topicOrPath`, `docVersion`, `docState`, `contentType`, `content`, `results`
 * with `slug`/`title`/`firstScreen`), CoForge's own route names (`manual`, not `knowledge`).
 */

export type AgentManualGetRequest = {
  topic: string;
  intent: string;
  reason: string;
};

export type AgentManualSearchRequest = {
  query: string;
  intent: string;
  reason: string;
};

export type AgentManualDocState = "published";

/** Response for `GET /api/agent/v1/manual`. */
export type AgentManualGetResponse = {
  ok: true;
  docId: string;
  topicOrPath: string;
  docVersion: string;
  docState: AgentManualDocState;
  contentType: "text/markdown";
  content: string;
};

export type AgentManualSearchResult = {
  slug: string;
  title: string;
  firstScreen: string;
};

/** Response for `GET /api/agent/v1/manual/search`. Raft also carries a `scope`, always `null`
 * in v1 since CoForge does not implement Raft's `--scope recipes`. */
export type AgentManualSearchResponse = {
  ok: true;
  query: string;
  scope: null;
  results: AgentManualSearchResult[];
};

export const AGENT_MANUAL_ERROR_CODES = [
  "knowledge_not_found",
  "knowledge_topic_invalid",
  "knowledge_query_invalid",
  "knowledge_intent_invalid",
  "knowledge_reason_invalid",
] as const;
export type AgentManualErrorCode = (typeof AGENT_MANUAL_ERROR_CODES)[number];

/** Error shape for both manual routes, Raft-aligned (`ok: false`), unlike this repo's other
 * sibling Agent routes. */
export type AgentManualErrorResponse = {
  ok: false;
  errorCode: AgentManualErrorCode;
  error: string;
};

function isManualErrorCode(value: unknown): value is AgentManualErrorCode {
  return (
    typeof value === "string" && (AGENT_MANUAL_ERROR_CODES as readonly string[]).includes(value)
  );
}

export function decodeAgentManualErrorResponse(
  value: unknown,
): AgentManualErrorResponse | undefined {
  if (
    !value ||
    typeof value !== "object" ||
    !("ok" in value) ||
    value.ok !== false ||
    !("errorCode" in value) ||
    !isManualErrorCode(value.errorCode) ||
    !("error" in value) ||
    typeof value.error !== "string"
  )
    return undefined;
  return { ok: false, errorCode: value.errorCode, error: value.error };
}

export function decodeAgentManualGetResponse(value: unknown): AgentManualGetResponse {
  if (
    !value ||
    typeof value !== "object" ||
    !("ok" in value) ||
    value.ok !== true ||
    !("docId" in value) ||
    typeof value.docId !== "string" ||
    !("topicOrPath" in value) ||
    typeof value.topicOrPath !== "string" ||
    !("docVersion" in value) ||
    typeof value.docVersion !== "string" ||
    !("docState" in value) ||
    value.docState !== "published" ||
    !("contentType" in value) ||
    value.contentType !== "text/markdown" ||
    !("content" in value) ||
    typeof value.content !== "string"
  )
    throw new Error("invalid Agent Manual get response");
  return {
    ok: true,
    docId: value.docId,
    topicOrPath: value.topicOrPath,
    docVersion: value.docVersion,
    docState: value.docState,
    contentType: value.contentType,
    content: value.content,
  };
}

function isManualSearchResult(value: unknown): value is AgentManualSearchResult {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof (value as { slug?: unknown }).slug === "string" &&
    typeof (value as { title?: unknown }).title === "string" &&
    typeof (value as { firstScreen?: unknown }).firstScreen === "string"
  );
}

export function decodeAgentManualSearchResponse(value: unknown): AgentManualSearchResponse {
  if (
    !value ||
    typeof value !== "object" ||
    !("ok" in value) ||
    value.ok !== true ||
    !("query" in value) ||
    typeof value.query !== "string" ||
    !("scope" in value) ||
    value.scope !== null ||
    !("results" in value) ||
    !Array.isArray(value.results) ||
    !value.results.every(isManualSearchResult)
  )
    throw new Error("invalid Agent Manual search response");
  return {
    ok: true,
    query: value.query,
    scope: null,
    results: value.results,
  };
}
