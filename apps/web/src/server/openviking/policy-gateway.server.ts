import type { ObservedWorkspaceMemoryState } from "../workspace-memory/profile";
import type { SanitizedFailure } from "../workspace-memory/errors";
import type { WorkspaceMemoryProfile } from "../workspace-memory/profile";
import type { WorkspaceMemoryProfileStore } from "../workspace-memory/stores";
import { observeWorkspaceMemoryAccess } from "../workspace-memory/switching";
import {
  AGGREGATED_OPENVIKING_GATEWAY_CATALOG,
  aggregatedRouteAllowsActor,
  lookupAggregatedRoute,
  requiredCapabilityForAggregatedRoute,
} from "./catalog/aggregated-catalog";
import {
  mapMemoryActor,
  type CoforgeMemoryActor,
  type GatewayRoutePolicy,
  type OpenVikingAccess,
  type OpenVikingBinding,
} from "./contract";
import { PINNED_OPENVIKING_ROUTES } from "./route-catalog";
import {
  decideRoutePolicy,
  normalizeOpenVikingPath,
  sanitizeOpenVikingTransportFailure,
  type GatewayCapability,
  type OpenVikingTransportFailure,
  type ServerOpenVikingIdentity,
} from "./route-policy";
import type {
  OpenVikingRuntimeClient,
  OpenVikingRuntimeResponse,
  OpenVikingRuntimeResult,
} from "./runtime-client.server";
import type { OpenVikingBindingStore } from "./stores";

export const G2_TRACER_DATA_PLANE_ROUTES: readonly GatewayRoutePolicy[] = [
  { method: "POST", path: "/api/v1/search/find", classification: "data-plane" },
  { method: "POST", path: "/api/v1/resources", classification: "data-plane" },
];

const TRACER_DATA_PLANE_KEYS = new Set(
  G2_TRACER_DATA_PLANE_ROUTES.map((entry) => `${entry.method} ${entry.path}`),
);

/** G2 tracer freeze: kept for G2 regression tests. Production default is the aggregated catalog. */
export const G2_TRACER_ROUTE_CATALOG: readonly GatewayRoutePolicy[] = PINNED_OPENVIKING_ROUTES.map(
  (entry) => ({
    method: entry.method,
    path: entry.path,
    classification: TRACER_DATA_PLANE_KEYS.has(`${entry.method} ${entry.path}`)
      ? "data-plane"
      : "denied",
  }),
);

export type OpenVikingGatewayFailureCode =
  | OpenVikingTransportFailure["code"]
  | "workspace_not_ready";

export type OpenVikingGatewayFailure = {
  code: OpenVikingGatewayFailureCode;
  message: string;
  observed?: ObservedWorkspaceMemoryState;
  sanitizedFailure?: SanitizedFailure | null;
};

export type OpenVikingGatewayRequest = {
  workspaceId: string;
  method: string;
  path: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
};

export type OpenVikingGatewayResult =
  | { ok: true; response: OpenVikingRuntimeResponse }
  | { ok: false; failure: OpenVikingGatewayFailure };

export type OpenVikingGatewayAuditEvent = {
  workspaceId: string;
  actorKind: CoforgeMemoryActor["kind"];
  method: string;
  path: string;
  outcome: "allowed" | "denied";
  failureCode?: OpenVikingGatewayFailureCode;
  mappedUserId?: string;
};

export type OpenVikingPolicyGateway = {
  forward(
    actor: CoforgeMemoryActor,
    request: OpenVikingGatewayRequest,
  ): Promise<OpenVikingGatewayResult>;
};

const IDENTITY_RESPONSE_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "x-openviking-account",
  "x-openviking-user",
  "x-openviking-role",
  "x-openviking-actor-peer",
]);

export function sanitizeOpenVikingGatewayFailure(
  code: OpenVikingGatewayFailureCode,
  raw?: string,
): OpenVikingGatewayFailure {
  void raw;
  if (code === "workspace_not_ready") {
    return { code, message: "OpenViking workspace is not ready" };
  }
  return sanitizeOpenVikingTransportFailure(code);
}

