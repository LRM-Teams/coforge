import { COMPUTER_REGISTER_METHOD, WORKSPACE_GET_METHOD } from "@lrm/coforge-sdk/internal";

import { principalFromAuthorizationHeader } from "../auth/computer-access-token.server";
import {
  CentrifugoRpcAuthenticationError,
  CentrifugoRpcHandler,
  createComputerRegistrationMethod,
  createWorkspaceGetMethod,
} from "../centrifugo/rpc-handler.server";
import { getDatabaseClient } from "../db/client.server";
import {
  PrismaComputerRegistrationRepository,
  PrismaWorkspaceAccess,
} from "../db/repositories/setup.repositories.server";
import { WorkspaceQueryUseCase } from "../workspaces/query.server";
import { ComputerRegistrar } from "./registration.server";

type Dependencies = {
  authenticate(request: Request): Promise<{ userId: string } | null>;
  workspaceQuery: WorkspaceQueryUseCase;
  registration: Pick<ComputerRegistrar, "register">;
};

/** Owns the User-authenticated Computer setup/attach HTTPS boundary. */
export function createComputerHttpHandler(dependencies?: Dependencies) {
  const resolved = dependencies ?? productionDependencies();
  if (!resolved) return new CentrifugoRpcHandler({ methods: {} });
  return new CentrifugoRpcHandler({
    methods: {
      [WORKSPACE_GET_METHOD]: createWorkspaceGetMethod(resolved.workspaceQuery),
      [COMPUTER_REGISTER_METHOD]: createComputerRegistrationMethod(resolved.registration),
    },
    authenticateEnvelope: async (_envelope, request) => {
      const principal = await resolved.authenticate(request);
      if (!principal) throw new CentrifugoRpcAuthenticationError();
      return { ...principal, workspaceId: "", computerId: "" };
    },
  });
}

function productionDependencies(): Dependencies | undefined {
  const db = getDatabaseClient();
  if (!db) return undefined;
  const workspaceAccess = new PrismaWorkspaceAccess(db);
  return {
    authenticate: principalFromAuthorizationHeader,
    workspaceQuery: new WorkspaceQueryUseCase(workspaceAccess),
    registration: new ComputerRegistrar({
      workspaceAccess,
      registrations: new PrismaComputerRegistrationRepository(db),
    }),
  };
}
