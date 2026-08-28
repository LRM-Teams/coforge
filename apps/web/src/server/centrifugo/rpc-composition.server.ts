import {
  COMPUTER_REGISTER_METHOD,
  WORKSPACE_GET_METHOD,
  WORKSPACE_LIST_METHOD,
} from "@coforge/protocol";

import {
  CentrifugoRpcHandler,
  CentrifugoRpcAuthenticationError,
  type CentrifugoRpcError,
  type CentrifugoRpcMethod,
} from "./rpc-handler.server";
import { getDatabaseClient } from "../db/client.server";
import { PrismaWorkspaceAccess } from "../db/repositories/setup.repositories.server";
import {
  createComputerRegistrationMethod,
  createWorkspaceGetMethod,
  createWorkspaceListMethod,
  createWorkspaceWorkerReadyMethod,
} from "./rpc-handler.server";
import { WORKSPACE_WORKER_READY_METHOD } from "@coforge/protocol";
import { WorkspaceQueryUseCase } from "../workspaces/query.server";
import { ComputerRegistrar } from "../computers/registration.server";
import { PrismaComputerConnectionRepository } from "../db/repositories/setup.repositories.server";
import { createWorkspaceWorkerTokenIssuer } from "../auth/workspace-worker-token.server";

const unavailable: CentrifugoRpcError = {
  code: 503,
  message: "protocol method dependencies are unavailable",
};

const unavailableMethod: CentrifugoRpcMethod = () => unavailable;

function requireAuthenticatedCentrifugoUser(request: { user?: string }): void {
  if (!request.user) throw new CentrifugoRpcAuthenticationError();
}

function authorizeCentrifugoProxy(request: Request): void {
  const secret = process.env.COFORGE_CENTRIFUGO_PROXY_SECRET;
  if (!secret || request.headers.get("x-coforge-centrifugo-proxy-secret") !== secret)
    throw new Error("proxy authorization failed");
}

/** Compose the server-owned Centrifugo boundary without inventing persistence. */
export function createCentrifugoRpcHandler() {
  const db = getDatabaseClient();
  if (db) {
    const access = new PrismaWorkspaceAccess(db);
    const query = new WorkspaceQueryUseCase(access);
    const registration = new ComputerRegistrar({
      workspaceAccess: access,
      computers: new PrismaComputerConnectionRepository(db),
      tokenIssuer: createWorkspaceWorkerTokenIssuer(),
    });
    return new CentrifugoRpcHandler({
      methods: {
        [COMPUTER_REGISTER_METHOD]: createComputerRegistrationMethod(registration),
        [WORKSPACE_LIST_METHOD]: createWorkspaceListMethod(query),
        [WORKSPACE_GET_METHOD]: createWorkspaceGetMethod(query),
        [WORKSPACE_WORKER_READY_METHOD]: createWorkspaceWorkerReadyMethod(),
      },
      authenticateEnvelope: requireAuthenticatedCentrifugoUser,
      authorizeProxyRequest: authorizeCentrifugoProxy,
    });
  }
  return new CentrifugoRpcHandler({
    methods: {
      [COMPUTER_REGISTER_METHOD]: unavailableMethod,
      [WORKSPACE_LIST_METHOD]: unavailableMethod,
      [WORKSPACE_GET_METHOD]: unavailableMethod,
      [WORKSPACE_WORKER_READY_METHOD]: createWorkspaceWorkerReadyMethod(),
    },
    authenticateEnvelope: requireAuthenticatedCentrifugoUser,
    authorizeProxyRequest: authorizeCentrifugoProxy,
  });
}
