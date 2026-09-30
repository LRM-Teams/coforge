import { UPGRADE_ERROR_CODE, UPGRADE_ERROR_CODE_PATTERN } from "@lrm/coforge-sdk/internal";
import { z } from "zod";

import { ArtifactIdentitySchema } from "#src/updater";
import { UpgradeResultSchema } from "./upgrade-coordinator";

/*
 * Shapes exchanged with the separately released `coforge-installer` that no existing module owns
 * yet: the installer's release manifest, the fields its receipts add, and the JSON the product's
 * hidden `__lifecycle` command prints for it. `bun run generate:installer-contract` exports these
 * as JSON Schema plus golden instances into crates/installer/contract/, where the Rust crate's tests read
 * them. Versioning rule for every shape here: fields are only ever added; a field whose meaning
 * changes needs a new protocol number.
 */

/** The installer protocol a release requires (`installer_protocol` in both manifests). */
export const INSTALLER_PROTOCOL = 1;

/** `installer/<version>/manifest.json`, written by the installer's release workflow. */
export const InstallerManifestSchema = z
  .looseObject({
    schema_version: z.literal(1),
    version: z.string(),
    commit: z.string(),
    buildDate: z.string(),
    installer_protocol: z.number().int().positive(),
    platforms: z.record(
      z.string(),
      z.looseObject({
        installer: z.looseObject({
          file: z.enum(["coforge-installer", "coforge-installer.exe"]),
          ...ArtifactIdentitySchema.shape,
          gzip: z.looseObject({
            file: z.enum(["coforge-installer.gz", "coforge-installer.exe.gz"]),
            ...ArtifactIdentitySchema.shape,
          }),
        }),
      }),
    ),
  })
  .meta({ title: "coforge-installer release manifest" });

export const INSTALLER_RECEIPT_PROTOCOL = "coforge-installer/v1";

/**
 * The installer's exit codes. A receipt's `exit_code` is the one its status implies; a few
 * outcomes exit without leaving a receipt, because no operation ran or the receipt that exists
 * belongs to another. Busy Agents never change an exit code: an upgrade stops them.
 *
 * - `SUCCEEDED` (0): the operation completed.
 * - `FAILED` (1): failed before any change, or rolled back to the previous version (a receipt).
 *   Also a usage error, which writes no receipt: no operation began.
 * - `HELD` (2): the operation was stopped on purpose before it settled. With a receipt, its
 *   `status` is "held" and `error` says why; the Daemon settles the operation as a failed one,
 *   since the wire has no held status. No v1 operation produces that receipt yet (the
 *   downgrade gate and `repair` come later). Without one: the machine mutation lock is held by
 *   another run, or the request id was already used for a different operation or target. Both
 *   exit 2 and write nothing.
 * - `UNRESOLVED` (3): rollback failed, or no previous version existed to roll back to (a
 *   receipt). Also, without a receipt: recovery state exists and the operation is not `recover`
 *   or `repair`; the message names `coforge-installer recover`.
 */
export const INSTALLER_EXIT_CODE = {
  SUCCEEDED: 0,
  FAILED: 1,
  HELD: 2,
  UNRESOLVED: 3,
} as const;

/**
 * A process the installer stopped, recorded so that whoever verifies later can tell it is still
 * dead and that no other process has taken its ID. The Computer only checks the shape; the
 * installer compares the values, on the machine that wrote them.
 *
 * `startedAt` is an opaque string, never a time to parse, compare across machines, or show. The
 * operating systems keep a process's start differently and only equality is ever asked of it, so
 * each platform's native value is written as it is, without conversion:
 * - Linux: `<boot id>:<start ticks>`, the lowercase `/proc/sys/kernel/random/boot_id` and field
 *   22 of `/proc/<pid>/stat` in decimal. Parse that file after its last `)`: the command name
 *   (field 2) can hold spaces and parentheses, so counting fields from the start misreads it.
 *   The ticks count from boot, so the boot id keeps a recycled ID after a reboot apart.
 * - macOS: `<seconds>.<microseconds>`, the microseconds padded to six digits, from
 *   `pbi_start_tvsec` and `pbi_start_tvusec` of `proc_pidinfo(PROC_PIDTBSDINFO)`.
 * - Windows: the creation time from `GetProcessTimes` as decimal `FILETIME` ticks (100 ns since
 *   1601-01-01 UTC).
 * `executable` is the path the OS reports for the process image.
 */
