import {
  classifyGatewayRoute,
  isClientIdentityHeader,
  type GatewayRouteClassification,
  type GatewayRoutePolicy,
  type OpenVikingAccess,
  type OpenVikingMappedIdentity,
} from "./contract";
import { PINNED_OPENVIKING_ROUTES } from "./route-catalog";

export const OPENVIKING_TRANSPORT_FAILURE_CODES = [
  "route_denied",
  "invalid_path",
  "capability_denied",
  "request_too_large",
  "response_too_large",
  "timeout",
  "runtime_unavailable",
] as const;
export type OpenVikingTransportFailureCode = (typeof OPENVIKING_TRANSPORT_FAILURE_CODES)[number];

export type OpenVikingTransportFailure = {
  code: OpenVikingTransportFailureCode;
  message: string;
};

const FAILURE_MESSAGES: Record<OpenVikingTransportFailureCode, string> = {
  route_denied: "OpenViking route is not allowed",
  invalid_path: "OpenViking path is invalid",
  capability_denied: "OpenViking capability is not allowed",
  request_too_large: "OpenViking request exceeds the size limit",
  response_too_large: "OpenViking response exceeds the size limit",
  timeout: "OpenViking runtime timed out",
  runtime_unavailable: "OpenViking runtime is unavailable",
};

export function sanitizeOpenVikingTransportFailure(
  code: OpenVikingTransportFailureCode,
  raw?: string,
): OpenVikingTransportFailure {
  void raw;
  return { code, message: FAILURE_MESSAGES[code] };
}

export const DEFAULT_OPENVIKING_TRANSPORT_LIMITS = {
  maxRequestBytes: 1_048_576,
  maxResponseBytes: 8_388_608,
  timeoutMs: 15_000,
} as const;

export type OpenVikingTransportLimits = {
  maxRequestBytes: number;
  maxResponseBytes: number;
  timeoutMs: number;
};

export type GatewayCapability =
  | "admin_workspace"
  | "write_own_namespace"
  | "write_granted"
  | "read_shared"
  | "mutate_projection";

const ACCESS_CAPABILITIES: Record<OpenVikingAccess, readonly GatewayCapability[]> = {
  workspace_admin: ["admin_workspace", "write_own_namespace", "write_granted", "read_shared"],
  own_namespace: ["write_own_namespace", "read_shared"],
  explicit_grant: ["write_granted", "read_shared"],
  readonly_shared: ["read_shared"],
  projection_only: ["mutate_projection"],
};

export function capabilitiesForAccess(access: OpenVikingAccess): readonly GatewayCapability[] {
  return ACCESS_CAPABILITIES[access];
}

export function actorHasCapability(
  access: OpenVikingAccess,
  capability: GatewayCapability,
): boolean {
  return ACCESS_CAPABILITIES[access].includes(capability);
}

const DENIED_CATALOG: readonly GatewayRoutePolicy[] = PINNED_OPENVIKING_ROUTES.map((entry) => ({
  method: entry.method,
  path: entry.path,
  classification: "denied" as const,
}));

const MAX_PATH_BYTES = 2_048;
const MAX_DECODE_ROUNDS = 3;

export type NormalizedOpenVikingPath =
  | { ok: true; path: string }
  | { ok: false; failure: OpenVikingTransportFailure };

export function normalizeOpenVikingPath(raw: string): NormalizedOpenVikingPath {
  const invalid: NormalizedOpenVikingPath = {
    ok: false,
    failure: sanitizeOpenVikingTransportFailure("invalid_path"),
  };
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_PATH_BYTES) return invalid;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw) || raw.startsWith("//") || !raw.startsWith("/")) {
    return invalid;
  }
  if (raw.includes("\\") || raw.includes("\0") || raw.includes("?")) return invalid;

  let decoded = raw;
  for (let round = 0; round < MAX_DECODE_ROUNDS; round += 1) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return invalid;
    }
    if (next === decoded) break;
    decoded = next;
    if (round === MAX_DECODE_ROUNDS - 1) {
      try {
        if (decodeURIComponent(decoded) !== decoded) return invalid;
      } catch {
        return invalid;
      }
    }
  }

  if (
    decoded.includes("\\") ||
    decoded.includes("\0") ||
    decoded.includes("?") ||
    decoded.includes("://") ||
    decoded.startsWith("//")
  ) {
    return invalid;
  }

  const segments = decoded.split("/");
  if (segments[0] !== "") return invalid;
  const normalized: string[] = [];
  for (let index = 1; index < segments.length; index += 1) {
    const segment = segments[index];
    if (index === segments.length - 1 && segment === "") continue;
    if (segment === "" || segment === "." || segment === "..") return invalid;
    normalized.push(segment);
  }
  return { ok: true, path: normalized.length === 0 ? "/" : `/${normalized.join("/")}` };
}