export function isOpenVikingWorkspaceReady(
  profile: WorkspaceMemoryProfile | null,
  binding: OpenVikingBinding | null,
): boolean {
  return observeWorkspaceMemoryAccess({ profile, binding }).surfaces.openvikingGateway.open;
}

function requiredCapabilityFor(
  path: string,
  method: string,
  access: OpenVikingAccess,
): GatewayCapability {
  const aggregated = lookupAggregatedRoute(method, path);
  if (aggregated) {
    return requiredCapabilityForAggregatedRoute(aggregated, access) ?? "read_shared";
  }
  if (method === "POST" && path === "/api/v1/search/find") return "read_shared";
  if (method === "POST" && path === "/api/v1/resources") {
    return access === "explicit_grant" ? "write_granted" : "write_own_namespace";
  }
  return "read_shared";
}

function stripIdentityHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (IDENTITY_RESPONSE_HEADERS.has(name.toLowerCase())) continue;
    out[name] = value;
  }
  return out;
}

function sanitizeRuntimeResult(result: OpenVikingRuntimeResult): OpenVikingGatewayResult {
  if (!result.ok) return result;
  return {
    ok: true,
    response: {
      status: result.response.status,
      headers: stripIdentityHeaders(result.response.headers),
      body: result.response.body,
    },
  };
}

export function createOpenVikingPolicyGateway(deps: {
  profiles: WorkspaceMemoryProfileStore;
  bindings: OpenVikingBindingStore;
  runtime: OpenVikingRuntimeClient;
  resolveAuthorization: (credentialRef: string) => Promise<string>;
  catalog?: readonly GatewayRoutePolicy[];
  audit?: (event: OpenVikingGatewayAuditEvent) => void;
}): OpenVikingPolicyGateway {
  const catalog = deps.catalog ?? AGGREGATED_OPENVIKING_GATEWAY_CATALOG;

  return {
    async forward(actor, request) {
      const emit = (
        outcome: OpenVikingGatewayAuditEvent["outcome"],
        extra: Partial<OpenVikingGatewayAuditEvent> = {},
      ) => {
        deps.audit?.({
          workspaceId: request.workspaceId,
          actorKind: actor.kind,
          method: request.method.toUpperCase(),
          path: request.path,
          outcome,
          ...extra,
        });
      };

      const profile = await deps.profiles.get(request.workspaceId);
      const binding = await deps.bindings.get(request.workspaceId);
      const observation = observeWorkspaceMemoryAccess({ profile, binding });
      if (!observation.surfaces.openvikingGateway.open || !binding) {
        const failure: OpenVikingGatewayFailure = {
          ...sanitizeOpenVikingGatewayFailure("workspace_not_ready"),
          observed: observation.observed,
          sanitizedFailure: observation.sanitizedFailure,
        };
        emit("denied", { failureCode: failure.code });
        return { ok: false, failure };
      }

      const mapped = mapMemoryActor({ actor, binding });
      const normalized = normalizeOpenVikingPath(request.path);
      if (!normalized.ok) {
        emit("denied", { failureCode: normalized.failure.code, mappedUserId: mapped.userId });
        return normalized;
      }

      const method = request.method.toUpperCase();
      const decision = decideRoutePolicy({
        method,
        path: normalized.path,
        access: mapped.access,
        requiredCapability: requiredCapabilityFor(normalized.path, method, mapped.access),
        catalog,
      });
      if (!decision.ok) {
        emit("denied", { failureCode: decision.failure.code, mappedUserId: mapped.userId });
        return decision;
      }
      const aggregated = lookupAggregatedRoute(method, normalized.path);
      if (aggregated && !aggregatedRouteAllowsActor(aggregated, actor.kind)) {
        const failure = sanitizeOpenVikingTransportFailure("capability_denied");
        emit("denied", { failureCode: failure.code, mappedUserId: mapped.userId });
        return { ok: false, failure };
      }

      let authorization: string;
      try {
        authorization = await deps.resolveAuthorization(binding.credentialRef);
      } catch {
        const failure = sanitizeOpenVikingTransportFailure("runtime_unavailable");
        emit("denied", { failureCode: failure.code, mappedUserId: mapped.userId });
        return { ok: false, failure };
      }

      const identity: ServerOpenVikingIdentity = {
        accountId: mapped.accountId,
        userId: mapped.userId,
        role: mapped.role,
        authorization,
      };
      const result = sanitizeRuntimeResult(
        await deps.runtime.request({
          method: decision.method,
          path: decision.path,
          query: request.query,
          headers: request.headers,
          body: request.body,
          identity,
        }),
      );
      if (!result.ok) {
        emit("denied", { failureCode: result.failure.code, mappedUserId: mapped.userId });
        return result;
      }
      emit("allowed", { mappedUserId: mapped.userId, path: decision.path });
      return result;
    },
  };
}

