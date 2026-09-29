/**
 * Complete OpenViking route catalog aggregator (G3.5).
 *
 * Adding a newly introduced upstream route:
 * 1. Upgrade the pinned OpenViking revision in
 *    `docs/research/openviking-prototype-interface-inventory.md` and add the
 *    method/path to `PINNED_OPENVIKING_ROUTES` in `route-catalog.ts`.
 * 2. Re-inventory the public runtime interface. New routes stay unclassified
 *    and therefore denied.
 * 3. Classify the route explicitly in exactly one family manifest as
 *    `data-plane | typed-control-only | denied`. Default remains deny; do not
 *    silently inherit a nearby family's disposition.
 * 4. Drift tests fail on a missing, duplicate, or overlapping pattern until
 *    that explicit classification exists.
 *
 * Duplicate-claim resolution (G3.1 ∩ G3.3):
 * - `POST /api/v1/content/reindex` is owned by the ops family (G3.3). The plan
 *   assigns reindex/consistency to ops; G3.1 no longer claims it.
 * - `POST /api/v1/system/consistency` was only ever claimed by G3.3.
 */
import type {
  CoforgeMemoryActor,
  GatewayRouteClassification,
  GatewayRoutePolicy,
  OpenVikingAccess,
} from "../contract";
import { PINNED_OPENVIKING_ROUTES, type PinnedOpenVikingRoute } from "../route-catalog";
import {
  DEFAULT_OPENVIKING_TRANSPORT_LIMITS,
  type GatewayCapability,
  type OpenVikingTransportLimits,
} from "../route-policy";
import { ADMIN_FAMILY_ROUTES, type AdminFamilyRoutePolicy } from "./route-family-admin";
import { CONTENT_FAMILY_ROUTES, type ContentFamilyRoutePolicy } from "./route-family-content";
import {
  MEMORY_SKILL_FAMILY_ROUTES,
  type MemorySkillFamilyRoute,
} from "./route-family-memory-skill";
import { ROUTE_FAMILY_OPS, type OpsFamilyRoutePolicy } from "./route-family-ops";

export type AggregatedCatalogSource = "content" | "memory-skill" | "ops" | "admin" | "residual";

export type AggregatedCapabilityRule =
  | "read_shared"
  | "write_own_or_granted"
  | "admin_workspace"
  | null;

export type AggregatedRoutePolicy = GatewayRoutePolicy & {
  family: string;
  source: AggregatedCatalogSource;
  allowedActors: readonly CoforgeMemoryActor["kind"][];
  capabilityRule: AggregatedCapabilityRule;
  limits: OpenVikingTransportLimits;
  stream: { request: boolean; response: boolean };
  note?: string;
};

export type CatalogOverlap = {
  method: string;
  path: string;
  sources: readonly string[];
};

export class OpenVikingCatalogOverlapError extends Error {
  readonly overlaps: readonly CatalogOverlap[];

  constructor(overlaps: readonly CatalogOverlap[]) {
    const detail = overlaps
      .map((entry) => `${entry.method} ${entry.path} (${entry.sources.join(", ")})`)
      .join("; ");
    super(`OpenViking route catalog has overlapping patterns: ${detail}`);
    this.name = "OpenVikingCatalogOverlapError";
    this.overlaps = overlaps;
  }
}

function isParam(segment: string): boolean {
  return segment.startsWith("{") && segment.endsWith("}");
}

function templateMatches(template: string, path: string): boolean {
  const templateSegments = template.split("/");
  const pathSegments = path.split("/");
  if (templateSegments.length !== pathSegments.length) return false;
  return templateSegments.every((segment, index) => {
    const value = pathSegments[index];
    return isParam(segment) || segment === value;
  });
}

