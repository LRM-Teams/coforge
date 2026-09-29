import {
  createOpenVikingRuntimeClient,
  type FetchImpl,
} from "#src/server/openviking/runtime-client.server";
import type { ServerOpenVikingIdentity } from "#src/server/openviking/route-policy";
import {
  bindTypedAccountDeleteToWorkspace,
  createOpenVikingTypedAccountDelete,
  type OpenVikingTypedAccountDelete,
} from "#src/server/openviking/typed-account-delete.server";
import type { WorkspaceMemoryCleanupRemotes } from "./cleanup.server";

/** The lease owner a Workspace deletion runs its memory cleanup as, and the one the typed account
 * delete accepts. */
export const WORKSPACE_DELETION_CLEANUP_OWNER = "workspace-deletion";

/** The Workspace's OpenViking binding, as the cleanup reads and removes it. */
export type WorkspaceMemoryBindings = {
  get(workspaceId: string): Promise<{ accountId: string } | null>;
  /** Removes the binding and the identities mapped under it; removing nothing is fine. */
  remove(workspaceId: string): Promise<void>;
};

/** OpenViking as the account delete reaches it: its address and the admin identity it acts as. */
export type OpenVikingAdminAccess = {
  baseUrl: string;
  adminIdentity: ServerOpenVikingIdentity;
  fetchImpl?: FetchImpl;
};

/**
 * What a Workspace deletion removes outside its own rows: the OpenViking account, then the
 * binding that names it. A Workspace with no binding has no account, so it needs no OpenViking
 * access at all.
 *
 * The account delete runs only when handed `openviking` (an admin identity). Production passes
 * none: the Web process holds no OpenViking root credential, so a binding fails retryable and
 * stays. Where that credential lives is a security-boundary decision for the real account
 * provisioning, which needs the same one.
 */
export function createProductionWorkspaceMemoryCleanupRemotes(deps: {
  bindings: WorkspaceMemoryBindings;
  openviking?: OpenVikingAdminAccess;
}): WorkspaceMemoryCleanupRemotes {
  const { openviking } = deps;
  const accountsOf = (workspaceId: string): OpenVikingTypedAccountDelete => ({
    async deleteAccount(input) {
      if (!openviking) {
        console.warn(
          JSON.stringify({
            event: "workspace_memory_cleanup:openviking_unconfigured",
            workspace_id: workspaceId,
            cause: "admin credential not wired",
          }),
        );
        return { ok: false, sanitizedError: "openviking admin credential not wired" };
      }
      return createOpenVikingTypedAccountDelete({
        runtime: createOpenVikingRuntimeClient({
          baseUrl: openviking.baseUrl,
          fetchImpl: openviking.fetchImpl,
        }),
        authorizedOwner: WORKSPACE_DELETION_CLEANUP_OWNER,
        adminIdentity: openviking.adminIdentity,
      }).deleteAccount(input);
    },
  });
  return {
    deleteOpenVikingAccount: (input) =>
      bindTypedAccountDeleteToWorkspace({
        bindings: deps.bindings,
        accounts: accountsOf(input.workspaceId),
      })(input),
    async removeBinding(input) {
      await deps.bindings.remove(input.workspaceId);
      return { ok: true };
    },
  };
}
