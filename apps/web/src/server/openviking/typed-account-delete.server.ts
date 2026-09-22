import type { ServerOpenVikingIdentity } from "./route-policy";
import type { OpenVikingRuntimeClient } from "./runtime-client.server";
import type { CleanupRemoteResult } from "../workspace-memory/cleanup.server";

export const OPENVIKING_TYPED_ACCOUNT_DELETE_ROUTE = {
  method: "DELETE",
  path: "/api/v1/admin/accounts/{account_id}",
} as const;

const SUCCESS_STATUSES = new Set([200, 202, 204, 404]);
const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
const SANITIZED_ERROR = "openviking account delete failed";
const UNAUTHORIZED_ERROR = "cleanup owner is not authorized";

export type OpenVikingTypedAccountDelete = {
  deleteAccount(input: { accountId: string; owner: string }): Promise<CleanupRemoteResult>;
};

export function createOpenVikingTypedAccountDelete(deps: {
  runtime: OpenVikingRuntimeClient;
  authorizedOwner: string;
  adminIdentity: ServerOpenVikingIdentity;
}): OpenVikingTypedAccountDelete {
  return {
    async deleteAccount(input) {
      if (input.owner !== deps.authorizedOwner) {
        return { ok: false, sanitizedError: UNAUTHORIZED_ERROR };
      }
      if (!ACCOUNT_ID_PATTERN.test(input.accountId)) {
        return { ok: false, sanitizedError: SANITIZED_ERROR };
      }
      const path = `/api/v1/admin/accounts/${input.accountId}`;
      const result = await deps.runtime.request({
        method: OPENVIKING_TYPED_ACCOUNT_DELETE_ROUTE.method,
        path,
        identity: deps.adminIdentity,
      });
      if (!result.ok) return { ok: false, sanitizedError: SANITIZED_ERROR };
      try {
        await result.response.body.cancel();
      } catch {
        // Best-effort drain; status already decides the outcome.
      }
      if (SUCCESS_STATUSES.has(result.response.status)) return { ok: true };
      return { ok: false, sanitizedError: SANITIZED_ERROR };
    },
  };
}

export function bindTypedAccountDeleteToWorkspace(deps: {
  bindings: { get(workspaceId: string): Promise<{ accountId: string } | null> };
  accounts: OpenVikingTypedAccountDelete;
}): (input: {
  workspaceId: string;
  operationId: string;
  owner: string;
}) => Promise<CleanupRemoteResult> {
  return async ({ workspaceId, owner }) => {
    const binding = await deps.bindings.get(workspaceId);
    if (!binding) return { ok: true };
    return deps.accounts.deleteAccount({ accountId: binding.accountId, owner });
  };
}