export const DeadProcessIdentitySchema = z.looseObject({
  pid: z.number().int().positive(),
  startedAt: z.string().min(1),
  executable: z.string().min(1),
});

/** An `errorCode` in the shared format that is neither rollback outcome, which alone fix a
 * status's exit code. Spelled as a pattern so the JSON Schema states it too. */
const NON_ROLLBACK_ERROR_CODE = new RegExp(
  `^(?!${UPGRADE_ERROR_CODE.ROLLED_BACK}$|${UPGRADE_ERROR_CODE.ROLLBACK_FAILED}$)${UPGRADE_ERROR_CODE_PATTERN.source.slice(1)}`,
);
const nonRollbackErrorCode = z.string().regex(NON_ROLLBACK_ERROR_CODE);
const noValue = z.never().optional();
const reason = z.string().min(1);

/** Fields every receipt has: the product's receipt plus who wrote it, and the identities of the
 * processes the installer stopped (present exactly when it stopped any). The installer has no
 * rollback command, so its receipts always name the `upgrade` operation. `supervisorRunning` and
 * `runtimes` stay optional and are the installer's to fill from `__lifecycle status`: the CLI
 * reads them from a succeeded receipt to say which Workspaces stay stopped. */
const receiptFields = {
  ...UpgradeResultSchema.shape,
  operation: z.literal("upgrade"),
  protocol: z.literal(INSTALLER_RECEIPT_PROTOCOL),
  installer_version: z.string(),
  deadProcessIdentities: z.array(DeadProcessIdentitySchema).min(1).optional(),
};

/**
 * The upgrade receipt the installer writes. Its `status` and `errorCode` fix its `exit_code`, and
 * the schema accepts only these pairings (`receipt.schema.json` states them as `anyOf` variants):
 *
 * - succeeded, no `errorCode`: exit 0.
 * - failed with `UPGRADE_ROLLED_BACK` and `restoredVersion`: exit 1.
 * - failed with any other code but `UPGRADE_ROLLBACK_FAILED`, or none: exit 1, a failure before
 *   any change.
 * - held, with no `errorCode` or any but the two rollback ones: exit 2.
 * - failed with `UPGRADE_ROLLBACK_FAILED`, or none: exit 3, the rollback failed or had nothing to
 *   roll back to.
 *
 * Every receipt but a succeeded one says why in `error`. `errorCode` is one of the SDK's
 * `UPGRADE_ERROR_CODE`; a failure none of them describes carries none.
 *
 * There is one receipt per request id, at `<install root>/upgrade-results/<request_id>.result.json`.
 * It is written atomically and never overwritten. A repeated request id for the same operation
 * and target replays the stored receipt, with the exit status it implies, instead of running
 * again; a different operation or target is HELD without a receipt (`INSTALLER_EXIT_CODE`). A
 * reader reads at most `UPGRADE_RECEIPT_MAX_BYTES` and treats a larger file as no receipt.
 */
