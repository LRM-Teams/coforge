import { agentApiRoutes } from "@lrm/coforge-sdk/agent";
import type { AgentManualErrorCode, AgentMentionActionErrorCode } from "@lrm/coforge-sdk/agent";
import type { ChannelOperation } from "@lrm/coforge-sdk/internal";
import { AgentMessageRequestError } from "./agent-message-request-error";
import { AgentManualRequestError } from "./agent-manual-request-error";
import { AgentMentionActionRequestError } from "./agent-mention-action-request-error";
import { AgentTransportError } from "./agent-transport-error";
import { getLogger } from "@logtape/logtape";

/** Transport helpers shared by the Agent HTTPS clients and the connection lifecycle.
 * Moved verbatim from `daemon-connection.ts`: no behaviour change, only a home. */
const logger = getLogger(["coforge", "daemon", "connection"]);

export const AGENT_RPC_TIMEOUT_MS = 10_000;

export type AgentHttpInput<Request> = {
  url: string;
  agentApiKey: string;
  daemonApiKey: string;
  request: Request;
};
export type HttpFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Maps a channel operation onto its cloud HTTP method and path, given the local target
 * (`create` carries no target: the channel does not exist yet). */
export function channelEndpointFor(
  operation: ChannelOperation,
  target: string | undefined,
): { method: "GET" | "POST" | "PATCH" | "DELETE"; path: string } {
  const routes = agentApiRoutes.cloud.channels;
  switch (operation) {
    case "create":
      return { method: routes.create.method, path: routes.create.path };
    case "info":
      return { method: routes.info.method, path: routes.info.path(target ?? "") };
    case "update":
      return { method: routes.update.method, path: routes.update.path(target ?? "") };
    case "members":
      return { method: routes.members.method, path: routes.members.path(target ?? "") };
    case "add-member":
      return { method: routes.addMember.method, path: routes.addMember.path(target ?? "") };
    case "remove-member":
      return { method: routes.removeMember.method, path: routes.removeMember.path(target ?? "") };
    case "join":
      return { method: routes.join.method, path: routes.join.path(target ?? "") };
    case "leave":
      return { method: routes.leave.method, path: routes.leave.path(target ?? "") };
    case "archive":
      return { method: routes.archive.method, path: routes.archive.path(target ?? "") };
    case "unarchive":
      return { method: routes.unarchive.method, path: routes.unarchive.path(target ?? "") };
  }
}

/** Authorization headers every Agent-scoped HTTP request carries. */
export function agentHeaders(keys: { agentApiKey: string; daemonApiKey: string }, json = false) {
  return {
    authorization: `Bearer ${keys.daemonApiKey}`,
    "x-coforge-agent-api-key": `Bearer ${keys.agentApiKey}`,
    ...(json ? { "content-type": "application/json" } : {}),
  };
}

/** Invokes the HTTP fetcher, turning any thrown error into a typed pre-response transport failure. */
export async function fetchAgentResponse(
  fetcher: HttpFetch,
  url: string | URL,
  init: RequestInit,
  what: string,
): Promise<Response> {
  try {
    return await fetcher(url, init);
  } catch (cause) {
    throw AgentTransportError.preResponseTransport(what, cause);
  }
}

/** Reads a response body as text, turning a stream failure into a typed mid-response failure. */
export async function readAgentResponseText(response: Response, what: string): Promise<string> {
  try {
    return await response.text();
  } catch (cause) {
    throw AgentTransportError.midResponseTransport(what, response.status, cause);
  }
}

/** Throws when the response is a non-2xx: a safe validation message, or a typed transport error. */
export async function assertAgentResponseOk(response: Response, what: string): Promise<void> {
  if (response.ok) return;
  const body = await readAgentResponseText(response, what);
  // Temporary diagnostics: HTTP 5xx bodies are otherwise discarded by fromRpc, which leaves only
  // SERVER_5XX at the Agent. Log a bounded snippet so the web exception can be recovered locally.
  // Field name must not be `body` — LogTape's JSON sink redacts that key, which hid every prior probe.
  if (response.status >= 500) {
    logger.error("Upstream agent HTTP 5xx body", {
      event: "agent.http.upstream_5xx_body",
      what,
      status: response.status,
      upstream_body_length: body.length,
      upstream_body_snippet: body.length > 0 ? body.slice(0, 2000) : "<empty>",
    });
  }
  throw AgentMessageRequestError.fromRpc(response.status, body);
}

