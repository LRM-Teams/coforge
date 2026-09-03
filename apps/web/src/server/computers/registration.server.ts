import {
  COMPUTER_REGISTER_PROTOCOL_MAJOR,
  type ComputerRegisterRequest,
  type ComputerRegisterResponse,
} from "@coforge/protocol";

export type AuthenticatedPrincipal = { readonly userId: string };
export type Workspace = { readonly id: string; readonly slug: string };
export type ComputerRegistration = {
  readonly computerId: string;
  readonly workspaceId: string;
  readonly daemonApiKey: string;
};

export interface WorkspaceAccess {
  findAccessibleBySlug(
    slug: string,
    principal: AuthenticatedPrincipal,
  ): Promise<Workspace | undefined>;
}
export interface ComputerRegistrationRepository {
  register(input: {
    principal: AuthenticatedPrincipal;
    workspace: Workspace;
    request: ComputerRegisterRequest;
  }): Promise<ComputerRegistration>;
}

export class ComputerRegistrationError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export class ComputerRegistrar {
  constructor(
    private readonly deps: {
      workspaceAccess: WorkspaceAccess;
      registrations: ComputerRegistrationRepository;
    },
  ) {}

  async register(
    request: ComputerRegisterRequest,
    principal: AuthenticatedPrincipal | undefined,
  ): Promise<ComputerRegisterResponse> {
    if (!principal?.userId) throw new ComputerRegistrationError(401, "authentication required");
    validate(request);
    const workspace = await this.deps.workspaceAccess.findAccessibleBySlug(
      request.workspaceSlug,
      principal,
    );
    if (!workspace) throw new ComputerRegistrationError(403, "workspace access denied");
    const registration = await this.deps.registrations.register({ principal, workspace, request });
    return {
      ...registration,
      protocolMajor: COMPUTER_REGISTER_PROTOCOL_MAJOR,
      requestId: request.requestId,
    };
  }
}

function validate(request: ComputerRegisterRequest) {
  if (
    request.protocolMajor !== COMPUTER_REGISTER_PROTOCOL_MAJOR ||
    !request.requestId ||
    !request.workspaceSlug ||
    !request.machineId ||
    !request.registrationIdempotencyKey
  )
    throw new ComputerRegistrationError(422, "invalid registration request");
}
