import {
  mapMemoryActor,
  type CoforgeMemoryActor,
  type GatewayRouteClassification,
  type GatewayRoutePolicy,
  type OpenVikingAccess,
} from "../contract";
import {
  DEFAULT_OPENVIKING_TRANSPORT_LIMITS,
  decideRoutePolicy,
  normalizeOpenVikingPath,
  sanitizeOpenVikingTransportFailure,
  type GatewayCapability,
  type OpenVikingTransportFailure,
  type OpenVikingTransportLimits,
  templateMatches,
} from "../route-policy";

export type OpsRouteFamily =
  | "task"
  | "watch"
  | "snapshot"
  | "pack"
  | "observer"
  | "stats"
  | "reindex"
  | "consistency";

export type OpsFamilyAccessMode = "read" | "write" | "admin" | "none";
export type OpsFamilyBodyKind = "none" | "json" | "bytes" | "zip";

export type OpsFamilyRoutePolicy = {
  method: string;
  path: string;
  family: OpsRouteFamily;
  classification: GatewayRouteClassification;
  accessMode: OpsFamilyAccessMode;
  allowedActors: readonly CoforgeMemoryActor["kind"][];
  limits: OpenVikingTransportLimits;
  requestBody: OpsFamilyBodyKind;
  responseBody: OpsFamilyBodyKind;
  notes?: string;
};

export type OpsFamilyRouteDecision =
  | {
      ok: true;
      method: string;
      path: string;
      classification: "data-plane";
    }
  | {
      ok: false;
      classification: GatewayRouteClassification;
      failure: OpenVikingTransportFailure;
    };

const WORKSPACE_ACTORS = ["owner", "admin", "member", "agent"] as const;
const ADMIN_ACTORS = ["owner", "admin"] as const;

const SNAPSHOT_SHOW_LIMITS = {
  maxRequestBytes: DEFAULT_OPENVIKING_TRANSPORT_LIMITS.maxRequestBytes,
  maxResponseBytes: 33_554_432,
  timeoutMs: 30_000,
} as const satisfies OpenVikingTransportLimits;

const SNAPSHOT_DIFF_LIMITS = {
  maxRequestBytes: DEFAULT_OPENVIKING_TRANSPORT_LIMITS.maxRequestBytes,
  maxResponseBytes: 22_020_096,
  timeoutMs: 30_000,
} as const satisfies OpenVikingTransportLimits;

const PACK_EXPORT_LIMITS = {
  maxRequestBytes: DEFAULT_OPENVIKING_TRANSPORT_LIMITS.maxRequestBytes,
  maxResponseBytes: 67_108_864,
  timeoutMs: 60_000,
} as const satisfies OpenVikingTransportLimits;

const PACK_BACKUP_LIMITS = {
  maxRequestBytes: DEFAULT_OPENVIKING_TRANSPORT_LIMITS.maxRequestBytes,
  maxResponseBytes: 67_108_864,
  timeoutMs: 120_000,
} as const satisfies OpenVikingTransportLimits;

const LONG_CONTROL_LIMITS = {
  maxRequestBytes: DEFAULT_OPENVIKING_TRANSPORT_LIMITS.maxRequestBytes,
  maxResponseBytes: DEFAULT_OPENVIKING_TRANSPORT_LIMITS.maxResponseBytes,
  timeoutMs: 120_000,
} as const satisfies OpenVikingTransportLimits;

const CONSISTENCY_LIMITS = {
  maxRequestBytes: DEFAULT_OPENVIKING_TRANSPORT_LIMITS.maxRequestBytes,
  maxResponseBytes: DEFAULT_OPENVIKING_TRANSPORT_LIMITS.maxResponseBytes,
  timeoutMs: 60_000,
} as const satisfies OpenVikingTransportLimits;

const IDENTITY_BINDING = {
  accountId: "acct-policy",
  serviceIdentityId: "svc-policy",
};

function classify(
  method: string,
  path: string,
  family: OpsRouteFamily,
  classification: GatewayRouteClassification,
  accessMode: OpsFamilyAccessMode,
  extras: {
    allowedActors?: readonly CoforgeMemoryActor["kind"][];
    limits?: OpenVikingTransportLimits;
    requestBody?: OpsFamilyBodyKind;
    responseBody?: OpsFamilyBodyKind;
    notes?: string;
  } = {},
): OpsFamilyRoutePolicy {
  const allowedActors =
    extras.allowedActors ??
    (classification === "data-plane"
      ? WORKSPACE_ACTORS
      : classification === "typed-control-only"
        ? ADMIN_ACTORS
        : []);
  return {
    method,
    path,
    family,
    classification,
    accessMode,
    allowedActors,
    limits: extras.limits ?? DEFAULT_OPENVIKING_TRANSPORT_LIMITS,
    requestBody: extras.requestBody ?? (method === "GET" || method === "DELETE" ? "none" : "json"),
    responseBody: extras.responseBody ?? "json",
    ...(extras.notes ? { notes: extras.notes } : {}),
  };
}

