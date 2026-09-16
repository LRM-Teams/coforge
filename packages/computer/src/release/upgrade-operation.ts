/**
 * One Computer upgrade or rollback, identified once at the process boundary and carried
 * explicitly from there. Every process that takes part in an operation - the CLI, the
 * `__remote-upgrade` entry point, and the detached `__upgrade` coordinator - receives the same
 * record by argument or through the durable request file, never through the environment.
 */
export type UpgradeOperationKind = "upgrade" | "rollback";

/** Who asked for the operation. Remote operations owe the server a terminal result. */
export type UpgradeOperationOrigin = "remote" | "cli";

export type UpgradeOperation = {
  /** Stable operation identity; also names the durable request and result files. */
  requestId: string;
  operation: UpgradeOperationKind;
  /** The release selector, or "latest". */
  selection: string;
  origin: UpgradeOperationOrigin;
  /** The caller already announced this operation, so the installer omits its own banner. */
  quiet: boolean;
  /** Install from an already-downloaded release directory. Local operations only. */
  localDirectory?: string;
};

export const UPGRADE_REQUEST_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function assertUpgradeRequestId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !UPGRADE_REQUEST_ID.test(value))
    throw new Error("upgrade operation requires a valid UUID request ID");
}

/** Builds the operation a server-triggered upgrade runs, from `__remote-upgrade` arguments. */
export function parseRemoteUpgradeOperation(argv: readonly string[]): UpgradeOperation {
  const value = (flag: string) => {
    const index = argv.indexOf(flag);
    return index < 0 ? undefined : argv[index + 1];
  };
  const requestId = value("--request-id");
  assertUpgradeRequestId(requestId);
  const selection = value("--version");
  if (!selection) throw new Error("remote upgrade requires --version");
  return { requestId, operation: "upgrade", selection, origin: "remote", quiet: true };
}

/** Builds the operation an interactive `upgrade`, `install`, or `rollback` command runs. */
export function createLocalUpgradeOperation(
  operation: UpgradeOperationKind,
  selection: string,
  options: { quiet?: boolean; localDirectory?: string } = {},
): UpgradeOperation {
  return {
    requestId: crypto.randomUUID(),
    operation,
    selection,
    origin: "cli",
    quiet: options.quiet ?? false,
    ...(options.localDirectory ? { localDirectory: options.localDirectory } : {}),
  };
}
