import {
  DAEMON_CONNECT_REJECTION_CODES,
  UUID_LIKE_PATTERN,
  isRecord,
  type DaemonConnectRejectionReason,
} from "@lrm/coforge-sdk/internal";
import {
  verifyDaemonApiKey,
  type DaemonApiKeyClaims,
  type DaemonApiKeyRepository,
} from "#src/server/auth/daemon-api-key.server";

type ConnectRequest = {
  data?: unknown;
};

function connectData(data: unknown): Record<string, unknown> {
  if (typeof data === "string") {
    try {
      const parsed: unknown = JSON.parse(data);
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return isRecord(data) ? data : {};
}

/**
 * A 200 answer carrying a Centrifugo `disconnect` in the terminal 4500-4999 range: the Daemon's
 * client does not reconnect, and the reason is the stable code the Daemon parks its binding on.
 * A non-200 answer would reach the client as Centrifugo's temporary internal error instead.
 */
function refuse(reason: DaemonConnectRejectionReason): Response {
  return Response.json({
    disconnect: { code: DAEMON_CONNECT_REJECTION_CODES[reason], reason },
  });
}

export async function authenticateCentrifugoConnect(
  request: Request,
  dependencies: {
    daemonApiKeys: DaemonApiKeyRepository;
    computerBelongsToWorkspace(workspaceId: string, computerId: string): Promise<boolean>;
    workspaceExists(workspaceId: string): Promise<boolean>;
  },
): Promise<Response> {
  try {
    const body = (await request.json()) as ConnectRequest;
    const data = connectData(body.data);
    const key = data.daemonApiKey;
    if (typeof key !== "string") throw new Error("Daemon API key missing");
    let principal: DaemonApiKeyClaims;
    try {
      principal = await verifyDaemonApiKey(key, dependencies.daemonApiKeys);
    } catch (error) {
      // A Workspace's keys are deleted with it, so an unknown key is all a deleted Workspace's
      // Daemon can present. Only the Workspace id it claims can tell that apart from a bad key.
      const workspaceId = data.workspaceId;
      if (
        typeof workspaceId === "string" &&
        UUID_LIKE_PATTERN.test(workspaceId) &&
        !(await dependencies.workspaceExists(workspaceId))
      )
        return refuse("workspace_deleted");
      throw error;
    }
    if (
      !(await dependencies.computerBelongsToWorkspace(principal.workspaceId, principal.computerId))
    )
      return refuse("computer_unlinked");
    return Response.json({
      result: {
        user: principal.userId,
        meta: {
          workspace_id: principal.workspaceId,
          computer_id: principal.computerId,
        },
        subs: {
          [`daemon:${principal.workspaceId}:${principal.computerId}`]: {},
        },
      },
    });
  } catch {
    return Response.json(
      { error: { code: 401, message: "connection authentication failed" } },
      { status: 401 },
    );
  }
}