/**
 * Decodes a 2xx response body as JSON, turning a decode failure or an optional shape `validate`
 * failure into a typed protocol-mismatch error — the response arrived, but the daemon could not
 * trust it. Never lets a missing required field reach the caller as a silent `undefined`.
 */
export async function readAgentResponseJson<Result>(
  response: Response,
  what: string,
  validate?: (data: unknown) => string | undefined,
): Promise<Result> {
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw AgentTransportError.protocolMismatch(
      what,
      response.status,
      "response body is not valid JSON",
    );
  }
  const shapeError = validate?.(data);
  if (shapeError) throw AgentTransportError.protocolMismatch(what, response.status, shapeError);
  return data as Result;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** GETs `url` with the request's defined `keys` copied into the query string. */
export async function getAgentJson<Result>(
  fetcher: HttpFetch,
  input: Omit<AgentHttpInput<never>, "request"> & {
    query: Record<string, string | number | undefined>;
    what: string;
    validate?: (data: unknown) => string | undefined;
  },
): Promise<Result> {
  const endpoint = new URL(input.url);
  for (const [key, value] of Object.entries(input.query))
    if (value !== undefined) endpoint.searchParams.set(key, String(value));
  const response = await fetchAgentResponse(
    fetcher,
    endpoint,
    { method: "GET", headers: agentHeaders(input) },
    input.what,
  );
  await assertAgentResponseOk(response, input.what);
  return readAgentResponseJson<Result>(response, input.what, input.validate);
}

/**
 * GETs an Agent Manual route, whose JSON error body is always `{ ok: false, errorCode, error }`
 * (Raft-aligned), unlike the plain-text/allowlisted `messages` error contract
 * `getAgentJson` assumes. A well-formed error body becomes a typed `AgentManualRequestError`
 * carrying its `errorCode` through to the CLI; anything else is a genuine transport failure.
 */
export async function getAgentManualJson<Result extends { ok: true }>(
  fetcher: HttpFetch,
  input: Omit<AgentHttpInput<never>, "request"> & {
    query: Record<string, string | undefined>;
    what: string;
  },
): Promise<Result> {
  const endpoint = new URL(input.url);
  for (const [key, value] of Object.entries(input.query))
    if (value !== undefined) endpoint.searchParams.set(key, value);
  const response = await fetchAgentResponse(
    fetcher,
    endpoint,
    { method: "GET", headers: agentHeaders(input) },
    input.what,
  );
  let data: unknown;
  try {
    data = await readAgentResponseText(response, input.what).then((text) => JSON.parse(text));
  } catch {
    throw AgentTransportError.protocolMismatch(
      input.what,
      response.status,
      "response body is not valid JSON",
    );
  }
  if (!response.ok) {
    const body = data as { errorCode?: unknown; error?: unknown } | null;
    if (body && typeof body.errorCode === "string" && typeof body.error === "string")
      throw new AgentManualRequestError(
        body.errorCode as AgentManualErrorCode,
        body.error,
        response.status,
      );
    throw AgentTransportError.upstreamHttpResponse(input.what, response.status);
  }
  return data as Result;
}

/**
 * Shared GET helper for a route whose JSON error body is always `{ ok: false, errorCode, error }`
 * (the same convention `getAgentManualJson` implements for the Manual routes; `user info` and
 * `profile show` reuse it here rather than duplicating the parsing). `makeError` turns a
 * well-formed error body into the route family's own typed error; anything else is a genuine
 * transport failure.
 */