function patternsOverlap(
  left: { method: string; path: string },
  right: { method: string; path: string },
): boolean {
  if (left.method.toUpperCase() !== right.method.toUpperCase()) return false;
  const leftSegments = left.path.split("/");
  const rightSegments = right.path.split("/");
  if (leftSegments.length !== rightSegments.length) return false;
  return leftSegments.every((segment, index) => {
    const other = rightSegments[index] ?? "";
    return isParam(segment) || isParam(other) || segment === other;
  });
}

function routeKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

function transportLimits(limits: OpenVikingTransportLimits): OpenVikingTransportLimits {
  return {
    maxRequestBytes: limits.maxRequestBytes,
    maxResponseBytes: limits.maxResponseBytes,
    timeoutMs: limits.timeoutMs,
  };
}

function normalizeContent(route: ContentFamilyRoutePolicy): AggregatedRoutePolicy {
  return {
    method: route.method,
    path: route.path,
    classification: route.classification,
    family: route.family,
    source: "content",
    allowedActors: route.allowedActors,
    capabilityRule: route.classification === "data-plane" ? route.requiredCapability : null,
    limits: transportLimits(route.limits),
    stream: route.stream,
    ...(route.controlNote ? { note: route.controlNote } : {}),
  };
}

function normalizeMemorySkill(route: MemorySkillFamilyRoute): AggregatedRoutePolicy {
  const capabilityRule: AggregatedCapabilityRule =
    route.classification !== "data-plane"
      ? null
      : route.operation === "write"
        ? "write_own_or_granted"
        : route.operation === "read"
          ? "read_shared"
          : null;
  return {
    method: route.method,
    path: route.path,
    classification: route.classification,
    family: route.family,
    source: "memory-skill",
    allowedActors: route.allowedActors,
    capabilityRule,
    limits: transportLimits(route.limits),
    stream: {
      request: route.limits.requestStreaming,
      response: route.limits.responseStreaming,
    },
    ...(route.note ? { note: route.note } : {}),
  };
}

function normalizeOps(route: OpsFamilyRoutePolicy): AggregatedRoutePolicy {
  const capabilityRule: AggregatedCapabilityRule =
    route.accessMode === "read"
      ? "read_shared"
      : route.accessMode === "write"
        ? "write_own_or_granted"
        : route.accessMode === "admin"
          ? "admin_workspace"
          : null;
  return {
    method: route.method,
    path: route.path,
    classification: route.classification,
    family: route.family,
    source: "ops",
    allowedActors: route.allowedActors,
    capabilityRule,
    limits: transportLimits(route.limits),
    stream: {
      request: false,
      response: route.responseBody === "bytes" || route.responseBody === "zip",
    },
    ...(route.notes ? { note: route.notes } : {}),
  };
}

function normalizeAdmin(route: AdminFamilyRoutePolicy): AggregatedRoutePolicy {
  return {
    method: route.method,
    path: route.path,
    classification: route.classification,
    family: route.family,
    source: "admin",
    allowedActors: route.allowedActors,
    capabilityRule: route.requiredCapability === "admin_workspace" ? "admin_workspace" : null,
    limits: transportLimits(route.limits),
    stream: { request: false, response: route.responseStream },
    ...(route.reason ? { note: route.reason } : {}),
  };
}

function residualRoute(pinned: PinnedOpenVikingRoute): AggregatedRoutePolicy {
  return {
    method: pinned.method,
    path: pinned.path,
    classification: "denied",
    family: pinned.family,
    source: "residual",
    allowedActors: [],
    capabilityRule: null,
    limits: DEFAULT_OPENVIKING_TRANSPORT_LIMITS,
    stream: { request: false, response: false },
    note: "Unclaimed pinned route; default deny until explicitly classified.",
  };
}

