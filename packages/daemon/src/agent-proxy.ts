import { randomBytes } from "node:crypto";
import {
  encodeLocalReminderRequest,
  isChannelOperation,
  isValidMentionSelectorArray,
  isValidReactionEmoji,
  validateTaskRequest,
  validateWeeklyReportRequest,
  WEEKLY_REPORT_PROTOCOL_MAJOR,
  type ChannelCommand,
  type LocalAgentMessageRequest,
  type LocalInboxRequest,
  type LocalReminderRequest,
  type TaskCommand,
  type WorkspaceInfoRequest,
  type WorkspaceInfoResponse,
  type WeeklyReportCommand,
} from "@lrm/coforge-sdk/internal";
import {
  actionCardActionSchema,
  agentApiRoutes,
  validateActionCardAction,
  type AgentActionPrepareRequest,
  type AgentActionPrepareResponse,
  type AgentManualGetRequest,
  type AgentManualGetResponse,
  type AgentManualSearchRequest,
  type AgentManualSearchResponse,
  type AgentVersionResponse,
  type GitHubCredentialRequest,
  type GitHubCredentialResponse,
  type GitHubCommitTrailersRequest,
  type GitHubCommitTrailersResponse,
  type AgentUserInfoRequest,
  type AgentUserInfoResponse,
  type AgentProfileShowRequest,
  type AgentProfileShowResponse,
  type AgentProfileUpdateRequest,
  type AgentProfileUpdateResponse,
} from "@lrm/coforge-sdk/agent";
import { isAgentApiKey } from "./credentials/agent-api-key";
import { classifyAgentProxyFailure, AGENT_PROXY_CORRELATION_HEADER } from "./agent-proxy-failure";
import { AgentManualRequestError } from "./connection/agent-manual-request-error";
import { AgentUserInfoRequestError } from "./connection/agent-user-info-request-error";
import { AgentProfileRequestError } from "./connection/agent-profile-request-error";
import {
  validateWeeklyReportCollectCommand,
  type WeeklyReportCollectCommand,
  type WeeklyReportCollectFailRunningCommand,
  type WeeklyReportCollectResult,
} from "./connection/weekly-report-collect";
import {
  validateWeeklyReportKeyPointsCommand,
  type WeeklyReportKeyPointsCommand,
  type WeeklyReportKeyPointsResult,
} from "./connection/weekly-report-key-points";
import { getLogger } from "@logtape/logtape";

export type AgentProxy = {
  url: string;
  issue(agentId: string, agentApiKey: string): string;
  revoke(token: string): void;
  close(): void;
};

/** The runtime handlers a local Agent proxy dispatches to; every member but `agentMessage` is
 * optional so a daemon build can light routes up incrementally (a missing handler is a 404). */
