import type { ServerOpenVikingIdentity } from "./route-policy";
import type { OpenVikingRuntimeClient } from "./runtime-client.server";

export const OPENVIKING_TYPED_SESSION_CREATE_ROUTE = {
  method: "POST",
  path: "/api/v1/sessions",
} as const;

export const OPENVIKING_TYPED_SESSION_MESSAGES_ROUTE = {
  method: "POST",
  path: "/api/v1/sessions/{session_id}/messages/batch",
} as const;

export const OPENVIKING_TYPED_SESSION_COMMIT_ROUTE = {
  method: "POST",
  path: "/api/v1/sessions/{session_id}/commit",
} as const;

export const OPENVIKING_TYPED_SESSION_EXTRACT_ROUTE = {
  method: "POST",
  path: "/api/v1/sessions/{session_id}/extract",
} as const;

const SUCCESS_STATUSES = new Set([200, 201, 202, 409]);
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
const SANITIZED_ERROR = "openviking session extract failed";
const UNAUTHORIZED_ERROR = "sink owner is not authorized";

export type OpenVikingAdmittedSessionMessage = {
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  sourceMessageIds: readonly string[];
};

export type OpenVikingAdmittedSessionWrite = {
  sessionId: string;
  workspaceId: string;
  tags: readonly string[];
  messages: readonly OpenVikingAdmittedSessionMessage[];
};

export type OpenVikingTypedSessionExtract = {
  writeCommitAndExtract(input: {
    owner: string;
    write: OpenVikingAdmittedSessionWrite;
  }): Promise<{ ok: true; sessionId: string } | { ok: false; sanitizedError: string }>;
};

export function createOpenVikingTypedSessionExtract(deps: {
  runtime: OpenVikingRuntimeClient;
  authorizedOwner: string;
  sinkIdentity: ServerOpenVikingIdentity;
}): OpenVikingTypedSessionExtract {
  return {
    async writeCommitAndExtract(input) {
      if (input.owner !== deps.authorizedOwner) {
        return { ok: false, sanitizedError: UNAUTHORIZED_ERROR };
      }
      if (!SESSION_ID_PATTERN.test(input.write.sessionId)) {
        return { ok: false, sanitizedError: SANITIZED_ERROR };
      }
      const sessionId = input.write.sessionId;
      const created = await requestJson(deps, {
        method: OPENVIKING_TYPED_SESSION_CREATE_ROUTE.method,
        path: OPENVIKING_TYPED_SESSION_CREATE_ROUTE.path,
        body: {
          session_id: sessionId,
          memory_extraction_config: {
            events: { tags: [...input.write.tags] },
          },
        },
      });
      if (!created.ok) return created;
      const written = await requestJson(deps, {
        method: OPENVIKING_TYPED_SESSION_MESSAGES_ROUTE.method,
        path: `/api/v1/sessions/${sessionId}/messages/batch`,
        body: {
          messages: input.write.messages.map((message) => ({
            role: message.role,
            content: message.content,
            created_at: message.createdAt,
            source_message_ids: [...message.sourceMessageIds],
          })),
        },
      });
      if (!written.ok) return written;
      const committed = await requestJson(deps, {
        method: OPENVIKING_TYPED_SESSION_COMMIT_ROUTE.method,
        path: `/api/v1/sessions/${sessionId}/commit`,
        body: { keep_recent_count: 0 },
      });
      if (!committed.ok) return committed;
      const extracted = await requestJson(deps, {
        method: OPENVIKING_TYPED_SESSION_EXTRACT_ROUTE.method,
        path: `/api/v1/sessions/${sessionId}/extract`,
      });
      if (!extracted.ok) return extracted;
      return { ok: true, sessionId };
    },
  };
}

async function requestJson(
  deps: {
    runtime: OpenVikingRuntimeClient;
    sinkIdentity: ServerOpenVikingIdentity;
  },
  input: { method: string; path: string; body?: unknown },
): Promise<{ ok: true } | { ok: false; sanitizedError: string }> {
  const result = await deps.runtime.request({
    method: input.method,
    path: input.path,
    identity: deps.sinkIdentity,
    headers: input.body === undefined ? undefined : { "content-type": "application/json" },
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
  });
  if (!result.ok) return { ok: false, sanitizedError: SANITIZED_ERROR };
  try {
    await result.response.body.cancel();
  } catch {
    // Best-effort drain; status already decides the outcome.
  }
  if (SUCCESS_STATUSES.has(result.response.status)) return { ok: true };
  return { ok: false, sanitizedError: SANITIZED_ERROR };
}
