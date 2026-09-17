import { randomBytes } from "node:crypto";
import {
  encodeLocalReminderRequest,
  isValidMentionSelectorArray,
  isValidReactionEmoji,
  validateTaskRequest,
  validateWeeklyReportRequest,
  WEEKLY_REPORT_PROTOCOL_MAJOR,
  type LocalAgentMessageRequest,
  type LocalInboxRequest,
  type LocalReminderRequest,
  type TaskCommand,
  type WorkspaceInfoRequest,
  type WorkspaceInfoResponse,
  type WeeklyReportCommand,
} from "@lrm/coforge-sdk/internal";
import {
  agentApiRoutes,
  type GitHubCredentialRequest,
  type GitHubCredentialResponse,
} from "@lrm/coforge-sdk/agent";
import { isAgentApiKey } from "./credentials/agent-api-key";
import { classifyAgentProxyFailure, AGENT_PROXY_CORRELATION_HEADER } from "./agent-proxy-failure";
import { getLogger } from "@logtape/logtape";

export type AgentProxy = {
  url: string;
  issue(agentId: string, agentApiKey: string): string;
  revoke(token: string): void;
  close(): void;
};

const LOCAL_PROXY_TOKEN = /^sfp_[A-Za-z0-9_-]{43}$/;
const MESSAGE_ID_ANCHOR =
  /^[0-9a-f]{8}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCAL_ATTACHMENT_ROUTE_PREFIX = agentApiRoutes.local.attachments.path("");
const LOCAL_ATTACHMENT_UPLOAD_PATH = agentApiRoutes.local.attachments.upload.path;
// Mirrors `apps/web`'s `ATTACHMENT_MAX_BYTES` (10 MiB) plus slack for multipart framing
// overhead (boundary markers, field headers); the daemon package cannot import from `apps/web`.
const ATTACHMENT_UPLOAD_MAX_BYTES = 10 * 1024 * 1024 + 64 * 1024;
const LOCAL_PROXY_ROUTES = agentApiRoutes.proxy;
const logger = getLogger(["coforge", "daemon", "agent-proxy"]);

/** The `route_family` tag on a classified failure: which local proxy route it came from. */
function routeFamilyFor(pathname: string, payload: Record<string, unknown> | undefined): string {
  if (pathname === LOCAL_PROXY_ROUTES.reminders.path) return "agent-api/reminder";
  if (pathname === LOCAL_PROXY_ROUTES.tasks.path) return "agent-api/task";
  if (pathname === LOCAL_PROXY_ROUTES.weeklyReports.path) return "agent-api/weekly-report";
  if (pathname === LOCAL_PROXY_ROUTES.inbox.path) return "agent-api/inbox";
  if (pathname === LOCAL_PROXY_ROUTES.messages.path) {
    const operation = payload?.operation;
    return `agent-api/${typeof operation === "string" ? operation : "message"}`;
  }
  return "agent-api/unknown";
}

/**
 * Classifies a thrown error into the local daemon proxy's JSON error contract (never a bare,
 * unlabeled 502), logs it once at WARN, and carries the same correlation id on a response header.
 */
function proxyFailureResponse(
  error: unknown,
  context: { method: string; path: string; routeFamily: string; agentId: string; redact?: boolean },
): Response {
  const classified = classifyAgentProxyFailure(error, context);
  logger.warn("Agent proxy request failed", {
    event: "agent.proxy.failure",
    ...classified.logFields,
  });
  return Response.json(classified.body, {
    status: classified.status,
    headers: { [AGENT_PROXY_CORRELATION_HEADER]: classified.body.proxy.correlation_id },
  });
}

