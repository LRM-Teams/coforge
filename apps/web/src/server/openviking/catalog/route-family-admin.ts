import type { CoforgeMemoryActor, GatewayRouteClassification } from "../contract";
import {
  DEFAULT_OPENVIKING_TRANSPORT_LIMITS,
  type GatewayCapability,
  type OpenVikingTransportLimits,
  templateMatches,
} from "../route-policy";

export const ADMIN_FAMILY_PINNED_FAMILIES = ["acl", "admin", "privacy"] as const;
export type AdminFamilyId = (typeof ADMIN_FAMILY_PINNED_FAMILIES)[number];

export type AdminFamilyRequestBody = "none" | "json";

export type AdminFamilyRoutePolicy = {
  method: string;
  path: string;
  family: AdminFamilyId;
  classification: GatewayRouteClassification;
  requiredCapability: GatewayCapability | null;
  allowedActors: readonly CoforgeMemoryActor["kind"][];
  requestBody: AdminFamilyRequestBody;
  responseStream: false;
  limits: OpenVikingTransportLimits;
  reason?: string;
};

const WORKSPACE_ADMINS = ["owner", "admin"] as const;

const typedControl = (
  method: string,
  path: string,
  family: AdminFamilyId,
  requestBody: AdminFamilyRequestBody,
): AdminFamilyRoutePolicy => ({
  method,
  path,
  family,
  classification: "typed-control-only",
  requiredCapability: "admin_workspace",
  allowedActors: WORKSPACE_ADMINS,
  requestBody,
  responseStream: false,
  limits: DEFAULT_OPENVIKING_TRANSPORT_LIMITS,
});

const denied = (
  method: string,
  path: string,
  family: AdminFamilyId,
  requestBody: AdminFamilyRequestBody,
  reason: string,
): AdminFamilyRoutePolicy => ({
  method,
  path,
  family,
  classification: "denied",
  requiredCapability: null,
  allowedActors: [],
  requestBody,
  responseStream: false,
  limits: DEFAULT_OPENVIKING_TRANSPORT_LIMITS,
  reason,
});

/**
 * G3.4 family manifest for account, user, group, key, ACL, and destructive
 * administration. G3.5 aggregates this file; the G2 tracer catalog stays denied.
 */