export type AgentProxyRuntime = {
  agentMessage(
    context: string,
    request: LocalAgentMessageRequest,
    agentApiKey: string,
  ): Promise<unknown>;
  agentAttachment?(context: string, attachmentId: string, agentApiKey: string): Promise<Response>;
  agentAttachmentUpload?(context: string, request: Request, agentApiKey: string): Promise<Response>;
  agentAttachmentUploadSessionCreate?(
    context: string,
    body: unknown,
    agentApiKey: string,
  ): Promise<Response>;
  agentAttachmentUploadSessionComplete?(
    context: string,
    uploadId: string,
    agentApiKey: string,
  ): Promise<Response>;
  agentAttachmentUploadSessionCancel?(
    context: string,
    uploadId: string,
    agentApiKey: string,
  ): Promise<Response>;
  agentAttachmentUploadSessionGet?(
    context: string,
    uploadId: string,
    agentApiKey: string,
  ): Promise<Response>;
  inbox?(context: string, request: LocalInboxRequest): Promise<unknown>;
  reminder?(context: string, request: LocalReminderRequest, agentApiKey: string): Promise<unknown>;
  agentTask?(context: string, request: TaskCommand, agentApiKey: string): Promise<unknown>;
  agentChannel?(context: string, request: ChannelCommand, agentApiKey: string): Promise<unknown>;
  agentActionPrepare?(
    context: string,
    request: AgentActionPrepareRequest,
    agentApiKey: string,
  ): Promise<AgentActionPrepareResponse>;
  workspaceInfo?(
    context: string,
    request: WorkspaceInfoRequest,
    agentApiKey: string,
  ): Promise<WorkspaceInfoResponse>;
  manualGet?(
    context: string,
    request: AgentManualGetRequest,
    agentApiKey: string,
  ): Promise<AgentManualGetResponse>;
  manualSearch?(
    context: string,
    request: AgentManualSearchRequest,
    agentApiKey: string,
  ): Promise<AgentManualSearchResponse>;
  /** `coforge version`'s local-only query (ADR 0036): answered entirely by the live Daemon, never
   * forwarded to Web/backend. */
  version?(
    context: string,
    request: Record<string, never>,
    agentApiKey: string,
  ): Promise<AgentVersionResponse>;
  userInfo?(
    context: string,
    request: AgentUserInfoRequest,
    agentApiKey: string,
  ): Promise<AgentUserInfoResponse>;
  profileShow?(
    context: string,
    request: AgentProfileShowRequest,
    agentApiKey: string,
  ): Promise<AgentProfileShowResponse>;
  profileUpdate?(
    context: string,
    request: AgentProfileUpdateRequest,
    agentApiKey: string,
  ): Promise<AgentProfileUpdateResponse>;
  githubCredential?(
    context: string,
    request: GitHubCredentialRequest,
    agentApiKey: string,
  ): Promise<GitHubCredentialResponse>;
  githubCommitTrailers?(
    context: string,
    request: GitHubCommitTrailersRequest,
    agentApiKey: string,
  ): Promise<GitHubCommitTrailersResponse>;
  agentWeeklyReport?(
    context: string,
    request: WeeklyReportCommand,
    agentApiKey: string,
  ): Promise<unknown>;
  agentWeeklyReportCollect?(
    context: string,
    request: WeeklyReportCollectCommand | WeeklyReportCollectFailRunningCommand,
    agentApiKey: string,
  ): Promise<WeeklyReportCollectResult>;
  agentWeeklyReportKeyPoints?(
    context: string,
    request: WeeklyReportKeyPointsCommand,
    agentApiKey: string,
  ): Promise<WeeklyReportKeyPointsResult>;
  issueAgentContext?: (agentId: string, context?: string) => string;
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
// The four presigned-direct-upload session routes (ADR 0028) are plain JSON, so they reuse the
// JSON body path below rather than the multipart forwarding above. `create` is a fixed path;
// `complete`/`cancel`/`get` share a `/:uploadId[/complete]` prefix.
const LOCAL_UPLOAD_SESSION_CREATE_PATH = agentApiRoutes.local.attachmentUploadSessions.create.path;
const LOCAL_UPLOAD_SESSION_ROUTE_PREFIX =
  agentApiRoutes.local.attachmentUploadSessions.get.path("");
const UPLOAD_SESSION_COMPLETE_SUFFIX = "/complete";
const LOCAL_PROXY_ROUTES = agentApiRoutes.proxy;
const LOCAL_USER_ROUTE_PREFIX = LOCAL_PROXY_ROUTES.users.path("");
const MAX_BODY_BYTES = 64 * 1024;
/** Matches apps/web weekly-report-collect packMarkdown max (500_000) plus JSON framing. */
const WEEKLY_REPORT_COLLECT_MAX_BODY_BYTES = 512 * 1024;
const logger = getLogger(["coforge", "daemon", "agent-proxy"]);

/** Forwards a cloud `Response` back through the local proxy unchanged. */
function forwardResponse(response: Response): Response {
  return new Response(response.body, { status: response.status, headers: response.headers });
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

/** What a Local Proxy token stands for: the Agent, its runtime context and its Agent API key. */
type TokenBinding = { agentId: string; context: string; agentApiKey: string };
type JsonObject = Record<string, unknown>;

/**
 * How the dispatcher reads the request body before `parse` runs.
 * - `none`: no body read (GET/DELETE, and the multipart upload, which streams `request` through).
 * - `json`: size-limited JSON of any shape, no content-type requirement (upload-session create).
 * - `json-object`: requires `content-type: application/json` (else 415) and a plain object (else
 *   400); `freshnessContextMode: "withheld"` on it turns on reviewer redaction.
 */
type BodyRead = "none" | "json" | "json-object";

/** The runtime methods a route can dispatch to; each takes `(context, request, agentApiKey)`. */
type HandlerName = Exclude<keyof AgentProxyRuntime, "issueAgentContext">;
type RuntimeHandler<K extends HandlerName> = NonNullable<AgentProxyRuntime[K]>;
type RequestOf<K extends HandlerName> = Parameters<RuntimeHandler<K>>[1];
type ResultOf<K extends HandlerName> = Awaited<ReturnType<RuntimeHandler<K>>>;

type ProxyRoute<K extends HandlerName = HandlerName> = {
  /** `route_family` on a classified failure; a function when it depends on `operation`. */
  family: string | ((fields: JsonObject) => string);
  method: string;
  /** The path param (or `""` when the route has none) if the pathname belongs to this route. Must
   * not throw: a param that needs decoding is decoded in `parse`. */
  match(pathname: string): string | undefined;
  body: BodyRead;
  /** Override the default JSON body size cap (Collect packs need a larger limit). */
  maxBodyBytes?: number;
  /** The runtime method this route calls. The dispatcher looks it up, answers 404 when the runtime
   * lacks it, and always calls it with the token-bound context and Agent API key. */
  handler: K;
  /** Validates and builds the runtime request. Return a Response to reject (400/413). May throw
   * validator errors — those are classified by the dispatcher like any other failure. */
  parse(input: {
    request: Request;
    url: URL;
    param: string;
    /** The parsed body of a `json` route. */
    payload: unknown;
    /** The parsed body of a `json-object` route; empty otherwise. */
    fields: JsonObject;
    binding: TokenBinding;
  }): RequestOf<K> | Response;
  /** Defaults to `Response.json(result)`. */
  respond?(result: ResultOf<K>): Response;
  /** A domain error this route answers itself instead of the classified proxy failure. */
  domainFailure?(error: unknown): Response | undefined;
};

/** Type-checks one route entry against its own runtime method while keeping the table homogeneous. */
function defineRoute<K extends HandlerName>(route: ProxyRoute<K>): ProxyRoute {
  return route as unknown as ProxyRoute;
}

const badRequest = () => new Response("bad request", { status: 400 });
const payloadTooLarge = () => new Response("payload too large", { status: 413 });

/** A declared `content-length` that is malformed or over `maxBytes` (or absent, when required). */
function contentLengthRejected(request: Request, maxBytes: number, required: boolean): boolean {
  const contentLength = request.headers.get("content-length");
  if (!contentLength) return required;
  return !/^\d+$/.test(contentLength) || Number(contentLength) > maxBytes;
}

/**
 * The shared size-limited JSON body read: an oversized or malformed `content-length` is `413` up
 * front; otherwise the body is read and re-measured (a caller can omit or lie about
 * `content-length`), and malformed JSON is a `400` — this is the one place a `SyntaxError` becomes
 * a bare `400`; one thrown later, by a route's `parse` or by the runtime, is classified.
 */
async function readJsonBody(
  request: Request,
  maxBytes = MAX_BODY_BYTES,
): Promise<{ payload: unknown } | Response> {
  if (contentLengthRejected(request, maxBytes, false)) return payloadTooLarge();
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > maxBytes) return payloadTooLarge();
  try {
    return { payload: JSON.parse(raw) };
  } catch {
    return badRequest();
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Matches one fixed pathname; such a route has no path param. */
function exactPath(path: string) {
  return (pathname: string) => (pathname === path ? "" : undefined);
}

/** Matches `prefix + param + suffix`, yielding the still-encoded param. */
function pathParam(prefix: string, suffix = "") {
  return (pathname: string) =>
    pathname.startsWith(prefix) && pathname.endsWith(suffix)
      ? pathname.slice(prefix.length, pathname.length - suffix.length)
      : undefined;
}

/** Decodes a required path param; an undecodable or empty one is a `400`. */
function decodePathParam(param: string): string | Response {
  try {
    return decodeURIComponent(param) || badRequest();
  } catch {
    return badRequest();
  }
}

/** A family that names the payload's `operation`, e.g. `agent-api/channel-info`. */
function operationFamily(prefix: string, fallback: string) {
  return (fields: JsonObject) =>
    `${prefix}${typeof fields.operation === "string" ? fields.operation : fallback}`;
}

/** The Manual routes answer a domain error as JSON `{ ok: false, errorCode, error }` (ADR 0036,
 * Raft-aligned), so an `AgentManualRequestError` is forwarded rather than classified. */
function manualDomainFailure(error: unknown): Response | undefined {
  if (!(error instanceof AgentManualRequestError)) return undefined;
  return Response.json(
    { ok: false, errorCode: error.errorCode, error: error.message },
    { status: error.status },
  );
}

/** `user info` answers a domain error as JSON `{ ok: false, errorCode, error }` (same convention
 * as the Manual routes; ADR 0036), so an `AgentUserInfoRequestError` is forwarded rather than
 * classified. */
function userInfoDomainFailure(error: unknown): Response | undefined {
  if (!(error instanceof AgentUserInfoRequestError)) return undefined;
  return Response.json(
    { ok: false, errorCode: error.errorCode, error: error.message },
    { status: error.status },
  );
}

/** Same convention as `userInfoDomainFailure`, for `profile show`/`profile update`. */
function profileDomainFailure(error: unknown): Response | undefined {
  if (!(error instanceof AgentProfileRequestError)) return undefined;
  return Response.json(
    { ok: false, errorCode: error.errorCode, error: error.message },
    { status: error.status },
  );
}

function parseProfileUpdateFields(fields: JsonObject): AgentProfileUpdateRequest | Response {
  if (
    (fields.displayName !== undefined && typeof fields.displayName !== "string") ||
    (fields.description !== undefined && typeof fields.description !== "string")
  )
    return badRequest();
  return {
    ...(fields.displayName !== undefined ? { displayName: fields.displayName as string } : {}),
    ...(fields.description !== undefined ? { description: fields.description as string } : {}),
  };
}

function parseChannelCommand(payload: JsonObject): ChannelCommand | Response {
  if (
    typeof payload.requestId !== "string" ||
    payload.requestId.length === 0 ||
    !isChannelOperation(payload.operation) ||
    (payload.target !== undefined && typeof payload.target !== "string") ||
    (payload.name !== undefined && typeof payload.name !== "string") ||
    (payload.description !== undefined && typeof payload.description !== "string") ||
    (payload.user !== undefined && typeof payload.user !== "string") ||
    (payload.agent !== undefined && typeof payload.agent !== "string") ||
    (payload.operation !== "create" && typeof payload.target !== "string") ||
    (payload.operation === "create" && typeof payload.name !== "string") ||
    (payload.operation === "update" &&
      payload.name === undefined &&
      payload.description === undefined) ||
    (["add-member", "remove-member"].includes(payload.operation) &&
      (payload.user === undefined) === (payload.agent === undefined))
  )
    return badRequest();
  return {
    requestId: payload.requestId,
    operation: payload.operation,
    target: payload.target,
    name: payload.name,
    description: payload.description,
    user: payload.user,
    agent: payload.agent,
  };
}

function parseActionPrepareRequest(payload: JsonObject): AgentActionPrepareRequest | Response {
  if (typeof payload.target !== "string" || !payload.target) return badRequest();
  const parsedAction = actionCardActionSchema.safeParse(payload.action);
  if (!parsedAction.success) return badRequest();
  if (validateActionCardAction(parsedAction.data)) return badRequest();
  return { target: payload.target, action: parsedAction.data };
}

function parseGithubCredentialRequest(payload: JsonObject): GitHubCredentialRequest | Response {
  if (Object.keys(payload).length !== 0) return badRequest();
  return {};
}

function parseGithubCommitTrailersRequest(
  payload: JsonObject,
): GitHubCommitTrailersRequest | Response {
  if (payload.repository !== null && typeof payload.repository !== "string") return badRequest();
  return { repository: payload.repository };
}

function parseInboxRequest(
  payload: JsonObject,
  binding: TokenBinding,
): LocalInboxRequest | Response {
  if (typeof payload.requestId !== "string" || payload.operation !== "check") return badRequest();
  return { requestId: payload.requestId, context: binding.context, operation: "check" };
}

function parseMessageRequest(
  payload: JsonObject,
  binding: TokenBinding,
): LocalAgentMessageRequest | Response {
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
    (payload.sort !== undefined && payload.sort !== "relevance" && payload.sort !== "recent") ||
    (payload.operation === "search" &&
      !payload.query &&
      !payload.target &&
      !payload.sender &&
      !payload.before &&
      !payload.after) ||
    (["resolve", "react", "unreact"].includes(payload.operation as string) &&
      (typeof payload.messageId !== "string" || !MESSAGE_ID_ANCHOR.test(payload.messageId))) ||
    (["react", "unreact"].includes(payload.operation as string) &&
      (typeof payload.emoji !== "string" || !isValidReactionEmoji(payload.emoji))) ||
    (payload.attachmentIds !== undefined &&
      (!Array.isArray(payload.attachmentIds) ||
        payload.attachmentIds.some((id) => typeof id !== "string" || !UUID.test(id)))) ||
    (payload.targetConfirmed !== undefined && typeof payload.targetConfirmed !== "boolean") ||
    (payload.mentions !== undefined && !isValidMentionSelectorArray(payload.mentions))
  )
    return badRequest();
  return {
    requestId: payload.requestId,
    operation: payload.operation as LocalAgentMessageRequest["operation"],
    target: typeof payload.target === "string" ? payload.target : undefined,
    content: typeof payload.content === "string" ? payload.content : undefined,
    continueAnyway: payload.continueAnyway === true || undefined,
    sendDraft: payload.sendDraft === true || undefined,
    before: typeof payload.before === "string" ? payload.before : undefined,
    after: typeof payload.after === "string" ? payload.after : undefined,
    around: typeof payload.around === "string" ? payload.around : undefined,
    limit: typeof payload.limit === "number" ? payload.limit : undefined,
    query: typeof payload.query === "string" ? payload.query : undefined,
    sender: typeof payload.sender === "string" ? payload.sender : undefined,
    sort: payload.sort === "relevance" || payload.sort === "recent" ? payload.sort : undefined,
    offset: typeof payload.offset === "number" ? payload.offset : undefined,
    freshnessContextMode:
      payload.freshnessContextMode === "inline" || payload.freshnessContextMode === "withheld"
        ? payload.freshnessContextMode
        : undefined,
    messageId: typeof payload.messageId === "string" ? payload.messageId : undefined,
    emoji: typeof payload.emoji === "string" ? payload.emoji : undefined,
    attachmentIds: Array.isArray(payload.attachmentIds)
      ? (payload.attachmentIds as string[])
      : undefined,
    mentions: Array.isArray(payload.mentions)
      ? (payload.mentions as LocalAgentMessageRequest["mentions"])
      : undefined,
    targetConfirmed: payload.targetConfirmed === true || undefined,
    // Identity is exclusively the token binding. Never accept caller
    // supplied agentId/context fields as authorization input.
    context: binding.context,
    // The Agent API key stays in this trusted registration and is
    // never serialized into the child process request.
  };
}

/** The local Agent proxy's routes. Looking up the runtime method, passing context/key, the missing-
 * handler 404, response wrapping and failure classification are written exactly once, in the
 * dispatcher below — a route entry cannot forget any of them. */
const ROUTE_TABLE: readonly ProxyRoute[] = [
  defineRoute({
    family: "agent-api/workspace-info",
    method: LOCAL_PROXY_ROUTES.workspace.method,
    match: exactPath(LOCAL_PROXY_ROUTES.workspace.path),
    body: "none",
    handler: "workspaceInfo",
    parse: () => ({ requestId: crypto.randomUUID(), protocolMajor: 1 }),
  }),
  defineRoute({
    family: "agent-api/manual-get",
    method: LOCAL_PROXY_ROUTES.manual.get.method,
    match: exactPath(LOCAL_PROXY_ROUTES.manual.get.path),
    body: "none",
    handler: "manualGet",
    parse: ({ url }) => ({
      topic: url.searchParams.get("topic") ?? "",
      intent: url.searchParams.get("intent") ?? "",
      reason: url.searchParams.get("reason") ?? "",
    }),
    domainFailure: manualDomainFailure,
  }),
  defineRoute({
    family: "agent-api/manual-search",
    method: LOCAL_PROXY_ROUTES.manual.search.method,
    match: exactPath(LOCAL_PROXY_ROUTES.manual.search.path),
    body: "none",
    handler: "manualSearch",
    parse: ({ url }) => ({
      query: url.searchParams.get("query") ?? "",
      intent: url.searchParams.get("intent") ?? "",
      reason: url.searchParams.get("reason") ?? "",
    }),
    domainFailure: manualDomainFailure,
  }),
  defineRoute({
    family: "agent-api/version",
    method: LOCAL_PROXY_ROUTES.version.method,
    match: exactPath(LOCAL_PROXY_ROUTES.version.path),
    body: "none",
    handler: "version",
    parse: () => ({}),
  }),
  defineRoute({
    family: "agent-api/user-info",
    method: LOCAL_PROXY_ROUTES.users.method,
    match: pathParam(LOCAL_USER_ROUTE_PREFIX),
    body: "none",
    handler: "userInfo",
    parse: ({ param }) => {
      const name = decodePathParam(param);
      return name instanceof Response ? name : { name };
    },
    domainFailure: userInfoDomainFailure,
  }),
  defineRoute({
    family: "agent-api/profile-show",
    method: LOCAL_PROXY_ROUTES.profile.get.method,
    match: exactPath(LOCAL_PROXY_ROUTES.profile.get.path),
    body: "none",
    handler: "profileShow",
    parse: ({ url }) => ({ target: url.searchParams.get("target") ?? undefined }),
    domainFailure: profileDomainFailure,
  }),
  defineRoute({
    family: "agent-api/profile-update",
    method: LOCAL_PROXY_ROUTES.profile.update.method,
    match: exactPath(LOCAL_PROXY_ROUTES.profile.update.path),
    body: "json-object",
    handler: "profileUpdate",
    parse: ({ fields }) => parseProfileUpdateFields(fields),
    domainFailure: profileDomainFailure,
  }),
  defineRoute({
    family: "agent-api/attachment",
    method: "GET",
    match: pathParam(LOCAL_ATTACHMENT_ROUTE_PREFIX),
    body: "none",
    handler: "agentAttachment",
    parse: ({ param }) => decodePathParam(param),
    respond: forwardResponse,
  }),
  defineRoute({
    family: "agent-api/attachment-upload",
    method: "POST",
    match: exactPath(LOCAL_ATTACHMENT_UPLOAD_PATH),
    body: "none",
    handler: "agentAttachmentUpload",
    parse: ({ request }) =>
      contentLengthRejected(request, ATTACHMENT_UPLOAD_MAX_BYTES, true)
        ? payloadTooLarge()
        : request,
    respond: forwardResponse,
  }),
  defineRoute({
    family: "agent-api/attachment-upload-session-create",
    method: "POST",
    match: exactPath(LOCAL_UPLOAD_SESSION_CREATE_PATH),
    body: "json",
    handler: "agentAttachmentUploadSessionCreate",
    parse: ({ payload }) => payload,
    respond: forwardResponse,
  }),
  defineRoute({
    family: "agent-api/attachment-upload-session-complete",
    method: "POST",
    match: pathParam(LOCAL_UPLOAD_SESSION_ROUTE_PREFIX, UPLOAD_SESSION_COMPLETE_SUFFIX),
    body: "none",
    handler: "agentAttachmentUploadSessionComplete",
    parse: ({ param }) => decodePathParam(param),
    respond: forwardResponse,
  }),
  defineRoute({
    family: "agent-api/attachment-upload-session-get",
    method: "GET",
    match: pathParam(LOCAL_UPLOAD_SESSION_ROUTE_PREFIX),
    body: "none",
    handler: "agentAttachmentUploadSessionGet",
    parse: ({ param }) => decodePathParam(param),
    respond: forwardResponse,
  }),
  defineRoute({
    family: "agent-api/attachment-upload-session-cancel",
    method: "DELETE",
    match: pathParam(LOCAL_UPLOAD_SESSION_ROUTE_PREFIX),
    body: "none",
    handler: "agentAttachmentUploadSessionCancel",
    parse: ({ param }) => decodePathParam(param),
    respond: forwardResponse,
  }),
  defineRoute({
    family: "agent-api/reminder",
    method: LOCAL_PROXY_ROUTES.reminders.method,
    match: exactPath(LOCAL_PROXY_ROUTES.reminders.path),
    body: "json-object",
    handler: "reminder",
    parse: ({ fields, binding }) => {
      const local = { ...fields, context: binding.context } as LocalReminderRequest;
      encodeLocalReminderRequest(local);
      return local;
    },
  }),
  defineRoute({
    family: "agent-api/task",
    method: LOCAL_PROXY_ROUTES.tasks.method,
    match: exactPath(LOCAL_PROXY_ROUTES.tasks.path),
    body: "json-object",
    handler: "agentTask",
    parse: ({ fields }) => {
      const command = fields as TaskCommand;
      validateTaskRequest(command);
      return command;
    },
  }),
  defineRoute({
    family: operationFamily("agent-api/channel-", "unknown"),
    method: LOCAL_PROXY_ROUTES.channels.method,
    match: exactPath(LOCAL_PROXY_ROUTES.channels.path),
    body: "json-object",
    handler: "agentChannel",
    parse: ({ fields }) => parseChannelCommand(fields),
  }),
  defineRoute({
    family: "agent-api/action-prepare",
    method: LOCAL_PROXY_ROUTES.actionPrepare.method,
    match: exactPath(LOCAL_PROXY_ROUTES.actionPrepare.path),
    body: "json-object",
    handler: "agentActionPrepare",
    parse: ({ fields }) => parseActionPrepareRequest(fields),
  }),
  defineRoute({
    family: "agent-api/weekly-report",
    method: LOCAL_PROXY_ROUTES.weeklyReports.method,
    match: exactPath(LOCAL_PROXY_ROUTES.weeklyReports.path),
    body: "json-object",
    handler: "agentWeeklyReport",
    parse: ({ fields, binding }) => {
      const command = fields as WeeklyReportCommand;
      validateWeeklyReportRequest({
        ...command,
        protocolMajor: WEEKLY_REPORT_PROTOCOL_MAJOR,
        requestId: "local",
        workspaceId: "local",
        agentId: binding.agentId,
      });
      return command;
    },
  }),
  defineRoute({
    family: "agent-api/weekly-report-collect",
    method: LOCAL_PROXY_ROUTES.weeklyReportCollect.method,
    match: exactPath(LOCAL_PROXY_ROUTES.weeklyReportCollect.path),
    body: "json-object",
    maxBodyBytes: WEEKLY_REPORT_COLLECT_MAX_BODY_BYTES,
    handler: "agentWeeklyReportCollect",
    parse: ({ fields }) => validateWeeklyReportCollectCommand(fields) ?? badRequest(),
  }),
  defineRoute({
    family: "agent-api/weekly-report-key-points",
    method: LOCAL_PROXY_ROUTES.weeklyReportKeyPoints.method,
    match: exactPath(LOCAL_PROXY_ROUTES.weeklyReportKeyPoints.path),
    body: "json-object",
    maxBodyBytes: WEEKLY_REPORT_COLLECT_MAX_BODY_BYTES,
    handler: "agentWeeklyReportKeyPoints",
    parse: ({ fields }) => validateWeeklyReportKeyPointsCommand(fields) ?? badRequest(),
  }),
  defineRoute({
    family: "agent-api/github-credential",
    method: LOCAL_PROXY_ROUTES.githubCredentials.method,
    match: exactPath(LOCAL_PROXY_ROUTES.githubCredentials.path),
    body: "json-object",
    handler: "githubCredential",
    parse: ({ fields }) => parseGithubCredentialRequest(fields),
    respond: (result) => Response.json(result, { headers: { "cache-control": "no-store" } }),
  }),
  defineRoute({
    family: "agent-api/github-commit-trailers",
    method: LOCAL_PROXY_ROUTES.githubCommitTrailers.method,
    match: exactPath(LOCAL_PROXY_ROUTES.githubCommitTrailers.path),
    body: "json-object",
    handler: "githubCommitTrailers",
    parse: ({ fields }) => parseGithubCommitTrailersRequest(fields),
    respond: (result) => Response.json(result, { headers: { "cache-control": "no-store" } }),
  }),
  defineRoute({
    family: "agent-api/inbox",
    method: LOCAL_PROXY_ROUTES.inbox.method,
    match: exactPath(LOCAL_PROXY_ROUTES.inbox.path),
    body: "json-object",
    handler: "inbox",
    parse: ({ fields, binding }) => parseInboxRequest(fields, binding),
  }),
  defineRoute({
    family: operationFamily("agent-api/", "message"),
    method: LOCAL_PROXY_ROUTES.messages.method,
    match: exactPath(LOCAL_PROXY_ROUTES.messages.path),
    body: "json-object",
    handler: "agentMessage",
    parse: ({ fields, binding }) => parseMessageRequest(fields, binding),
  }),
];

/** The first route whose method and pathname match, along with the path param `match` found. */
function findRoute(
  method: string,
  pathname: string,
): { route: ProxyRoute; param: string } | undefined {
  for (const route of ROUTE_TABLE) {
    if (route.method !== method) continue;
    const param = route.match(pathname);
    if (param !== undefined) return { route, param };
  }
  return undefined;
}

/** One daemon-local HTTP boundary shared by all Agent child processes. */
export function startAgentProxy(input: {
  onRequest?: (request: { method: string; path: string }) => void;
  runtime: AgentProxyRuntime;
  port?: number;
}): AgentProxy {
  // This is deliberately a daemon-local Proxy token, not a cloud API key.
  // Its lifetime is bounded by the Agent process registration and it is
  // revoked when that registration stops. Keeping it stable means a long-idle
  // Agent can make its first request without receiving a new environment
  // variable or running a refresh command.
  const contexts = new Map<string, TokenBinding>();
  const server = Bun.serve({
    port: input.port ?? 0,
    async fetch(request) {
      const requestUrl = new URL(request.url);
      input.onRequest?.({ method: request.method, path: requestUrl.pathname });
      logger.info("Agent proxy request", {
        event: "agent.proxy.request",
        method: request.method,
        path: requestUrl.pathname,
      });

      const found = findRoute(request.method, requestUrl.pathname);
      if (!found) return new Response("not found", { status: 404 });
      const { route, param } = found;

      const authorization = request.headers.get("authorization");
      const candidate = authorization?.match(/^Bearer (.+)$/)?.[1];
      const token = candidate && LOCAL_PROXY_TOKEN.test(candidate) ? candidate : undefined;
      const binding = token ? contexts.get(token) : undefined;
      if (!binding) return new Response("unauthorized", { status: 401 });

      // `inbox` declares no key parameter; every other runtime method takes all three.
      const handler = input.runtime[route.handler] as
        | ((context: string, request: unknown, agentApiKey: string) => Promise<unknown>)
        | undefined;
      if (!handler) return new Response("not found", { status: 404 });

      let fields: JsonObject = {};
      let redact = false;
      try {
        let payload: unknown;
        if (route.body !== "none") {
          if (
            route.body === "json-object" &&
            request.headers.get("content-type")?.toLowerCase() !== "application/json"
          )
            return new Response("unsupported media type", { status: 415 });
          const body = await readJsonBody(request, route.maxBodyBytes ?? MAX_BODY_BYTES);
          if (body instanceof Response) return body;
          payload = body.payload;
          if (route.body === "json-object") {
            if (!isJsonObject(payload)) return badRequest();
            fields = payload;
            redact = fields.freshnessContextMode === "withheld";
          }
        }
        const parsed = route.parse({ request, url: requestUrl, param, payload, fields, binding });
        if (parsed instanceof Response) return parsed;
        // Identity is exclusively the token binding, and the Agent API key stays in this trusted
        // registration: neither is ever read from, or serialized into, the child's request.
        const result = await handler.call(
          input.runtime,
          binding.context,
          parsed,
          binding.agentApiKey,
        );
        return route.respond ? route.respond(result as never) : Response.json(result);
      } catch (error) {
        const domainFailure = route.domainFailure?.(error);
        if (domainFailure) return domainFailure;
        // Every other failure is classified: never a bare, unlabeled 502. Reviewer-isolated
        // requests still get a classified response, but with detail withheld.
        return proxyFailureResponse(error, {
          method: request.method,
          path: requestUrl.pathname,
          routeFamily: typeof route.family === "function" ? route.family(fields) : route.family,
          agentId: binding.agentId,
          redact,
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