/** One daemon-local HTTP boundary shared by all Agent child processes. */
export function startAgentProxy(input: {
  onRequest?: (request: { method: string; path: string }) => void;
  runtime: {
    agentMessage(
      context: string,
      request: LocalAgentMessageRequest,
      agentApiKey: string,
    ): Promise<unknown>;
    agentAttachment?(context: string, attachmentId: string, agentApiKey: string): Promise<Response>;
    agentAttachmentUpload?(
      context: string,
      request: Request,
      agentApiKey: string,
    ): Promise<Response>;
    inbox?(context: string, request: LocalInboxRequest): Promise<unknown>;
    reminder?(
      context: string,
      request: LocalReminderRequest,
      agentApiKey: string,
    ): Promise<unknown>;
    agentTask?(context: string, request: TaskCommand, agentApiKey: string): Promise<unknown>;
    workspaceInfo?(
      context: string,
      request: WorkspaceInfoRequest,
      agentApiKey?: string,
    ): Promise<WorkspaceInfoResponse>;
    githubCredential?(
      context: string,
      request: GitHubCredentialRequest,
      agentApiKey?: string,
    ): Promise<GitHubCredentialResponse>;
    agentWeeklyReport?(
      context: string,
      request: WeeklyReportCommand,
      agentApiKey: string,
    ): Promise<unknown>;
    issueAgentContext?: (agentId: string, context?: string) => string;
  };
  port?: number;
}): AgentProxy {
  const maxBodyBytes = 64 * 1024;
  // This is deliberately a daemon-local Proxy token, not a cloud API key.
  // Its lifetime is bounded by the Agent process registration and it is
  // revoked when that registration stops. Keeping it stable means a long-idle
  // Agent can make its first request without receiving a new environment
  // variable or running a refresh command.
  const contexts = new Map<string, { agentId: string; context: string; agentApiKey: string }>();
  const server = Bun.serve({
    port: input.port ?? 0,
    async fetch(request) {
      let reviewerMode = false;
      const requestUrl = new URL(request.url);
      input.onRequest?.({ method: request.method, path: requestUrl.pathname });
      logger.info("Agent proxy request", {
        event: "agent.proxy.request",
        method: request.method,
        path: requestUrl.pathname,
      });
      if (
        (request.method !== LOCAL_PROXY_ROUTES.workspace.method ||
          requestUrl.pathname !== LOCAL_PROXY_ROUTES.workspace.path) &&
        (request.method !== LOCAL_PROXY_ROUTES.messages.method ||
          requestUrl.pathname !== LOCAL_PROXY_ROUTES.messages.path) &&
        (request.method !== LOCAL_PROXY_ROUTES.inbox.method ||
          requestUrl.pathname !== LOCAL_PROXY_ROUTES.inbox.path) &&
        (request.method !== LOCAL_PROXY_ROUTES.reminders.method ||
          requestUrl.pathname !== LOCAL_PROXY_ROUTES.reminders.path) &&
        (request.method !== LOCAL_PROXY_ROUTES.tasks.method ||
          requestUrl.pathname !== LOCAL_PROXY_ROUTES.tasks.path) &&
        (request.method !== LOCAL_PROXY_ROUTES.weeklyReports.method ||
          requestUrl.pathname !== LOCAL_PROXY_ROUTES.weeklyReports.path) &&
        (request.method !== LOCAL_PROXY_ROUTES.githubCredentials.method ||
          requestUrl.pathname !== LOCAL_PROXY_ROUTES.githubCredentials.path) &&
        (request.method !== "GET" ||
          !requestUrl.pathname.startsWith(LOCAL_ATTACHMENT_ROUTE_PREFIX)) &&
        (request.method !== "POST" || requestUrl.pathname !== LOCAL_ATTACHMENT_UPLOAD_PATH)
      )
        return new Response("not found", { status: 404 });
      const authorization = request.headers.get("authorization");
      const candidate = authorization?.match(/^Bearer (.+)$/)?.[1];
      const token = candidate && LOCAL_PROXY_TOKEN.test(candidate) ? candidate : undefined;
      const binding = token ? contexts.get(token) : undefined;
      if (!binding) return new Response("unauthorized", { status: 401 });
      if (requestUrl.pathname === LOCAL_PROXY_ROUTES.workspace.path) {
        if (!input.runtime.workspaceInfo) return new Response("not found", { status: 404 });
        try {
          return Response.json(
            await input.runtime.workspaceInfo(binding.context, {
              requestId: crypto.randomUUID(),
              protocolMajor: 1,
            }),
          );
        } catch (error) {
          return proxyFailureResponse(error, {
            method: request.method,
            path: requestUrl.pathname,
            routeFamily: "agent-api/workspace-info",
            agentId: binding.agentId,
          });
        }
      }
      if (requestUrl.pathname.startsWith(LOCAL_ATTACHMENT_ROUTE_PREFIX)) {
        let attachmentId: string;
        try {
          attachmentId = decodeURIComponent(
            requestUrl.pathname.slice(LOCAL_ATTACHMENT_ROUTE_PREFIX.length),
          );
        } catch {
          return new Response("bad request", { status: 400 });
        }
        if (!attachmentId || !input.runtime.agentAttachment)
          return new Response("bad request", { status: 400 });
        try {
          const response = await input.runtime.agentAttachment(
            binding.context,
            attachmentId,
            binding.agentApiKey,
          );
          return new Response(response.body, {
            status: response.status,
            headers: response.headers,
          });
        } catch (error) {
          return proxyFailureResponse(error, {
            method: request.method,
            path: requestUrl.pathname,
            routeFamily: "agent-api/attachment",
            agentId: binding.agentId,
          });
        }
      }
      if (request.method === "POST" && requestUrl.pathname === LOCAL_ATTACHMENT_UPLOAD_PATH) {
        if (!input.runtime.agentAttachmentUpload) return new Response("not found", { status: 404 });
        const contentLength = request.headers.get("content-length");
        if (
          !contentLength ||
          !/^\d+$/.test(contentLength) ||
          Number(contentLength) > ATTACHMENT_UPLOAD_MAX_BYTES
        )
          return new Response("payload too large", { status: 413 });
        try {
          const response = await input.runtime.agentAttachmentUpload(
            binding.context,
            request,
            binding.agentApiKey,
          );
          return new Response(response.body, {
            status: response.status,
            headers: response.headers,
          });
        } catch (error) {
          return proxyFailureResponse(error, {
            method: request.method,
            path: requestUrl.pathname,
            routeFamily: "agent-api/attachment-upload",
            agentId: binding.agentId,
          });
        }
      }
      if (request.headers.get("content-type")?.toLowerCase() !== "application/json")
        return new Response("unsupported media type", { status: 415 });
      let payload: Record<string, unknown> | undefined;
      try {
        const contentLength = request.headers.get("content-length");
        if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > maxBodyBytes))
          return new Response("payload too large", { status: 413 });
        const raw = await request.text();
        if (new TextEncoder().encode(raw).byteLength > maxBodyBytes)
          return new Response("payload too large", { status: 413 });
        const body = JSON.parse(raw);
        if (!body || typeof body !== "object" || Array.isArray(body))
          return new Response("bad request", { status: 400 });
        payload = body as Record<string, unknown>;
        reviewerMode = payload.freshnessContextMode === "withheld";
        if (requestUrl.pathname === LOCAL_PROXY_ROUTES.reminders.path) {
          if (!input.runtime.reminder) return new Response("not found", { status: 404 });
          const local = { ...payload, context: binding.context } as LocalReminderRequest;
          encodeLocalReminderRequest(local);
          return Response.json(
            await input.runtime.reminder(binding.context, local, binding.agentApiKey),
          );
        }
        if (requestUrl.pathname === LOCAL_PROXY_ROUTES.tasks.path) {
          if (!input.runtime.agentTask) return new Response("not found", { status: 404 });
          const command = payload as TaskCommand;
          validateTaskRequest({
            ...command,
            protocolMajor: 1,
            workspaceId: "local",
            agentId: binding.agentId,
          });
          const result = await input.runtime.agentTask(
            binding.context,
            command,
            binding.agentApiKey,
          );
          return Response.json(result);
        }
        if (requestUrl.pathname === LOCAL_PROXY_ROUTES.weeklyReports.path) {
          if (!input.runtime.agentWeeklyReport) return new Response("not found", { status: 404 });
          const command = payload as WeeklyReportCommand;
          validateWeeklyReportRequest({
            ...command,
            protocolMajor: WEEKLY_REPORT_PROTOCOL_MAJOR,
            requestId: "local",
            workspaceId: "local",
            agentId: binding.agentId,
          });
          const result = await input.runtime.agentWeeklyReport(
            binding.context,
            command,
            binding.agentApiKey,
          );
          return Response.json(result);
        }
        if (requestUrl.pathname === LOCAL_PROXY_ROUTES.githubCredentials.path) {
          if (!input.runtime.githubCredential) return new Response("not found", { status: 404 });
          if (Object.keys(payload).length !== 0)
            return new Response("bad request", { status: 400 });
          return Response.json(
            await input.runtime.githubCredential(binding.context, {}, binding.agentApiKey),
            { headers: { "cache-control": "no-store" } },
          );
        }
        if (requestUrl.pathname === LOCAL_PROXY_ROUTES.inbox.path) {
          if (!input.runtime.inbox) return new Response("not found", { status: 404 });
          if (typeof payload.requestId !== "string" || payload.operation !== "check")
            return new Response("bad request", { status: 400 });
          const result = await input.runtime.inbox(binding.context, {
            requestId: payload.requestId,
            context: binding.context,
            operation: "check",
          });
          return Response.json(result);
        }
        if (
          typeof payload.requestId !== "string" ||
          payload.requestId.length === 0 ||
          ![
            "check",
            "read",
            "search",
            "send",
            "mute",
            "unmute",
            "thread-unfollow",
            "resolve",
            "react",
            "unreact",
          ].includes(payload.operation as string) ||
          (payload.continueAnyway !== undefined && typeof payload.continueAnyway !== "boolean") ||
          (payload.sendDraft !== undefined && typeof payload.sendDraft !== "boolean") ||
          (payload.freshnessContextMode !== undefined &&
            payload.freshnessContextMode !== "inline" &&
            payload.freshnessContextMode !== "withheld") ||
          [payload.before, payload.after, payload.around].some(
            (anchor) => anchor !== undefined && (typeof anchor !== "string" || anchor.length === 0),
          ) ||
          (payload.operation === "read" &&
            [payload.before, payload.after, payload.around].filter((anchor) => anchor !== undefined)
              .length > 1) ||
          (payload.operation === "search" && payload.around !== undefined) ||
          (payload.operation === "check" && payload.target !== undefined) ||
          (payload.limit !== undefined &&
            (typeof payload.limit !== "number" ||
              !Number.isInteger(payload.limit) ||
              payload.limit < 1 ||
              payload.limit > 100)) ||
          (payload.offset !== undefined &&
            (typeof payload.offset !== "number" ||
              !Number.isInteger(payload.offset) ||
              payload.offset < 0)) ||
          (payload.query !== undefined &&
            (typeof payload.query !== "string" || payload.query.trim().length === 0)) ||
          (payload.sender !== undefined &&
            (typeof payload.sender !== "string" ||
              !/^@[a-z0-9][a-z0-9_-]{0,31}$/.test(payload.sender))) ||
          (payload.sort !== undefined &&
            payload.sort !== "relevance" &&
            payload.sort !== "recent") ||
          (payload.operation === "search" &&
            !payload.query &&
            !payload.target &&
            !payload.sender &&
            !payload.before &&
            !payload.after) ||
          (["resolve", "react", "unreact"].includes(payload.operation as string) &&
            (typeof payload.messageId !== "string" ||
              !MESSAGE_ID_ANCHOR.test(payload.messageId))) ||
          (["react", "unreact"].includes(payload.operation as string) &&
            (typeof payload.emoji !== "string" || !isValidReactionEmoji(payload.emoji))) ||
          (payload.attachmentId !== undefined &&
            (typeof payload.attachmentId !== "string" || !UUID.test(payload.attachmentId))) ||
          (payload.targetConfirmed !== undefined && typeof payload.targetConfirmed !== "boolean") ||
          (payload.mentions !== undefined && !isValidMentionSelectorArray(payload.mentions))
        )
          return new Response("bad request", { status: 400 });
        const result = await input.runtime.agentMessage(
          binding.context,
          {
            requestId: payload.requestId,
            operation: payload.operation as LocalAgentMessageRequest["operation"],
            target: typeof payload.target === "string" ? payload.target : undefined,
            body: typeof payload.body === "string" ? payload.body : undefined,
            continueAnyway: payload.continueAnyway === true || undefined,
            sendDraft: payload.sendDraft === true || undefined,
            before: typeof payload.before === "string" ? payload.before : undefined,
            after: typeof payload.after === "string" ? payload.after : undefined,
            around: typeof payload.around === "string" ? payload.around : undefined,
            limit: typeof payload.limit === "number" ? payload.limit : undefined,
            query: typeof payload.query === "string" ? payload.query : undefined,
            sender: typeof payload.sender === "string" ? payload.sender : undefined,
            sort:
              payload.sort === "relevance" || payload.sort === "recent" ? payload.sort : undefined,
            offset: typeof payload.offset === "number" ? payload.offset : undefined,
            freshnessContextMode:
              payload.freshnessContextMode === "inline" ||
              payload.freshnessContextMode === "withheld"
                ? payload.freshnessContextMode
                : undefined,
            messageId: typeof payload.messageId === "string" ? payload.messageId : undefined,
            emoji: typeof payload.emoji === "string" ? payload.emoji : undefined,
            attachmentId:
              typeof payload.attachmentId === "string" ? payload.attachmentId : undefined,
            mentions: Array.isArray(payload.mentions)
              ? (payload.mentions as LocalAgentMessageRequest["mentions"])
              : undefined,
            targetConfirmed: payload.targetConfirmed === true || undefined,
            // Identity is exclusively the token binding. Never accept caller
            // supplied agentId/context fields as authorization input.
            context: binding.context,
            // The Agent API key stays in this trusted registration and is
            // never serialized into the child process request.
          },
          binding.agentApiKey,
        );
        return Response.json(result);
      } catch (error) {
        if (error instanceof SyntaxError) return new Response("bad request", { status: 400 });
        // Every other failure is classified: never a bare, unlabeled 502. Reviewer-isolated
        // requests still get a classified response, but with detail withheld.
        return proxyFailureResponse(error, {
          method: request.method,
          path: requestUrl.pathname,
          routeFamily: routeFamilyFor(requestUrl.pathname, payload),
          agentId: binding.agentId,
          redact: reviewerMode,
        });
      }
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}${LOCAL_PROXY_ROUTES.messages.path}`,
    issue(agentId, agentApiKey) {
      if (!isAgentApiKey(agentApiKey)) throw new Error("invalid Agent API key");
      const token = `sfp_${randomBytes(32).toString("base64url")}`;
      const context = input.runtime.issueAgentContext?.(agentId, token) || token;
      contexts.set(token, { agentId, context, agentApiKey });
      return token;
    },
    revoke(token) {
      contexts.delete(token);
    },
    close() {
      server.stop(true);
      contexts.clear();
    },
  };
}
