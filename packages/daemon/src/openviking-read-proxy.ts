/**
 * Daemon-local OpenViking read proxy: admit Agent ov_* reads, then forward the
 * frozen command envelope to an injected CoForge web URL. Identity is token-bound.
 * This module does not interpret citations or aggregate Memory Agent budgets.
 */

import {
  OPENVIKING_AGENT_PROTOCOL,
  OPENVIKING_TOOL_PROFILE,
  decodeOpenVikingAgentCommand,
  isOpenVikingAgentError,
  isOpenVikingOperationId,
  type OpenVikingAgentError,
  type OpenVikingAgentErrorCode,
  type OpenVikingAgentReadOperation,
  type OpenVikingFindCommand,
  type OpenVikingOfferCommand,
  type OpenVikingReadCommand,
  type OpenVikingSearchContextCommand,
} from "@lrm/coforge-sdk/agent";

export type OpenVikingAgentReadCommand =
  | OpenVikingFindCommand
  | OpenVikingSearchContextCommand
  | OpenVikingReadCommand;

export type OpenVikingAgentProxyCommand = OpenVikingAgentReadCommand | OpenVikingOfferCommand;

const OPENVIKING_READ_FENCES = [OPENVIKING_TOOL_PROFILE] as const;
const FORBIDDEN_PAYLOAD_KEYS = [
  "tenantToken",
  "credentialPlaintext",
  "apiKey",
  "plaintext",
] as const;
const DEFAULT_FORWARD_TIMEOUT_MS = 10_000;

export class OpenVikingReadProxyError extends Error {
  readonly status: number;
  readonly body: OpenVikingAgentError;

  constructor(body: OpenVikingAgentError, status: number) {
    super(body.error.message);
    this.name = "OpenVikingReadProxyError";
    this.status = status;
    this.body = body;
  }
}

export type OpenVikingReadAdmission =
  | { ok: true; command: OpenVikingAgentReadCommand }
  | { ok: false; status: number; body: OpenVikingAgentError };

export function allowsOpenVikingReadFence(fence: string | undefined): boolean {
  return typeof fence === "string" && (OPENVIKING_READ_FENCES as readonly string[]).includes(fence);
}

export function admitOpenVikingRead(input: {
  body: unknown;
  fence: string | undefined;
}): OpenVikingReadAdmission {
  let decoded;
  try {
    decoded = decodeOpenVikingAgentCommand(input.body);
  } catch {
    return {
      ok: false,
      status: 400,
      body: sanitizedError(
        "openviking-request-invalid",
        "OpenViking read request is invalid",
        peekOperationId(input.body),
      ),
    };
  }
  if (decoded.op === "offer") {
    return {
      ok: false,
      status: 400,
      body: sanitizedError(
        "openviking-request-invalid",
        "OpenViking mutation is not allowed",
        decoded.operationId,
      ),
    };
  }
  if (!allowsOpenVikingReadFence(input.fence)) {
    return {
      ok: false,
      status: 403,
      body: sanitizedError(
        "openviking-unauthorized",
        "OpenViking read is not allowed for this Agent profile",
        decoded.operationId,
      ),
    };
  }
  return { ok: true, command: decoded };
}

