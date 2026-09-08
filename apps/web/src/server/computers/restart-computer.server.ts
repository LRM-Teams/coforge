import { encodeComputerRestartIntent } from "@coforge/protocol";

import type { CentrifugoServerApi } from "../centrifugo/server-api.server";
import { daemonControlChannel } from "../centrifugo/server-api.server";
import type { ComputerRestartStore } from "./computer-restart-store.server";

export interface ComputerRestartAuthorization {
  canRestart(scope: { userId: string; workspaceId: string; computerId: string }): Promise<boolean>;
}

export class RestartComputer {
  constructor(
    private readonly authorization: ComputerRestartAuthorization,
    private readonly publisher: Pick<CentrifugoServerApi, "publish">,
    private readonly restarts: ComputerRestartStore,
  ) {}

  async execute(
    principal: { userId: string; workspaceId: string },
    input: { computerId: string; requestId: string },
  ) {
    const scope = { ...principal, computerId: input.computerId };
    if (!(await this.authorization.canRestart(scope))) throw new Error("Computer is not available");
    const registered = await this.restarts.begin(scope, input.requestId);
    if (!registered.created) return registered.status;
    try {
      await this.publisher.publish(
        daemonControlChannel(principal.workspaceId, input.computerId),
        encodeComputerRestartIntent({
          protocolMajor: 1,
          ...input,
          workspaceId: principal.workspaceId,
        }),
      );
      return registered.status;
    } catch (error) {
      await this.restarts.publicationFailed(scope, input.requestId);
      throw error;
    }
  }
}