/** G3.3 manifest. G3.5 aggregates this; G2 tracer catalog stays unchanged. */
export const ROUTE_FAMILY_OPS: readonly OpsFamilyRoutePolicy[] = [
  classify("GET", "/api/v1/tasks", "task", "data-plane", "read"),
  classify("GET", "/api/v1/tasks/{task_id}", "task", "data-plane", "read"),
  classify("POST", "/api/v1/tasks/{task_id}/cancel", "task", "data-plane", "write"),
  classify("GET", "/api/v1/watches", "watch", "data-plane", "read"),
  classify("GET", "/api/v1/watches/{task_id}", "watch", "data-plane", "read"),
  classify("PATCH", "/api/v1/watches", "watch", "data-plane", "write"),
  classify("PATCH", "/api/v1/watches/{task_id}", "watch", "data-plane", "write"),
  classify("DELETE", "/api/v1/watches", "watch", "data-plane", "write"),
  classify("DELETE", "/api/v1/watches/{task_id}", "watch", "data-plane", "write"),
  classify("POST", "/api/v1/watches/trigger", "watch", "data-plane", "write"),
  classify("POST", "/api/v1/watches/{task_id}/trigger", "watch", "data-plane", "write"),
  classify("POST", "/api/v1/snapshot/commit", "snapshot", "data-plane", "write"),
  classify("GET", "/api/v1/snapshot/log", "snapshot", "data-plane", "read"),
  classify("GET", "/api/v1/snapshot/show", "snapshot", "data-plane", "read", {
    limits: SNAPSHOT_SHOW_LIMITS,
    responseBody: "bytes",
  }),
  classify("GET", "/api/v1/snapshot/diff", "snapshot", "data-plane", "read", {
    limits: SNAPSHOT_DIFF_LIMITS,
  }),
  classify("POST", "/api/v1/snapshot/restore", "snapshot", "typed-control-only", "admin", {
    limits: LONG_CONTROL_LIMITS,
    notes: "Destructive restore plus reindex side effects; typed control only.",
  }),
  classify("GET", "/api/v1/snapshot/ignore", "snapshot", "typed-control-only", "admin", {
    notes: "Account-level ADMIN .ovgitignore; typed control only.",
  }),
  classify("PUT", "/api/v1/snapshot/ignore", "snapshot", "typed-control-only", "admin", {
    notes: "Account-level ADMIN .ovgitignore; typed control only.",
  }),
  classify("DELETE", "/api/v1/snapshot/ignore", "snapshot", "typed-control-only", "admin", {
    notes: "Account-level ADMIN .ovgitignore; typed control only.",
  }),
  classify("POST", "/api/v1/pack/export", "pack", "data-plane", "write", {
    limits: PACK_EXPORT_LIMITS,
    responseBody: "zip",
  }),
  classify("POST", "/api/v1/pack/import", "pack", "typed-control-only", "admin", {
    limits: LONG_CONTROL_LIMITS,
    notes: "Destructive overwrite/migrate; typed control only.",
  }),
  classify("POST", "/api/v1/pack/backup", "pack", "typed-control-only", "admin", {
    limits: PACK_BACKUP_LIMITS,
    responseBody: "zip",
    notes:
      "Account-wide ADMIN/ROOT dump; stays off the generic gateway. Needs a typed backup channel.",
  }),
  classify("POST", "/api/v1/pack/restore", "pack", "typed-control-only", "admin", {
    limits: LONG_CONTROL_LIMITS,
    notes:
      "Account-wide ADMIN/ROOT restore; stays off the generic gateway. Needs a typed restore channel.",
  }),
  classify("GET", "/api/v1/observer/queue", "observer", "typed-control-only", "admin", {
    notes: "Operational telemetry; typed ops channel, not generic data-plane.",
  }),
  classify("GET", "/api/v1/observer/vikingdb", "observer", "typed-control-only", "admin", {
    notes: "Operational telemetry; typed ops channel, not generic data-plane.",
  }),
  classify("GET", "/api/v1/observer/models", "observer", "typed-control-only", "admin", {
    notes: "Operational telemetry; typed ops channel, not generic data-plane.",
  }),
  classify("GET", "/api/v1/observer/lock", "observer", "typed-control-only", "admin", {
    notes: "Operational telemetry; typed ops channel, not generic data-plane.",
  }),
  classify("GET", "/api/v1/observer/retrieval", "observer", "typed-control-only", "admin", {
    notes: "Operational telemetry; typed ops channel, not generic data-plane.",
  }),
  classify("GET", "/api/v1/observer/filesystem", "observer", "typed-control-only", "admin", {
    notes: "Operational telemetry; typed ops channel, not generic data-plane.",
  }),
  classify("GET", "/api/v1/observer/system", "observer", "typed-control-only", "admin", {
    notes: "Operational telemetry; typed ops channel, not generic data-plane.",
  }),
  classify("GET", "/api/v1/stats/memories", "stats", "denied", "none", {
    notes: "source-only; denied until documented. Not a Memory Agent read.",
  }),
  classify("GET", "/api/v1/stats/sessions/{session_id}", "stats", "denied", "none", {
    notes: "source-only; denied until documented. Not a Memory Agent read.",
  }),
  classify("POST", "/api/v1/content/reindex", "reindex", "typed-control-only", "admin", {
    limits: LONG_CONTROL_LIMITS,
    notes: "Admin maintenance including prune_orphans; typed control only.",
  }),
  classify("POST", "/api/v1/system/consistency", "consistency", "typed-control-only", "admin", {
    limits: CONSISTENCY_LIMITS,
    notes: "Index/FS diagnostic; typed ops channel.",
  }),
];