/** Whether a path segment is a URL-template parameter, written `{name}`. */
export function isParam(segment: string): boolean {
  return segment.startsWith("{") && segment.endsWith("}");
}

/**
 * A catalog family's route projects to a gateway policy by taking exactly its method, path and
 * classification: every family route type carries those three, and a family's own fields (limits,
 * actors, operation) are not the gateway's business.
 */
export function toFamilyGatewayPolicies<T extends GatewayRoutePolicy>(
  routes: readonly T[],
): GatewayRoutePolicy[] {
  return routes.map(({ method, path, classification }) => ({ method, path, classification }));
}

/**
 * Whether `path` matches the URL `template`: same number of segments, and every segment is either a
 * parameter or equal to the template's. The route catalog's one matcher; callers reach it here.
 */
export function templateMatches(template: string, path: string): boolean {
  const templateSegments = template.split("/");
  const pathSegments = path.split("/");
  if (templateSegments.length !== pathSegments.length) return false;
  return templateSegments.every(
    (segment, index) => isParam(segment) || segment === pathSegments[index],
  );
}

export function classifyOpenVikingRoute(
  route: { method: string; path: string },
  catalog: readonly GatewayRoutePolicy[] = DENIED_CATALOG,
): GatewayRouteClassification {
  const method = route.method.toUpperCase();
  const exact = classifyGatewayRoute({ method, path: route.path }, catalog);
  if (exact !== "denied") return exact;
  const templated = catalog.find(
    (entry) => entry.method.toUpperCase() === method && templateMatches(entry.path, route.path),
  );
  return templated?.classification ?? "denied";
}

export type RoutePolicyDecision =
  | {
      ok: true;
      method: string;
      path: string;
      classification: Exclude<GatewayRouteClassification, "denied">;
    }
  | { ok: false; failure: OpenVikingTransportFailure };

export function decideRoutePolicy(input: {
  method: string;
  path: string;
  access: OpenVikingAccess;
  requiredCapability: GatewayCapability;
  catalog?: readonly GatewayRoutePolicy[];
}): RoutePolicyDecision {
  const normalized = normalizeOpenVikingPath(input.path);
  if (!normalized.ok) return normalized;
  const method = input.method.toUpperCase();
  const classification = classifyOpenVikingRoute(
    { method, path: normalized.path },
    input.catalog ?? DENIED_CATALOG,
  );
  if (classification !== "data-plane") {
    return { ok: false, failure: sanitizeOpenVikingTransportFailure("route_denied") };
  }
  if (!actorHasCapability(input.access, input.requiredCapability)) {
    return { ok: false, failure: sanitizeOpenVikingTransportFailure("capability_denied") };
  }
  return { ok: true, method, path: normalized.path, classification };
}

export type ServerOpenVikingIdentity = Pick<
  OpenVikingMappedIdentity,
  "accountId" | "userId" | "role"
> & {
  authorization: string;
};

function headerEntries(headers: Record<string, string>): Array<[string, string]> {
  return Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]);
}

export function applyIdentityHeaderPolicy(input: {
  incoming: Record<string, string>;
  serverIdentity: ServerOpenVikingIdentity;
}): Record<string, string> {
  const forwarded: Record<string, string> = {};
  for (const [name, value] of headerEntries(input.incoming)) {
    if (isClientIdentityHeader(name)) continue;
    forwarded[name] = value;
  }
  forwarded.authorization = input.serverIdentity.authorization;
  forwarded["x-openviking-account"] = input.serverIdentity.accountId;
  forwarded["x-openviking-user"] = input.serverIdentity.userId;
  forwarded["x-openviking-role"] = input.serverIdentity.role === "admin" ? "admin" : "user";
  return forwarded;
}

export type TransportSizeKind = "request" | "response";

export function decideTransportSize(input: {
  kind: TransportSizeKind;
  bytes: number;
  limits?: OpenVikingTransportLimits;
}): { ok: true } | { ok: false; failure: OpenVikingTransportFailure } {
  const limits = input.limits ?? DEFAULT_OPENVIKING_TRANSPORT_LIMITS;
  const max = input.kind === "request" ? limits.maxRequestBytes : limits.maxResponseBytes;
  if (!Number.isFinite(input.bytes) || input.bytes < 0 || input.bytes > max) {
    return {
      ok: false,
      failure: sanitizeOpenVikingTransportFailure(
        input.kind === "request" ? "request_too_large" : "response_too_large",
      ),
    };
  }
  return { ok: true };
}
