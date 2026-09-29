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
  peerId?: string;
  derived?: boolean;
};

export type OpenVikingAdmittedSessionWrite = {
  sessionId: string;
  workspaceId: string;
  tags: readonly string[];
  messages: readonly OpenVikingAdmittedSessionMessage[];
};

export const OPENVIKING_SESSION_PHASES = [
  "append_submitted",
  "append_settled",
  "commit_submitted",
  "commit_settled",
] as const;
export type OpenVikingSessionPhase = (typeof OPENVIKING_SESSION_PHASES)[number];

export type OpenVikingSessionPhaseEvent = {
  phase: OpenVikingSessionPhase;
  segmentId: string;
  sessionId: string;
  messageCount: number;
  elapsedMs: number;
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
  onPhase?: (event: OpenVikingSessionPhaseEvent) => void;
}): OpenVikingTypedSessionExtract {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
  const commitTimeoutMs = deps.commitTimeoutMs ?? commitTimeoutFromEnv();
  const onPhase = deps.onPhase ?? logSessionPhase;
  return {
    async writeCommitAndExtract(input) {
      if (input.owner !== deps.authorizedOwner) {
        return { ok: false, sanitizedError: UNAUTHORIZED_ERROR };
      }
      if (!SESSION_ID_PATTERN.test(input.write.sessionId)) {
        return { ok: false, sanitizedError: SANITIZED_ERROR };
      }
      const sessionId = input.write.sessionId;
      const started = now();
      const messageCount = input.write.messages.length;
      const segmentId = segmentIdFromWrite(input.write);
      const emit = (phase: OpenVikingSessionPhase) => {
        onPhase({
          phase,
          segmentId,
          sessionId,
          messageCount,
          elapsedMs: Math.max(0, now() - started),
        });
      };
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
      emit("append_submitted");
      const pending = await messagesPendingAppend(deps, sessionId, input.write.messages);
      if (pending.length > 0) {
        const written = await requestJson(deps, {
          method: OPENVIKING_TYPED_SESSION_MESSAGES_ROUTE.method,
          path: `/api/v1/sessions/${sessionId}/messages/batch`,
          body: {
            messages: pending.map(messagePayload),
          },
        });
        if (!written.ok) {
          const singles = await appendMessagesOneByOne(deps, sessionId, pending);
          if (!singles.ok) return singles;
        }
      }
      emit("append_settled");
      emit("commit_submitted");
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
        emit("commit_settled");
        return { ok: true, sessionId };
      }
      const extracted = await requestJson(deps, {
        method: OPENVIKING_TYPED_SESSION_EXTRACT_ROUTE.method,
        path: `/api/v1/sessions/${sessionId}/extract`,
      });
      if (!extracted.ok) return extracted;
      emit("commit_settled");
      return { ok: true, sessionId };
    },
  };
}

function logSessionPhase(event: OpenVikingSessionPhaseEvent): void {
  console.log(
    JSON.stringify({
      event: "workspace_memory_session.phase",
      phase: event.phase,
      segmentId: event.segmentId,
      sessionId: event.sessionId,
      messageCount: event.messageCount,
      elapsedMs: event.elapsedMs,
    }),
  );
}

function segmentIdFromWrite(write: OpenVikingAdmittedSessionWrite): string {
  const prefix = "coforge_segment=";
  const tagged = write.tags.find((tag) => tag.startsWith(prefix));
  if (tagged) return tagged.slice(prefix.length);
  const sessionPrefix = "coforge-";
  return write.sessionId.startsWith(sessionPrefix)
    ? write.sessionId.slice(sessionPrefix.length)
    : write.sessionId;
}

async function messagesPendingAppend(
  deps: {
    runtime: OpenVikingRuntimeClient;
    sinkIdentity: ServerOpenVikingIdentity;
  },
  sessionId: string,
  messages: readonly OpenVikingAdmittedSessionMessage[],
): Promise<readonly OpenVikingAdmittedSessionMessage[]> {
  const probed = await requestJson(deps, {
    method: "GET",
    path: `/api/v1/sessions/${sessionId}`,
  });
  if (!probed.ok) return messages;
  const existing = sourceMessageIdsFromSession(probed.json);
  return messages.filter((message) => message.sourceMessageIds.some((id) => !existing.has(id)));
}

async function appendMessagesOneByOne(
  deps: {
    runtime: OpenVikingRuntimeClient;
    sinkIdentity: ServerOpenVikingIdentity;
  },
  sessionId: string,
  messages: readonly OpenVikingAdmittedSessionMessage[],
): Promise<{ ok: true } | { ok: false; sanitizedError: string }> {
  for (const message of messages) {
    const written = await requestJson(deps, {
      method: "POST",
      path: `/api/v1/sessions/${sessionId}/messages`,
      body: messagePayload(message),
    });
    if (!written.ok) return written;
  }
  return { ok: true };
}

function sourceMessageIdsFromSession(json: unknown): Set<string> {
  const ids = new Set<string>();
  for (const message of sessionMessageList(json)) {
    if (!message || typeof message !== "object") continue;
    const row = message as Record<string, unknown>;
    const raw = row.source_message_ids ?? row.sourceMessageIds;
    if (!Array.isArray(raw)) continue;
    for (const id of raw) {
      if (typeof id === "string" && id.length > 0) ids.add(id);
    }
  }
  return ids;
}

function sessionMessageList(json: unknown): readonly unknown[] {
  if (!json || typeof json !== "object") return [];
  const root = json as Record<string, unknown>;
  const result = root.result;
  const container =
    result && typeof result === "object" ? (result as Record<string, unknown>) : root;
  const messages = container.messages;
  return Array.isArray(messages) ? messages : [];
}

function messagePayload(message: OpenVikingAdmittedSessionMessage) {
  return {
    role: message.role,
    content: message.content,
    created_at: message.createdAt,
    source_message_ids: [...message.sourceMessageIds],
    ...(message.peerId ? { peer_id: message.peerId } : {}),
    ...(message.derived ? { derived: true } : {}),
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