export const ADMIN_FAMILY_ROUTES: readonly AdminFamilyRoutePolicy[] = [
  typedControl("GET", "/api/v1/acl", "acl", "none"),
  typedControl("PUT", "/api/v1/acl", "acl", "json"),
  typedControl("DELETE", "/api/v1/acl", "acl", "none"),
  typedControl("POST", "/api/v1/acl/grant", "acl", "json"),
  typedControl("POST", "/api/v1/acl/revoke", "acl", "json"),

  denied(
    "GET",
    "/api/v1/admin/configuration",
    "admin",
    "none",
    "root/cross-account cluster configuration; requires typed operations channel",
  ),
  denied(
    "PATCH",
    "/api/v1/admin/configuration",
    "admin",
    "json",
    "root/cross-account cluster configuration; requires typed operations channel",
  ),
  typedControl("GET", "/api/v1/admin/accounts/{account_id}/configuration", "admin", "none"),
  typedControl("PATCH", "/api/v1/admin/accounts/{account_id}/configuration", "admin", "json"),
  denied(
    "GET",
    "/api/v1/admin/agent-evolution",
    "admin",
    "none",
    "deprecated; denied rather than generic or typed-control access",
  ),
  denied(
    "PUT",
    "/api/v1/admin/agent-evolution",
    "admin",
    "json",
    "deprecated; denied rather than generic or typed-control access",
  ),
  denied(
    "GET",
    "/api/v1/admin/accounts/{account_id}/settings",
    "admin",
    "none",
    "deprecated; denied rather than generic or typed-control access",
  ),
  denied(
    "PATCH",
    "/api/v1/admin/accounts/{account_id}/settings",
    "admin",
    "json",
    "deprecated; denied rather than generic or typed-control access",
  ),
  typedControl("GET", "/api/v1/admin/accounts/{account_id}/memory-templates", "admin", "none"),
  typedControl(
    "GET",
    "/api/v1/admin/accounts/{account_id}/memory-templates/{memory_type}",
    "admin",
    "none",
  ),
  typedControl(
    "PUT",
    "/api/v1/admin/accounts/{account_id}/memory-templates/{memory_type}",
    "admin",
    "json",
  ),
  typedControl(
    "DELETE",
    "/api/v1/admin/accounts/{account_id}/memory-templates/{memory_type}",
    "admin",
    "none",
  ),
  denied(
    "POST",
    "/api/v1/admin/accounts",
    "admin",
    "json",
    "root/cross-account account create; requires typed provisioning channel",
  ),
  denied(
    "GET",
    "/api/v1/admin/accounts",
    "admin",
    "none",
    "root/cross-account account listing; requires typed operations channel",
  ),
  denied(
    "POST",
    "/api/v1/admin/migrate",
    "admin",
    "json",
    "root legacy migration; requires typed operations channel",
  ),
  denied(
    "DELETE",
    "/api/v1/admin/accounts/{account_id}",
    "admin",
    "none",
    "root/cross-account destructive delete; requires typed cleanup channel",
  ),
  typedControl("POST", "/api/v1/admin/accounts/{account_id}/users", "admin", "json"),
  typedControl("GET", "/api/v1/admin/accounts/{account_id}/users", "admin", "none"),
  typedControl(
    "GET",
    "/api/v1/admin/accounts/{account_id}/users/{user_id}/settings",
    "admin",
    "none",
  ),
  typedControl(
    "PATCH",
    "/api/v1/admin/accounts/{account_id}/users/{user_id}/settings",
    "admin",
    "json",
  ),
  typedControl("DELETE", "/api/v1/admin/accounts/{account_id}/users/{user_id}", "admin", "none"),
  typedControl("PUT", "/api/v1/admin/accounts/{account_id}/users/{user_id}/role", "admin", "json"),
  typedControl("POST", "/api/v1/admin/accounts/{account_id}/users/{user_id}/key", "admin", "json"),
  typedControl("POST", "/api/v1/admin/accounts/{account_id}/groups", "admin", "json"),
  typedControl("GET", "/api/v1/admin/accounts/{account_id}/groups", "admin", "none"),
  typedControl("DELETE", "/api/v1/admin/accounts/{account_id}/groups/{group_id}", "admin", "none"),
  typedControl(
    "GET",
    "/api/v1/admin/accounts/{account_id}/groups/{group_id}/members",
    "admin",
    "none",
  ),
  typedControl(
    "PUT",
    "/api/v1/admin/accounts/{account_id}/groups/{group_id}/members/{user_id}",
    "admin",
    "json",
  ),
  typedControl(
    "DELETE",
    "/api/v1/admin/accounts/{account_id}/groups/{group_id}/members/{user_id}",
    "admin",
    "none",
  ),

  typedControl("GET", "/api/v1/privacy-configs", "privacy", "none"),
  typedControl("GET", "/api/v1/privacy-configs/{category}", "privacy", "none"),
  typedControl("GET", "/api/v1/privacy-configs/{category}/{target_key}", "privacy", "none"),
  typedControl(
    "GET",
    "/api/v1/privacy-configs/{category}/{target_key}/versions",
    "privacy",
    "none",
  ),
  typedControl(
    "GET",
    "/api/v1/privacy-configs/{category}/{target_key}/versions/{version}",
    "privacy",
    "none",
  ),
  typedControl("POST", "/api/v1/privacy-configs/{category}/{target_key}", "privacy", "json"),
  typedControl(
    "POST",
    "/api/v1/privacy-configs/{category}/{target_key}/activate",
    "privacy",
    "json",
  ),
];

export function lookupAdminFamilyRoute(
  method: string,
  path: string,
): AdminFamilyRoutePolicy | undefined {
  const normalizedMethod = method.toUpperCase();
  const exact = ADMIN_FAMILY_ROUTES.find(
    (entry) => entry.method === normalizedMethod && entry.path === path,
  );
  if (exact) return exact;
  return ADMIN_FAMILY_ROUTES.find(
    (entry) => entry.method === normalizedMethod && templateMatches(entry.path, path),
  );
}

export function classifyAdminFamilyRoute(method: string, path: string): GatewayRouteClassification {
  return lookupAdminFamilyRoute(method, path)?.classification ?? "denied";
}

export function adminFamilyAllowsActor(
  route: AdminFamilyRoutePolicy,
  actor: CoforgeMemoryActor["kind"],
): boolean {
  if (route.classification === "denied") return false;
  return route.allowedActors.includes(actor);
}

export function adminFamilyMemoryAgentMayRead(route: AdminFamilyRoutePolicy): boolean {
  return route.classification === "data-plane" && route.allowedActors.includes("memory_agent");
}