export const InstallerReceiptSchema = z
  .union([
    z.looseObject({
      ...receiptFields,
      status: z.literal("succeeded"),
      exit_code: z.literal(INSTALLER_EXIT_CODE.SUCCEEDED),
      errorCode: noValue,
      restoredVersion: noValue,
    }),
    z.looseObject({
      ...receiptFields,
      status: z.literal("failed"),
      exit_code: z.literal(INSTALLER_EXIT_CODE.FAILED),
      error: reason,
      errorCode: nonRollbackErrorCode.optional(),
      restoredVersion: noValue,
    }),
    z.looseObject({
      ...receiptFields,
      status: z.literal("failed"),
      exit_code: z.literal(INSTALLER_EXIT_CODE.FAILED),
      error: reason,
      errorCode: z.literal(UPGRADE_ERROR_CODE.ROLLED_BACK),
      restoredVersion: z.string().min(1),
    }),
    z.looseObject({
      ...receiptFields,
      status: z.literal("held"),
      exit_code: z.literal(INSTALLER_EXIT_CODE.HELD),
      error: reason,
      errorCode: nonRollbackErrorCode.optional(),
      restoredVersion: noValue,
    }),
    z.looseObject({
      ...receiptFields,
      status: z.literal("failed"),
      exit_code: z.literal(INSTALLER_EXIT_CODE.UNRESOLVED),
      error: reason,
      errorCode: z.literal(UPGRADE_ERROR_CODE.ROLLBACK_FAILED).optional(),
      restoredVersion: noValue,
    }),
  ])
  .meta({ title: "coforge-installer upgrade receipt" });

/** Version of the JSON `coforge-computer __lifecycle` prints; every response carries it. */
export const LIFECYCLE_PROTOCOL = 1;

/** `coforge-computer __lifecycle` exit statuses. */
export const LIFECYCLE_EXIT_CODE = {
  OK: 0,
  /** The operation failed; stdout holds a `LifecycleError`. */
  FAILED: 1,
  /** The arguments were not understood; stdout holds a `LifecycleError` with code `USAGE`. */
  USAGE: 2,
} as const;

/** The `code` of a failed `__lifecycle` call. */
export const LIFECYCLE_ERROR_CODE = {
  USAGE: "LIFECYCLE_USAGE",
  /** Any other failure; `message` says what happened. */
  FAILED: "LIFECYCLE_FAILED",
} as const;

const lifecycleProtocol = z.number().int().positive();

/** `__lifecycle protocol`: answered without contacting the supervisor or writing anything. */
export const LifecycleProtocolSchema = z
  .looseObject({ lifecycle_protocol: lifecycleProtocol, version: z.string() })
  .meta({ title: "__lifecycle protocol" });

/** One reason the runtime set is not healthy (`SupervisorProblem` in supervisor-status.ts). */
export const LifecycleProblemSchema = z.looseObject({
  code: z.string().regex(UPGRADE_ERROR_CODE_PATTERN),
  binding_id: z.string().optional(),
  message: z.string(),
});
export type LifecycleProblem = z.infer<typeof LifecycleProblemSchema>;

/** `__lifecycle status`. With no supervisor running, bindings come from bindings.json. */
export const LifecycleStatusSchema = z
  .looseObject({
    lifecycle_protocol: lifecycleProtocol,
    version: z.string(),
    supervisor: z.looseObject({
      running: z.boolean(),
      id: z.string().optional(),
      version: z.string().optional(),
    }),
    bindings: z.array(
      z.looseObject({
        binding_id: z.string(),
        enabled: z.boolean(),
        running: z.boolean(),
        process_id: z.number().int().positive().nullable(),
      }),
    ),
    healthy: z.boolean(),
    /** Why the runtime set is not healthy; empty exactly when `healthy` is true. The installer
     * quotes their messages when it refuses to upgrade. */
    problems: z.array(LifecycleProblemSchema),
  })
  .meta({ title: "__lifecycle status" });
export type LifecycleStatus = z.infer<typeof LifecycleStatusSchema>;

/** Any failed `__lifecycle` call, printed with a non-zero exit status. */
export const LifecycleErrorSchema = z
  .looseObject({
    lifecycle_protocol: lifecycleProtocol,
    ok: z.literal(false),
    code: z.string().regex(UPGRADE_ERROR_CODE_PATTERN),
    message: z.string(),
  })
  .meta({ title: "__lifecycle error" });
export type LifecycleError = z.infer<typeof LifecycleErrorSchema>;
