import { verifyDaemonApiKey, type DaemonApiKeyRepository } from "../auth/daemon-api-key.server";

type ConnectRequest = {
  data?: { daemonApiKey?: unknown };
};

export async function authenticateCentrifugoConnect(
  request: Request,
  dependencies: {
    daemonApiKeys: DaemonApiKeyRepository;
    computerBelongsToWorkspace(workspaceId: string, computerId: string): Promise<boolean>;
  },
): Promise<Response> {
  try {
    const body = (await request.json()) as ConnectRequest;
    const key = body.data?.daemonApiKey;
    if (typeof key !== "string") throw new Error("Daemon API key missing");
    const principal = await verifyDaemonApiKey(key, dependencies.daemonApiKeys);
    if (
      !(await dependencies.computerBelongsToWorkspace(principal.workspaceId, principal.computerId))
    )
      throw new Error("Daemon scope is not authorized");
    return Response.json({
      result: {
        user: principal.userId,
        meta: {
          workspace_id: principal.workspaceId,
          computer_id: principal.computerId,
        },
        subs: {
          [`daemon:${principal.computerId}`]: {},
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
