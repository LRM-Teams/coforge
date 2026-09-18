import { createServerFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import {
  encodeAgentWorkspaceFileReadRequest,
  encodeAgentWorkspaceFilesListRequest,
} from "@lrm/coforge-sdk/internal";
import {
  listAgentWorkspaceFilesInputSchema,
  readAgentWorkspaceFileInputSchema,
} from "./agent.schemas";
import { workspaceUserMiddleware } from "../../server/auth/function-auth";
import {
  AgentWorkspaceFilesQuery,
  findOwnedWorkspaceFilesAssignment,
} from "../../server/agents/agent-workspace-files.server";
import {
  createCentrifugoServerApi,
  daemonControlChannel,
} from "../../server/centrifugo/server-api.server";
import { getComputerStatusCache } from "../../server/centrifugo/computer-status.server";
import {
  getAgentWorkspaceFileReadResults,
  getAgentWorkspaceFilesListResults,
} from "../../server/centrifugo/agent-workspace-files-cache.server";

function buildQuery(db: Parameters<typeof findOwnedWorkspaceFilesAssignment>[0]) {
  return new AgentWorkspaceFilesQuery({
    findOwned: (viewer, id) => findOwnedWorkspaceFilesAssignment(db, viewer, id),
    online: (scope) => getComputerStatusCache().get(scope),
    publishList: (request) =>
      createCentrifugoServerApi().publish(
        daemonControlChannel(request.workspaceId, request.computerId),
        encodeAgentWorkspaceFilesListRequest(request),
      ),
    publishRead: (request) =>
      createCentrifugoServerApi().publish(
        daemonControlChannel(request.workspaceId, request.computerId),
        encodeAgentWorkspaceFileReadRequest(request),
      ),
    listResults: getAgentWorkspaceFilesListResults(),
    readResults: getAgentWorkspaceFileReadResults(),
  });
}

export const listAgentWorkspaceFiles = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(listAgentWorkspaceFilesInputSchema)
  .handler(async ({ data, context }) => {
    setResponseHeader("Cache-Control", "no-store");
    const { user, db, workspaceId } = context;
    return buildQuery(db).list(
      { userId: user.id, workspaceId },
      data.agentId,
      data.dirPath,
      data.includeHidden,
    );
  });

export const readAgentWorkspaceFile = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(readAgentWorkspaceFileInputSchema)
  .handler(async ({ data, context }) => {
    setResponseHeader("Cache-Control", "no-store");
    const { user, db, workspaceId } = context;
    return buildQuery(db).read({ userId: user.id, workspaceId }, data.agentId, data.path);
  });
