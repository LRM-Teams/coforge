import type { AccessibleWorkspace, Credential } from "../login";

/** Direct lookup seam for a Workspace named by an external setup intent. */
export interface ComputerWorkspaceRpcTransport {
  getBySlug(serverUrl: string, credential: Credential, slug: string): Promise<AccessibleWorkspace>;
}

export interface WorkspaceLookup {
  getBySlug: ComputerWorkspaceRpcTransport["getBySlug"];
}

export function createWorkspaceLookup(
  transport: ComputerWorkspaceRpcTransport | ((...args: any[]) => Promise<any>),
  directLookup?: (
    serverUrl: string,
    credential: Credential,
    slug: string,
  ) => Promise<AccessibleWorkspace>,
): WorkspaceLookup {
  return {
    getBySlug:
      directLookup ??
      (typeof transport === "function"
        ? (transport as (
            serverUrl: string,
            credential: Credential,
            slug: string,
          ) => Promise<AccessibleWorkspace>)
        : (transport as ComputerWorkspaceRpcTransport).getBySlug.bind(transport)),
  };
}
