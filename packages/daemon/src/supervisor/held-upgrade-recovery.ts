import { UPGRADE_ERROR_CODE } from "@lrm/coforge-sdk/internal";

export type HeldUpgradeTerminal = {
  status: "succeeded" | "failed";
  errorCode?: string;
};

/** Only a promoted candidate or a verified rollback may release machine-wide launch-hold. */
export function terminalAllowsWorkspaceRecovery(result: HeldUpgradeTerminal): boolean {
  return result.status === "succeeded" || result.errorCode === UPGRADE_ERROR_CODE.ROLLED_BACK;
}

export type HeldUpgradeOperation = {
  requestId: string;
  state: "pending" | "succeeded" | "failed" | "acknowledged";
  requestedAt: number;
  terminal?: { version?: string; error?: string; errorCode?: string };
};

/** Durable binding state remains sufficient after server acknowledgement: success keeps its
 * version, and verified rollback keeps its typed code. Other acknowledged failures stay held. */
export function operationAllowsWorkspaceRecovery(operation: HeldUpgradeOperation): boolean {
  if (operation.state === "pending") return false;
  if (operation.state === "succeeded") return true;
  if (operation.terminal?.errorCode === UPGRADE_ERROR_CODE.ROLLED_BACK) return true;
  return (
    operation.state === "acknowledged" &&
    Boolean(operation.terminal?.version) &&
    !operation.terminal?.error &&
    !operation.terminal?.errorCode
  );
}

/**
 * A held Coordinator restart may find the receipt already settled but hold removal unfinished.
 * Never let an older terminal record release a newer pending operation; otherwise resume the
 * newest verified promotion/rollback that is still unacknowledged.
 */
export function selectLegacyHeldRequestId(
  operations: readonly HeldUpgradeOperation[],
): string | undefined {
  return [...operations]
    .filter(
      (operation) => operation.state === "pending" || operationAllowsWorkspaceRecovery(operation),
    )
    .sort((left, right) => right.requestedAt - left.requestedAt)[0]?.requestId;
}

export function resolveHeldRequestId(
  persistedValue: string | undefined,
  operations: readonly HeldUpgradeOperation[],
): string | undefined {
  const exact = operations.find((operation) => operation.requestId === persistedValue);
  if (exact) return exact.requestId;
  return persistedValue === "upgrade" ? selectLegacyHeldRequestId(operations) : undefined;
}

export type HeldUpgradeRecoveryDependencies = {
  /** Settles and validates the exact request's durable terminal receipt. */
  settle(requestId: string): Promise<void>;
  /** Reconciles enabled/stopped Workspace bindings under the committed Computer version. */
  resume(): Promise<void>;
  /** Deletes the persistent launch-hold only after resume has reached its terminal outcome. */
  clearHold(): Promise<void>;
  /** Workspace recovery faults do not roll back a committed Computer version. */
  isWorkspaceRecoveryError(error: unknown): boolean;
  onWorkspaceRecoveryError(error: Error): void;
};

/**
 * Finishes the durable half of a Coordinator replacement held before Workspace startup.
 *
 * Both the external job's explicit resume RPC and the Coordinator's receipt watcher/startup sweep
 * call this seam. One in-flight promise serializes them. A committed receipt therefore
 * self-completes after job exit or a lost RPC response, while a settle/resume/hold-removal failure
 * leaves `active` true for the next retry or Coordinator restart.
 */
export class HeldUpgradeRecovery {
  #active: boolean;
  #requestId: string | undefined;
  #finishingRequestId: string | undefined;
  #finishing: Promise<void> | undefined;

  constructor(
    heldAtStartup: boolean,
    requestId: string | undefined,
    private readonly dependencies: HeldUpgradeRecoveryDependencies,
  ) {
    this.#active = heldAtStartup;
    this.#requestId = requestId;
  }

  get active(): boolean {
    return this.#active;
  }

  owns(requestId: string): boolean {
    return this.#active && this.#requestId === requestId;
  }

  isFinishing(requestId: string): boolean {
    return this.#finishingRequestId === requestId;
  }

  async finish(requestId: string, receiptAlreadySettled = false): Promise<boolean> {
    if (!this.#active) return false;
    // A known owner must match. An undefined owner is a stranded local CLI hold (hold UUID
    // never entered upgradeOperations); explicit resume recovers without settle/rebinding.
    if (this.#requestId !== undefined && this.#requestId !== requestId)
      throw new Error(`upgrade ${requestId} does not own launch-hold for ${this.#requestId}`);
    if (this.#finishing) {
      await this.#finishing;
      return true;
    }
    this.#finishingRequestId = requestId;
    const operation = this.#finish(requestId, receiptAlreadySettled);
    this.#finishing = operation;
    try {
      await operation;
      return true;
    } finally {
      if (this.#finishing === operation) {
        this.#finishing = undefined;
        this.#finishingRequestId = undefined;
      }
    }
  }

  async #finish(requestId: string, receiptAlreadySettled: boolean): Promise<void> {
    // Stranded holds have no durable receipt owner; settle would invent a binding.
    if (this.#requestId !== undefined && !receiptAlreadySettled)
      await this.dependencies.settle(requestId);
    if (!this.#active) return;
    try {
      await this.dependencies.resume();
    } catch (error) {
      if (!this.dependencies.isWorkspaceRecoveryError(error)) throw error;
      this.dependencies.onWorkspaceRecoveryError(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
    await this.dependencies.clearHold();
    this.#active = false;
  }
}

/** Receipt watcher/startup callbacks auto-finish only the exact held request and never re-enter
 * the explicit settle path already finishing that request. */
export function shouldAutoFinishHeldUpgrade(
  recovery: HeldUpgradeRecovery | undefined,
  requestId: string,
  result: HeldUpgradeTerminal,
): boolean {
  return Boolean(
    recovery?.active &&
    recovery.owns(requestId) &&
    !recovery.isFinishing(requestId) &&
    terminalAllowsWorkspaceRecovery(result),
  );
}
