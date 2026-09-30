import { UPGRADE_ERROR_CODE_PATTERN } from "@lrm/coforge-sdk/internal";
import { z } from "zod";

import { ArtifactIdentitySchema } from "#src/updater";
import { UpgradeResultSchema } from "./upgrade-coordinator";

/*
 * Shapes exchanged with the separately released `coforge-installer` that no existing module owns
 * yet: the installer's release manifest, the fields its receipts add, and the JSON the product's
 * hidden `__lifecycle` command prints for it. `bun run generate:installer-contract` exports these
 * as JSON Schema plus golden instances into installer/contract/, where the Rust crate's tests read
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
 * The installer's exit codes. A receipt records the code its committed outcome implies and never
 * `HELD` (2), which exists only as the installer process's exit status.
 */
export const INSTALLER_EXIT_CODE = {
  SUCCEEDED: 0,
  /** Failed before any change, or rolled back to the previous version. */
  FAILED: 1,
  /** The outcome is committed in a receipt, but the operation has not settled; `recover`
   * finishes it. */
  HELD: 2,
  /** Rollback failed, or no previous version existed to roll back to. */
  UNRESOLVED: 3,
} as const;

/** The upgrade receipt the installer writes: the product's receipt plus who wrote it. The
 * installer has no rollback command, so its receipts always name the `upgrade` operation. */
export const InstallerReceiptSchema = z
  .looseObject({
    ...UpgradeResultSchema.shape,
    operation: z.literal("upgrade"),
    protocol: z.literal(INSTALLER_RECEIPT_PROTOCOL),
    exit_code: z.union([
      z.literal(INSTALLER_EXIT_CODE.SUCCEEDED),
      z.literal(INSTALLER_EXIT_CODE.FAILED),
      z.literal(INSTALLER_EXIT_CODE.UNRESOLVED),
    ]),
    installer_version: z.string(),
  })
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