export type OpenVikingReadFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export async function forwardOpenVikingRead(input: {
  url: string;
  command: OpenVikingAgentReadCommand;
  agentApiKey: string;
  daemonApiKey: string;
  fetch?: OpenVikingReadFetch;
  timeoutMs?: number;
}): Promise<unknown> {
  const fetcher = input.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetcher(input.url, {
      method: "POST",
      signal: AbortSignal.timeout(input.timeoutMs ?? DEFAULT_FORWARD_TIMEOUT_MS),
      headers: {
        authorization: `Bearer ${input.daemonApiKey}`,
        "x-coforge-agent-api-key": `Bearer ${input.agentApiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(input.command),
    });
  } catch {
    throw unavailable(input.command.operationId, 503);
  }

  const payload: unknown = await response.json().catch(() => undefined);
  if (payloadLeaksOpenVikingCredentials(payload)) throw unavailable(input.command.operationId, 502);
  if (isOpenVikingAgentError(payload))
    throw new OpenVikingReadProxyError(payload, response.ok ? 200 : response.status);
  if (!response.ok) throw unavailable(input.command.operationId, sanitizeStatus(response.status));
  if (!isTrustedOpenVikingReadEnvelope(input.command, payload))
    throw unavailable(input.command.operationId, 502);
  return payload;
}

export type OpenVikingOfferAdmission =
  | { ok: true; command: OpenVikingOfferCommand }
  | { ok: false; status: number; body: OpenVikingAgentError };

/** Memory Offer is a CoForge channel publish, not an OpenViking write. The read proxy still refuses it. */
export function admitOpenVikingOffer(input: {
  body: unknown;
  fence: string | undefined;
}): OpenVikingOfferAdmission {
  let decoded;
  try {
    decoded = decodeOpenVikingAgentCommand(input.body);
  } catch {
    return {
      ok: false,
      status: 400,
      body: sanitizedError(
        "openviking-request-invalid",
        "OpenViking offer request is invalid",
        peekOperationId(input.body),
      ),
    };
  }
  if (decoded.op !== "offer") {
    return {
      ok: false,
      status: 400,
      body: sanitizedError(
        "openviking-request-invalid",
        "OpenViking offer request is invalid",
        decoded.operationId,
      ),
    };
  }
  if (!allowsOpenVikingReadFence(input.fence)) {
    return {
      ok: false,
      status: 403,
      body: sanitizedError(
        "openviking-unauthorized",
        "OpenViking offer is not allowed for this Agent profile",
        decoded.operationId,
      ),
    };
  }
  return { ok: true, command: decoded };
}

export async function forwardOpenVikingOffer(input: {
  url: string;
  command: OpenVikingOfferCommand;
  agentApiKey: string;
  daemonApiKey: string;
  fetch?: OpenVikingReadFetch;
  timeoutMs?: number;
}): Promise<unknown> {
  const fetcher = input.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetcher(input.url, {
      method: "POST",
      signal: AbortSignal.timeout(input.timeoutMs ?? DEFAULT_FORWARD_TIMEOUT_MS),
      headers: {
        authorization: `Bearer ${input.daemonApiKey}`,
        "x-coforge-agent-api-key": `Bearer ${input.agentApiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(input.command),
    });
  } catch {
    throw unavailable(input.command.operationId, 503);
  }

  const payload: unknown = await response.json().catch(() => undefined);
  if (payloadLeaksOpenVikingCredentials(payload)) throw unavailable(input.command.operationId, 502);
  if (isOpenVikingAgentError(payload))
    throw new OpenVikingReadProxyError(payload, response.ok ? 200 : response.status);
  if (!response.ok) throw unavailable(input.command.operationId, sanitizeStatus(response.status));
  if (!isTrustedOpenVikingOfferEnvelope(input.command, payload))
    throw unavailable(input.command.operationId, 502);
  return payload;
}

function sanitizedError(
  code: OpenVikingAgentErrorCode,
  message: string,
  operationId?: string,
): OpenVikingAgentError {
  return {
    protocol: OPENVIKING_AGENT_PROTOCOL,
    ...(operationId === undefined ? {} : { operationId }),
    error: { code, message },
  };
}

function peekOperationId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const operationId = (value as { operationId?: unknown }).operationId;
  return isOpenVikingOperationId(operationId) ? operationId : undefined;
}

function payloadLeaksOpenVikingCredentials(value: unknown): boolean {
  return Boolean(
    value &&
    typeof value === "object" &&
    FORBIDDEN_PAYLOAD_KEYS.some((key) => key in (value as object)),
  );
}

function isTrustedOpenVikingOfferEnvelope(
  command: OpenVikingOfferCommand,
  value: unknown,
): boolean {
  if (!value || typeof value !== "object") return false;
  const response = value as {
    protocol?: unknown;
    op?: unknown;
    operationId?: unknown;
    duplicate?: unknown;
    published?: unknown;
  };
  return (
    response.protocol === OPENVIKING_AGENT_PROTOCOL &&
    response.op === "offer" &&
    response.operationId === command.operationId &&
    typeof response.duplicate === "boolean" &&
    typeof response.published === "boolean"
  );
}

function isTrustedOpenVikingReadEnvelope(
  command: OpenVikingAgentReadCommand,
  value: unknown,
): value is {
  protocol: typeof OPENVIKING_AGENT_PROTOCOL;
  op: OpenVikingAgentReadOperation;
  operationId: string;
  duplicate: boolean;
} {
  if (!value || typeof value !== "object") return false;
  const response = value as {
    protocol?: unknown;
    op?: unknown;
    operationId?: unknown;
    duplicate?: unknown;
  };
  return (
    response.protocol === OPENVIKING_AGENT_PROTOCOL &&
    response.op === command.op &&
    response.operationId === command.operationId &&
    typeof response.duplicate === "boolean"
  );
}

function unavailable(operationId: string, status: number): OpenVikingReadProxyError {
  return new OpenVikingReadProxyError(
    sanitizedError(
      "openviking-runtime-unavailable",
      "OpenViking runtime is unavailable",
      operationId,
    ),
    status,
  );
}

function sanitizeStatus(status: number): number {
  return status >= 400 && status <= 599 ? status : 502;
}
