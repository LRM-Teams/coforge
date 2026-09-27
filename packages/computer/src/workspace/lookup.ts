import type { AccessibleWorkspace, Credential } from "#src/login";

/** Direct lookup seam for a Workspace named by an external setup intent. */
export interface ComputerWorkspaceRpcTransport {
  getBySlug(serverUrl: string, credential: Credential, slug: string): Promise<AccessibleWorkspace>;
}

export type WorkspaceLookupFunction = ComputerWorkspaceRpcTransport["getBySlug"];
/** Catalog input accepted when callers provide the direct lookup as the second argument. */
export type WorkspaceCatalogFunction = (
  serverUrl: string,
  credential?: Credential,
) => Promise<AccessibleWorkspace[]>;
export type WorkspaceLookupTransport =
  | ComputerWorkspaceRpcTransport
  | WorkspaceLookupFunction
  | WorkspaceCatalogFunction;

export interface WorkspaceLookup {
  getBySlug: WorkspaceLookupFunction;
}

export function createWorkspaceLookup(
  transport: ComputerWorkspaceRpcTransport,
  directLookup?: WorkspaceLookupFunction,
): WorkspaceLookup;
export function createWorkspaceLookup(
  transport: WorkspaceLookupFunction,
  directLookup?: WorkspaceLookupFunction,
): WorkspaceLookup;
export function createWorkspaceLookup(
  transport: WorkspaceCatalogFunction,
  directLookup: WorkspaceLookupFunction,
): WorkspaceLookup;
export function createWorkspaceLookup(
  transport: WorkspaceLookupTransport,
  directLookup?: WorkspaceLookupFunction,
): WorkspaceLookup {
  return {
    getBySlug:
      directLookup ??
      (typeof transport === "function"
        ? (transport as WorkspaceLookupFunction)
        : transport.getBySlug.bind(transport)),
  };
}
