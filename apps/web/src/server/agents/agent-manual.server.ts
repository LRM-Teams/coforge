import type {
  AgentManualErrorCode,
  AgentManualGetResponse,
  AgentManualSearchResponse,
} from "@lrm/coforge-sdk/agent";
import {
  buildManualIndexContent,
  ensureTrailingNewline,
  findManualTopic,
  manualDocVersion,
  MANUAL_INDEX_TOPIC,
} from "#src/server/agents/manual/manual-registry.server";
import { searchManualTopics } from "#src/server/agents/manual/manual-search.server";
import {
  isValidManualTopicSlug,
  validateManualIntentReason,
  validateManualQuery,
} from "#src/server/agents/manual/manual-validation.server";

// The Raft-aligned "browse the index" guidance for a not-found topic/query is a CLI-side
// `suggestedNextAction` (see `packages/coforge/src/cli-error.ts`'s `MANUAL_NOT_FOUND_NEXT_ACTION`),
// not part of this server's error body, which stays terse like the other Agent routes.

export type AgentManualEventRepository = {
  record(event: {
    workspaceId: string;
    agentId: string;
    kind: "get" | "search";
    topicOrQuery: string;
    intent: string;
    reason: string;
    outcome: "hit" | "not_found";
    resultSlugs: string[];
  }): Promise<void>;
};

type AgentManualErrorBody = { ok: false; errorCode: AgentManualErrorCode; error: string };

export type AgentManualOutcome<Response> =
  | { status: 400; body: AgentManualErrorBody }
  | { status: 404; body: AgentManualErrorBody; recordOutcome: "not_found" }
  | { status: 200; body: Response; recordOutcome: "hit"; resultSlugs: string[] };

/** Resolves `GET /api/agent/v1/manual`. Pure and side-effect free: the caller records the event
 * and turns the outcome into an HTTP `Response`. */
export function resolveManualGet(input: {
  topic: unknown;
  intent?: unknown;
  reason?: unknown;
}): AgentManualOutcome<AgentManualGetResponse> {
  const topic = typeof input.topic === "string" ? input.topic : "";
  if (!isValidManualTopicSlug(topic))
    return {
      status: 400,
      body: {
        ok: false,
        errorCode: "knowledge_topic_invalid",
        error:
          "Topic must be lowercase letters/digits, optionally hyphen- or slash-separated " +
          "segments, at most 120 characters.",
      },
    };
  const fieldError = validateManualIntentReason(input.intent, input.reason);
  if (fieldError) return { status: 400, body: { ok: false, ...fieldError } };
  if (topic === MANUAL_INDEX_TOPIC) {
    const content = ensureTrailingNewline(buildManualIndexContent());
    return {
      status: 200,
      recordOutcome: "hit",
      resultSlugs: [],
      body: {
        ok: true,
        docId: MANUAL_INDEX_TOPIC,
        topicOrPath: topic,
        docVersion: manualDocVersion(content),
        docState: "published",
        contentType: "text/markdown",
        content,
      },
    };
  }
  const found = findManualTopic(topic);
  if (!found)
    return {
      status: 404,
      recordOutcome: "not_found",
      body: {
        ok: false,
        errorCode: "knowledge_not_found",
        error: `No Manual topic "${topic}".`,
      },
    };
  const content = ensureTrailingNewline(found.body);
  return {
    status: 200,
    recordOutcome: "hit",
    resultSlugs: [found.slug],
    body: {
      ok: true,
      docId: found.slug,
      topicOrPath: topic,
      docVersion: manualDocVersion(content),
      docState: "published",
      contentType: "text/markdown",
      content,
    },
  };
}

/** Resolves `GET /api/agent/v1/manual/search`. Same shape as `resolveManualGet` above. */
export function resolveManualSearch(input: {
  query: unknown;
  intent?: unknown;
  reason?: unknown;
}): AgentManualOutcome<AgentManualSearchResponse> {
  const queryError = validateManualQuery(input.query);
  if (queryError) return { status: 400, body: { ok: false, ...queryError } };
  const query = (input.query as string).trim();
  const fieldError = validateManualIntentReason(input.intent, input.reason);
  if (fieldError) return { status: 400, body: { ok: false, ...fieldError } };
  const results = searchManualTopics(query);
  if (results.length === 0)
    return {
      status: 404,
      recordOutcome: "not_found",
      body: {
        ok: false,
        errorCode: "knowledge_not_found",
        error: `No Manual topic matched "${query}".`,
      },
    };
  return {
    status: 200,
    recordOutcome: "hit",
    resultSlugs: results.map((result) => result.slug),
    body: { ok: true, query, scope: null, results },
  };
}

/** Records a Manual get/search call for both `hit` and `not_found` (never for an invalid-input
 * 400, which never reaches here). A logging failure must never fail the read itself — best
 * effort, caught and reported through `onError` alone. */
export async function recordManualEvent(
  repository: AgentManualEventRepository | undefined,
  scope: { workspaceId: string; agentId: string },
  event: {
    kind: "get" | "search";
    topicOrQuery: string;
    intent: string;
    reason: string;
    outcome: "hit" | "not_found";
    resultSlugs: string[];
  },
  onError: (error: unknown) => void = () => {},
): Promise<void> {
  if (!repository) return;
  try {
    await repository.record({ ...scope, ...event });
  } catch (error) {
    onError(error);
  }
}