export async function getAgentEnvelopeJson<Result extends { ok: true }>(
  fetcher: HttpFetch,
  input: Omit<AgentHttpInput<never>, "request"> & {
    query: Record<string, string | undefined>;
    what: string;
  },
  makeError: (errorCode: string, message: string, status: number) => Error,
): Promise<Result> {
  const endpoint = new URL(input.url);
  for (const [key, value] of Object.entries(input.query))
    if (value !== undefined) endpoint.searchParams.set(key, value);
  const response = await fetchAgentResponse(
    fetcher,
    endpoint,
    { method: "GET", headers: agentHeaders(input) },
    input.what,
  );
  return decodeAgentEnvelopeJson<Result>(response, input.what, makeError);
}

/**
 * Serializes an agent HTTP request body. Our own transport objects name the request's idempotency
 * key `requestId` (that name also crosses the local RPC to the CLI), while the agent HTTP API names
 * it `idempotencyKey` — so the wire carries the API's single name, and the two never ride together.
 */
/** Reads the `code` out of an agent API error body; a body that is absent, empty or not JSON is
 * simply a refusal without a named code, which is exactly what the caller already sees. */
export async function readUpstreamErrorCode(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { code?: unknown };
    return typeof body.code === "string" && body.code.length > 0 ? body.code : undefined;
  } catch {
    return undefined;
  }
}

export function agentWireBody(request: unknown): string {
  if (!request || typeof request !== "object") return JSON.stringify(request);
  const { requestId, ...rest } = request as Record<string, unknown>;
  return JSON.stringify(requestId === undefined ? rest : { ...rest, idempotencyKey: requestId });
}

export function mentionActionError(errorCode: string, message: string, status: number): Error {
  return new AgentMentionActionRequestError(
    errorCode as AgentMentionActionErrorCode,
    message,
    status,
  );
}

/** Same envelope convention as `getAgentEnvelopeJson`, for a POST route (`profile update`). */
export async function postAgentEnvelopeJson<Result extends { ok: true }>(
  fetcher: HttpFetch,
  input: Omit<AgentHttpInput<never>, "request"> & { body: unknown; what: string },
  makeError: (errorCode: string, message: string, status: number) => Error,
): Promise<Result> {
  const response = await fetchAgentResponse(
    fetcher,
    input.url,
    {
      method: "POST",
      headers: agentHeaders(input, true),
      body: agentWireBody(input.body),
    },
    input.what,
  );
  return decodeAgentEnvelopeJson<Result>(response, input.what, makeError);
}

export async function decodeAgentEnvelopeJson<Result extends { ok: true }>(
  response: Response,
  what: string,
  makeError: (errorCode: string, message: string, status: number) => Error,
): Promise<Result> {
  let data: unknown;
  try {
    data = await readAgentResponseText(response, what).then((text) => JSON.parse(text));
  } catch {
    throw AgentTransportError.protocolMismatch(
      what,
      response.status,
      "response body is not valid JSON",
    );
  }
  if (!response.ok) {
    const body = data as { errorCode?: unknown; error?: unknown } | null;
    if (body && typeof body.errorCode === "string" && typeof body.error === "string")
      throw makeError(body.errorCode, body.error, response.status);
    throw AgentTransportError.upstreamHttpResponse(what, response.status);
  }
  return data as Result;
}

export const AGENT_SEND_DECISIONS = new Set(["forward", "bypass", "local_hold", "syncing_hold"]);
export const AGENT_SEND_STATES = new Set(["sent", "held"]);

/** Validates the send route's response shape; the incident this module exists to prevent. */
export function validateAgentSendResponseShape(data: unknown): string | undefined {
  if (!isRecord(data)) return "response body is not a JSON object";
  if (typeof data.state !== "string" || !AGENT_SEND_STATES.has(data.state))
    return `response state is not one of "sent"/"held" (got ${JSON.stringify(data.state)})`;
  if (typeof data.decision !== "string" || !AGENT_SEND_DECISIONS.has(data.decision))
    return `response decision is not one of "forward"/"bypass"/"local_hold"/"syncing_hold" (got ${JSON.stringify(data.decision)})`;
  if (data.state === "held" && !Array.isArray(data.heldMessages))
    return "response is missing the heldMessages array";
  return undefined;
}

export function validateAgentMessageArrayShape(field: string) {
  return (data: unknown): string | undefined =>
    isRecord(data) && Array.isArray(data[field])
      ? undefined
      : `response is missing the ${field} array`;
}