const GATEWAY_HTTP_STATUS: Record<OpenVikingGatewayFailureCode, number> = {
  route_denied: 403,
  capability_denied: 403,
  invalid_path: 400,
  request_too_large: 413,
  response_too_large: 502,
  timeout: 504,
  runtime_unavailable: 503,
  workspace_not_ready: 503,
};

function requestHeaders(request: Request): Record<string, string> {
  const headers: Record<string, string> = {};
  request.headers.forEach((value, name) => {
    headers[name] = value;
  });
  return headers;
}

function requestQuery(request: Request): Record<string, string> | undefined {
  const query: Record<string, string> = {};
  new URL(request.url).searchParams.forEach((value, key) => {
    query[key] = value;
  });
  return Object.keys(query).length > 0 ? query : undefined;
}

export async function handleOpenVikingGatewayRequest(input: {
  actor: CoforgeMemoryActor;
  request: Request;
  workspaceId: string;
  ovPath: string;
  gateway: OpenVikingPolicyGateway;
}): Promise<Response> {
  const method = input.request.method.toUpperCase();
  const body =
    method === "GET" || method === "HEAD" || method === "DELETE"
      ? undefined
      : new Uint8Array(await input.request.arrayBuffer());
  const result = await input.gateway.forward(input.actor, {
    workspaceId: input.workspaceId,
    method,
    path: input.ovPath,
    query: requestQuery(input.request),
    headers: requestHeaders(input.request),
    body,
  });
  if (!result.ok) {
    return Response.json(result.failure, {
      status: GATEWAY_HTTP_STATUS[result.failure.code],
      headers: { "Cache-Control": "no-store" },
    });
  }
  return new Response(result.response.body, {
    status: result.response.status,
    headers: {
      ...stripIdentityHeaders(result.response.headers),
      "Cache-Control": "no-store",
    },
  });
}

export async function composeOpenVikingGatewayContext(input: {
  request: Request;
  workspaceId: string;
  ovPath: string;
}): Promise<
  | Response
  | {
      actor: CoforgeMemoryActor;
      request: Request;
      workspaceId: string;
      ovPath: string;
      gateway: OpenVikingPolicyGateway;
    }
> {
  void input.request;
  void input.workspaceId;
  void input.ovPath;
  return Response.json(sanitizeOpenVikingTransportFailure("capability_denied"), {
    status: 401,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function handleOpenVikingProxyRoute(input: {
  request: Request;
  params: { workspaceId: string; _splat?: string };
}): Promise<Response> {
  const ovPath = `/${input.params._splat ?? ""}`.replace(/\/{2,}/g, "/");
  const composed = await composeOpenVikingGatewayContext({
    request: input.request,
    workspaceId: input.params.workspaceId,
    ovPath: ovPath === "/" ? "/" : ovPath.replace(/\/$/, "") || "/",
  });
  if (composed instanceof Response) return composed;
  return handleOpenVikingGatewayRequest(composed);
}
