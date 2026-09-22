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
const TASK_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const SANITIZED_ERROR = "openviking session extract failed";
const UNAUTHORIZED_ERROR = "sink owner is not authorized";
const DEFAULT_COMMIT_TIMEOUT_MS = 180_000;
const COMMIT_POLL_MS = 500;

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
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  commitTimeoutMs?: number;
}): OpenVikingTypedSessionExtract {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
  const commitTimeoutMs = deps.commitTimeoutMs ?? commitTimeoutFromEnv();
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
      const taskId = commitTaskId(committed.json);
      if (taskId) {
        const settled = await waitForCommitTask(deps, taskId, { now, sleep, commitTimeoutMs });
        if (!settled.ok) return settled;
        return { ok: true, sessionId };
      }
      const extracted = await requestJson(deps, {
        method: OPENVIKING_TYPED_SESSION_EXTRACT_ROUTE.method,
        path: `/api/v1/sessions/${sessionId}/extract`,
      });
      if (!extracted.ok) return extracted;
      return { ok: true, sessionId };
    },
  };
}

function commitTimeoutFromEnv(): number {
  const raw = Number(Bun.env.COFORGE_OPENVIKING_COMMIT_TIMEOUT_MS ?? DEFAULT_COMMIT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_COMMIT_TIMEOUT_MS;
}

function commitTaskId(json: unknown): string | undefined {
  if (!json || typeof json !== "object") return undefined;
  const result = (json as { result?: unknown }).result;
  if (!result || typeof result !== "object") return undefined;
  const taskId = (result as { task_id?: unknown }).task_id;
  return typeof taskId === "string" && TASK_ID_PATTERN.test(taskId) ? taskId : undefined;
}

function taskStatus(json: unknown): string | undefined {
  if (!json || typeof json !== "object") return undefined;
  const result = (json as { result?: unknown }).result;
  if (!result || typeof result !== "object") return undefined;
  const status = (result as { status?: unknown }).status;
  return typeof status === "string" ? status : undefined;
}

async function waitForCommitTask(
  deps: {
    runtime: OpenVikingRuntimeClient;
    sinkIdentity: ServerOpenVikingIdentity;
  },
  taskId: string,
  clock: {
    now: () => number;
    sleep: (ms: number) => Promise<void>;
    commitTimeoutMs: number;
  },
): Promise<{ ok: true } | { ok: false; sanitizedError: string }> {
  const deadline = clock.now() + clock.commitTimeoutMs;
  while (clock.now() <= deadline) {
    const polled = await requestJson(deps, {
      method: "GET",
      path: `/api/v1/tasks/${taskId}`,
    });
    if (polled.ok) {
      const status = taskStatus(polled.json);
      if (status === "completed") return { ok: true };
      if (status === "failed" || status === "cancelled") {
        return { ok: false, sanitizedError: SANITIZED_ERROR };
      }
    }
    await clock.sleep(COMMIT_POLL_MS);
  }
  return { ok: false, sanitizedError: SANITIZED_ERROR };
}

async function requestJson(
  deps: {
    runtime: OpenVikingRuntimeClient;
    sinkIdentity: ServerOpenVikingIdentity;
  },
  input: { method: string; path: string; body?: unknown },
): Promise<{ ok: true; json: unknown } | { ok: false; sanitizedError: string }> {
  const result = await deps.runtime.request({
    method: input.method,
    path: input.path,
    identity: deps.sinkIdentity,
    headers: input.body === undefined ? undefined : { "content-type": "application/json" },
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
  });
  if (!result.ok) return { ok: false, sanitizedError: SANITIZED_ERROR };
  let text = "";
  try {
    text = await new Response(result.response.body).text();
  } catch {
    return { ok: false, sanitizedError: SANITIZED_ERROR };
  }
  if (!SUCCESS_STATUSES.has(result.response.status)) {
    return { ok: false, sanitizedError: SANITIZED_ERROR };
  }
  if (text.length === 0) return { ok: true, json: null };
  try {
    return { ok: true, json: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, sanitizedError: SANITIZED_ERROR };
  }
}
