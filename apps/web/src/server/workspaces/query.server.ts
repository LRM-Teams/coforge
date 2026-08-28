import { WORKSPACE_PROTOCOL_MAJOR, type Workspace } from "@coforge/protocol";
import {
  decodeWorkspaceGetRequest,
  decodeWorkspaceListRequest,
  encodeWorkspaceGetResponse,
  encodeWorkspaceListResponse,
} from "@coforge/protocol/codec";

export type AuthenticatedPrincipal = { readonly userId: string };
export interface WorkspaceAccess {
  listAccessible(principal: AuthenticatedPrincipal): Promise<Workspace[]>;
  getAccessibleBySlug(
    slug: string,
    principal: AuthenticatedPrincipal,
  ): Promise<Workspace | undefined>;
}
export class WorkspaceQueryError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}
export class WorkspaceQueryUseCase {
  constructor(private readonly access: WorkspaceAccess) {}
  list(request: ReturnType<typeof decodeWorkspaceListRequest>, principal?: AuthenticatedPrincipal) {
    if (!principal?.userId) throw new WorkspaceQueryError(401, "authentication required");
    if (request.protocolMajor !== WORKSPACE_PROTOCOL_MAJOR || !request.requestId)
      throw new WorkspaceQueryError(422, "invalid workspace request");
    return this.access.listAccessible(principal).then((workspaces) =>
      encodeWorkspaceListResponse({
        protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
        requestId: request.requestId,
        workspaces,
      }),
    );
  }
  get(request: ReturnType<typeof decodeWorkspaceGetRequest>, principal?: AuthenticatedPrincipal) {
    if (!principal?.userId) throw new WorkspaceQueryError(401, "authentication required");
    if (
      request.protocolMajor !== WORKSPACE_PROTOCOL_MAJOR ||
      !request.requestId ||
      !request.workspaceSlug
    )
      throw new WorkspaceQueryError(422, "invalid workspace request");
    return this.access.getAccessibleBySlug(request.workspaceSlug, principal).then((workspace) => {
      if (!workspace) throw new WorkspaceQueryError(404, "workspace not found");
      return encodeWorkspaceGetResponse({
        protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
        requestId: request.requestId,
        workspace,
      });
    });
  }
}
