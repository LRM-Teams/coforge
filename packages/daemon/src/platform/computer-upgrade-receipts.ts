import { homedir } from "node:os";
import { join } from "node:path";
import { UPGRADE_ERROR_CODE } from "@lrm/coforge-sdk/internal";

/**
 * The Computer's external upgrade job reports only through a durable receipt file. Nothing else
 * crosses the process boundary: the job runs detached, may outlive the Coordinator that launched
 * it, and on a successful upgrade replaces the executable underneath it.
 */
export type ComputerUpgradeReceipt = {
  requestId: string;
  status: "succeeded" | "failed";
  version?: string;
  error?: string;
  /** See `UPGRADE_ERROR_CODE`. Set only when the upgrade job itself knew a stable reason for a
   * "failed" receipt (e.g. it rolled back, or the updater reported a typed `UpdateError`). */
  errorCode?: string;
  /** When the receipt became durable, taken from the file itself. */
  at: number;
};

export type ComputerUpgradeReceiptOptions = {
  homeDirectory?: string;
  /** Injectable receipt reader, for tests only. */
  readReceipt?: (requestId: string) => Promise<ComputerUpgradeReceipt | undefined>;
};

/** What a pending operation is settled with when its job never left a receipt. */
export const UPGRADE_EXPIRED_WITHOUT_RECEIPT = "expired without a receipt";

export type SweepComputerUpgradeReceiptsOptions = ComputerUpgradeReceiptOptions & {
  now?: () => number;
  /** How long a pending operation may go without a receipt. Omit it to never expire one. */
  pendingTtlMs?: number;
};

/** A pending operation, and when this machine opened it. */
export type PendingComputerUpgrade = {
  workspaceId: string;
  requestId: string;
  requestedAt: number;
};

export function computerUpgradeResultPath(requestId: string, homeDirectory = homedir()): string {
  return join(
    homeDirectory,
    ".coforge",
    "computer",
    "install",
    "upgrade-results",
    `${requestId}.result.json`,
  );
}

/** Reads one operation's receipt, or undefined while the job has not finished. */
export async function readComputerUpgradeReceipt(
  requestId: string,
  options: ComputerUpgradeReceiptOptions = {},
): Promise<ComputerUpgradeReceipt | undefined> {
  if (options.readReceipt) return options.readReceipt(requestId);
  const file = Bun.file(computerUpgradeResultPath(requestId, options.homeDirectory));
  if (!(await file.exists())) return undefined;
  let value: unknown;
  try {
    value = await file.json();
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const receipt = value as Record<string, unknown>;
  // A receipt that names a different operation belongs to someone else's file.
  if (typeof receipt.request_id === "string" && receipt.request_id !== requestId) return undefined;
  if (receipt.status !== "succeeded" && receipt.status !== "failed") return undefined;
  return {
    requestId,
    status: receipt.status,
    ...(typeof receipt.version === "string" && receipt.version ? { version: receipt.version } : {}),
    ...(typeof receipt.error === "string" && receipt.error ? { error: receipt.error } : {}),
    ...(typeof receipt.errorCode === "string" && receipt.errorCode
      ? { errorCode: receipt.errorCode }
      : {}),
    at: file.lastModified > 0 ? file.lastModified : Date.now(),
  };
}

/**
 * Moves every pending operation whose job already left a receipt to its terminal state. The
 * Coordinator runs this at startup - a remote upgrade stops and replaces the Coordinator itself,
 * so startup is the first moment the new process can observe what the old one launched - and
 * again while it waits on a job it started.
 */
export async function sweepComputerUpgradeReceipts(
  pending: readonly PendingComputerUpgrade[],
  complete: (
    workspaceId: string,
    requestId: string,
    receipt: ComputerUpgradeReceipt,
  ) => Promise<unknown>,
  options: SweepComputerUpgradeReceiptsOptions = {},
): Promise<number> {
  const now = options.now ?? Date.now;
  let resolved = 0;
  for (const operation of pending) {
    const receipt =
      (await readComputerUpgradeReceipt(operation.requestId, options)) ??
      expiredReceipt(operation, now(), options.pendingTtlMs);
    if (!receipt) continue;
    await complete(operation.workspaceId, operation.requestId, receipt);
    resolved += 1;
  }
  return resolved;
}

/**
 * A job that never ran, or whose receipt was lost, would otherwise hold the single pending slot
 * for good and refuse every later upgrade. Past its deadline the operation is settled as failed -
 * which is the honest answer: this machine cannot say it succeeded.
 */
function expiredReceipt(
  operation: PendingComputerUpgrade,
  now: number,
  pendingTtlMs?: number,
): ComputerUpgradeReceipt | undefined {
  if (pendingTtlMs === undefined) return undefined;
  if (now - operation.requestedAt <= pendingTtlMs) return undefined;
  return {
    requestId: operation.requestId,
    status: "failed",
    error: UPGRADE_EXPIRED_WITHOUT_RECEIPT,
    errorCode: UPGRADE_ERROR_CODE.EXPIRED_WITHOUT_RECEIPT,
    at: now,
  };
}

/** Sleeps, but returns early - and clears its timer - the moment `signal` aborts, so an abandoned
 * wait never keeps the event loop (and so the process) alive. See `watchComputerUpgradeReceipt`. */
export function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export type WatchComputerUpgradeReceiptOptions = ComputerUpgradeReceiptOptions & {
  /** Cancels the watch promptly; no sleep is left pending once this fires. */
  signal: AbortSignal;
  /** How often to check for a receipt while none exists yet. */
  pollMs: number;
  /** How long the operation may go without a receipt before it is settled as expired. */
  ttlMs: number;
  now?: () => number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
};

/**
 * Watches one pending Computer upgrade operation - the unit the Coordinator's continuous,
 * post-startup watch runs per operation - until one of three things happens: its job's receipt
 * appears, it ages past `ttlMs` without one, or `signal` aborts. Each check reuses
 * `sweepComputerUpgradeReceipts`, so a receipt or an expiry settles exactly as the Coordinator's
 * own startup sweep does; the TTL is therefore enforced continuously, not only at startup.
 *
 * Checks immediately before the first sleep, so an operation that already has a receipt (or is
 * already past its TTL) settles without waiting a full `pollMs`. An abort is observed both before
 * and after each sleep, and every sleep passes `signal` through, so nothing here can outlive
 * cancellation (the class of bug that kept the Coordinator alive past its own shutdown).
 */
export async function watchComputerUpgradeReceipt(
  operation: PendingComputerUpgrade,
  complete: (
    workspaceId: string,
    requestId: string,
    receipt: ComputerUpgradeReceipt,
  ) => Promise<unknown>,
  options: WatchComputerUpgradeReceiptOptions,
): Promise<void> {
  const {
    signal,
    pollMs,
    ttlMs,
    now = Date.now,
    sleep = abortableSleep,
    ...receiptOptions
  } = options;
  while (!signal.aborted) {
    const settled = await sweepComputerUpgradeReceipts([operation], complete, {
      ...receiptOptions,
      now,
      pendingTtlMs: ttlMs,
    });
    if (settled) return;
    if (signal.aborted) return;
    await sleep(pollMs, signal);
  }
}