function findOverlaps(routes: readonly AggregatedRoutePolicy[]): CatalogOverlap[] {
  const overlaps: CatalogOverlap[] = [];
  const seen = new Set<string>();
  for (let left = 0; left < routes.length; left += 1) {
    for (let right = left + 1; right < routes.length; right += 1) {
      const a = routes[left];
      const b = routes[right];
      if (!a || !b || !patternsOverlap(a, b)) continue;
      const key = `${routeKey(a.method, a.path)}|${routeKey(b.method, b.path)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      overlaps.push({
        method: a.method,
        path: a.path,
        sources: [`${a.source}:${a.family}`, `${b.source}:${b.family}`],
      });
    }
  }
  return overlaps;
}

export function aggregateOpenVikingRouteCatalog(input?: {
  familyRoutes?: readonly AggregatedRoutePolicy[];
  pinned?: readonly PinnedOpenVikingRoute[];
}): readonly AggregatedRoutePolicy[] {
  const familyRoutes = input?.familyRoutes ?? [
    ...CONTENT_FAMILY_ROUTES.map(normalizeContent),
    ...MEMORY_SKILL_FAMILY_ROUTES.map(normalizeMemorySkill),
    ...ROUTE_FAMILY_OPS.map(normalizeOps),
    ...ADMIN_FAMILY_ROUTES.map(normalizeAdmin),
  ];
  const overlaps = findOverlaps(familyRoutes);
  if (overlaps.length > 0) throw new OpenVikingCatalogOverlapError(overlaps);

  const claimed = new Map<string, AggregatedRoutePolicy>();
  for (const route of familyRoutes) {
    claimed.set(routeKey(route.method, route.path), route);
  }

  const pinned = input?.pinned ?? PINNED_OPENVIKING_ROUTES;
  const residuals = pinned
    .filter((entry) => !claimed.has(routeKey(entry.method, entry.path)))
    .map(residualRoute);
  return [...familyRoutes, ...residuals];
}

export const AGGREGATED_OPENVIKING_ROUTE_CATALOG: readonly AggregatedRoutePolicy[] =
  aggregateOpenVikingRouteCatalog();

export const AGGREGATED_OPENVIKING_GATEWAY_CATALOG: readonly GatewayRoutePolicy[] =
  AGGREGATED_OPENVIKING_ROUTE_CATALOG.map((route) => ({
    method: route.method,
    path: route.path,
    classification: route.classification,
  }));

export function summarizeAggregatedCatalog(
  catalog: readonly AggregatedRoutePolicy[] = AGGREGATED_OPENVIKING_ROUTE_CATALOG,
): {
  total: number;
  dataPlane: number;
  typedControlOnly: number;
  denied: number;
} {
  const count = (classification: GatewayRouteClassification) =>
    catalog.filter((route) => route.classification === classification).length;
  return {
    total: catalog.length,
    dataPlane: count("data-plane"),
    typedControlOnly: count("typed-control-only"),
    denied: count("denied"),
  };
}

export function lookupAggregatedRoute(
  method: string,
  path: string,
  catalog: readonly AggregatedRoutePolicy[] = AGGREGATED_OPENVIKING_ROUTE_CATALOG,
): AggregatedRoutePolicy | undefined {
  const upper = method.toUpperCase();
  const exact = catalog.find((route) => route.method === upper && route.path === path);
  if (exact) return exact;
  return catalog.find((route) => route.method === upper && templateMatches(route.path, path));
}

export function requiredCapabilityForAggregatedRoute(
  route: AggregatedRoutePolicy,
  access: OpenVikingAccess,
): GatewayCapability | null {
  if (route.classification !== "data-plane" || route.capabilityRule === null) return null;
  if (access === "projection_only" && route.allowedActors.includes("projection_worker")) {
    return "mutate_projection";
  }
  if (route.capabilityRule === "write_own_or_granted") {
    return access === "explicit_grant" ? "write_granted" : "write_own_namespace";
  }
  return route.capabilityRule;
}

export function aggregatedRouteAllowsActor(
  route: AggregatedRoutePolicy,
  actorKind: CoforgeMemoryActor["kind"],
): boolean {
  return route.classification === "data-plane" && route.allowedActors.includes(actorKind);
}
