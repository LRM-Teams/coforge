import { homedir } from "node:os";
import { join } from "node:path";

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
  /** When the receipt became durable, taken from the file itself. */
  at: number;
};

export type ComputerUpgradeReceiptOptions = {
  homeDirectory?: string;
  /** Injectable receipt reader, for tests only. */
  readReceipt?: (requestId: string) => Promise<ComputerUpgradeReceipt | undefined>;
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
  pending: readonly { workspaceId: string; requestId: string }[],
  complete: (
    workspaceId: string,
    requestId: string,
    receipt: ComputerUpgradeReceipt,
  ) => Promise<unknown>,
  options: ComputerUpgradeReceiptOptions = {},
): Promise<number> {
  let resolved = 0;
  for (const operation of pending) {
    const receipt = await readComputerUpgradeReceipt(operation.requestId, options);
    if (!receipt) continue;
    await complete(operation.workspaceId, operation.requestId, receipt);
    resolved += 1;
  }
  return resolved;
}