export const OPS_FAMILY_GATEWAY_POLICIES: readonly GatewayRoutePolicy[] = ROUTE_FAMILY_OPS.map(
  (entry) => ({
    method: entry.method,
    path: entry.path,
    classification: entry.classification,
  }),
);

export function lookupOpsFamilyRoute(
  method: string,
  path: string,
): OpsFamilyRoutePolicy | undefined {
  const methodUpper = method.toUpperCase();
  const exact = ROUTE_FAMILY_OPS.find(
    (entry) => entry.method === methodUpper && entry.path === path,
  );
  if (exact) return exact;
  const normalized = normalizeOpenVikingPath(path);
  const candidate = normalized.ok ? normalized.path : path;
  return ROUTE_FAMILY_OPS.find(
    (entry) => entry.method === methodUpper && templateMatches(entry.path, candidate),
  );
}

function requiredCapabilityFor(
  accessMode: OpsFamilyAccessMode,
  access: OpenVikingAccess,
): GatewayCapability | null {
  if (accessMode === "none") return null;
  if (accessMode === "read") return "read_shared";
  if (accessMode === "admin") return "admin_workspace";
  return access === "explicit_grant" ? "write_granted" : "write_own_namespace";
}

export function decideOpsFamilyRoute(input: {
  actor: CoforgeMemoryActor;
  method: string;
  path: string;
}): OpsFamilyRouteDecision {
  const normalized = normalizeOpenVikingPath(input.path);
  if (!normalized.ok) {
    return { ok: false, classification: "denied", failure: normalized.failure };
  }
  const entry = lookupOpsFamilyRoute(input.method, normalized.path);
  if (!entry) {
    return {
      ok: false,
      classification: "denied",
      failure: sanitizeOpenVikingTransportFailure("route_denied"),
    };
  }
  if (entry.classification !== "data-plane") {
    return {
      ok: false,
      classification: entry.classification,
      failure: sanitizeOpenVikingTransportFailure("route_denied"),
    };
  }
  if (!entry.allowedActors.includes(input.actor.kind)) {
    return {
      ok: false,
      classification: entry.classification,
      failure: sanitizeOpenVikingTransportFailure("capability_denied"),
    };
  }
  const mapped = mapMemoryActor({ actor: input.actor, binding: IDENTITY_BINDING });
  const requiredCapability = requiredCapabilityFor(entry.accessMode, mapped.access);
  if (!requiredCapability) {
    return {
      ok: false,
      classification: entry.classification,
      failure: sanitizeOpenVikingTransportFailure("capability_denied"),
    };
  }
  const decision = decideRoutePolicy({
    method: input.method,
    path: normalized.path,
    access: mapped.access,
    requiredCapability,
    catalog: OPS_FAMILY_GATEWAY_POLICIES,
  });
  if (!decision.ok) {
    return { ok: false, classification: entry.classification, failure: decision.failure };
  }
  return {
    ok: true,
    method: decision.method,
    path: decision.path,
    classification: "data-plane",
  };
}
