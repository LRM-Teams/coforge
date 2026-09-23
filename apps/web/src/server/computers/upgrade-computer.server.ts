import { encodeComputerUpgradeIntent } from "@lrm/coforge-sdk/internal";
import { AppError } from "@/lib/app-error";

import type { CentrifugoServerApi } from "../centrifugo/server-api.server";
import { daemonControlChannel } from "../centrifugo/server-api.server";
import type { ComputerStatusCache } from "../centrifugo/computer-status.server";
import type { RedisComputerUpgradeStore } from "./computer-upgrade-store.server";

export class UpgradeComputer {
  constructor(
    private readonly upgrades: Pick<
      RedisComputerUpgradeStore,
      "status" | "begin" | "publicationFailed"
    >,
    private readonly presence: Pick<ComputerStatusCache, "get">,
    /** Throws AppError("RELEASE_FEED_UNAVAILABLE") when the latest version cannot be resolved. */
    private readonly latestVersion: () => Promise<string>,
    private readonly publisher: Pick<CentrifugoServerApi, "publish">,
  ) {}

  async execute(
    principal: { workspaceId: string },
    input: { computerId: string; requestId: string },
  ) {
    const scope = { workspaceId: principal.workspaceId, computerId: input.computerId };
    // A retried requestId already has a record regardless of whether the Computer is currently
    // online (it may be mid-restart as part of the very upgrade it is polling), so idempotency
    // is checked before liveness.
    const existing = await this.upgrades.status(scope, input.requestId);
    if (existing) return existing;
    // Presence, not the upgrade identity snapshot, decides whether a *new* request can begin.
    if (!(await this.presence.get(scope))) throw new AppError("COMPUTER_OFFLINE");
    const expectedVersion = await this.latestVersion();
    const registered = await this.upgrades.begin(scope, input.requestId, expectedVersion);
    if (!registered.created) return registered.status;
    try {
      await this.publisher.publish(
        daemonControlChannel(scope.workspaceId, scope.computerId),
        encodeComputerUpgradeIntent({
          protocolMajor: 1,
          requestId: input.requestId,
          workspaceId: scope.workspaceId,
          computerId: scope.computerId,
          target: "latest",
          expectedVersion,
        }),
      );
      return registered.status;
    } catch (error) {
      await this.upgrades.publicationFailed(scope, input.requestId);
      throw error;
    }
  }
}
