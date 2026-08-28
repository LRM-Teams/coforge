import type { AccessibleWorkspace, Credential } from "../login";

/** Business-facing cloud seam. The implementation must use CoForge RPC, not REST. */
export interface ComputerWorkspaceRpcTransport {
  listAccessible(serverUrl: string, credential: Credential): Promise<AccessibleWorkspace[]>;
  getBySlug(serverUrl: string, credential: Credential, slug: string): Promise<AccessibleWorkspace>;
}

export interface WorkspaceCatalog {
  listAccessible(serverUrl: string, credential: Credential): Promise<AccessibleWorkspace[]>;
  getBySlug: WorkspaceLookup;
}

export type WorkspaceLookup = (
  serverUrl: string,
  credential: Credential,
  slug: string,
) => Promise<AccessibleWorkspace>;

export function createWorkspaceCatalog(
  list: WorkspaceCatalog["listAccessible"],
  getBySlug: WorkspaceLookup,
): WorkspaceCatalog {
  return { listAccessible: list, getBySlug };
}

export function createWorkspaceCatalogFromRpc(
  transport: ComputerWorkspaceRpcTransport,
): WorkspaceCatalog {
  return createWorkspaceCatalog(
    (serverUrl, credential) => transport.listAccessible(serverUrl, credential),
    (serverUrl, credential, slug) => transport.getBySlug(serverUrl, credential, slug),
  );
}
