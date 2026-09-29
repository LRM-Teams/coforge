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
 * The installer's exit codes. A receipt records the code its committed outcome implies; it is
 * written once, before launches resume, so it never records `HELD` (2): a held run is visible
 * only as that process exit status plus the launch-hold file it leaves behind.
 */
export const INSTALLER_EXIT_CODE = {
  SUCCEEDED: 0,
  /** Failed before any change, or rolled back to the previous version. */
  FAILED: 1,
  /** A receipt was committed but launches could not be resumed. */
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

const lifecycleProtocol = z.number().int().positive();

/** `__lifecycle protocol`: answered without contacting the Coordinator. */
export const LifecycleProtocolSchema = z
  .looseObject({ lifecycle_protocol: lifecycleProtocol, version: z.string() })
  .meta({ title: "__lifecycle protocol" });

/** `__lifecycle status --json`. With no supervisor running, bindings come from bindings.json. */
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
  })
  .meta({ title: "__lifecycle status" });

/** `__lifecycle hold --request-id R`: the runner hold's outcome. */
export const LifecycleHoldSchema = z
  .looseObject({
    lifecycle_protocol: lifecycleProtocol,
    quiescent: z.boolean(),
    elapsed_ms: z.number().int().nonnegative(),
    busy_agent_count: z.number().int().nonnegative(),
  })
  .meta({ title: "__lifecycle hold" });

/** Any failed `__lifecycle` call, printed with a non-zero exit status. */
export const LifecycleErrorSchema = z
  .looseObject({
    lifecycle_protocol: lifecycleProtocol,
    ok: z.literal(false),
    code: z.string().regex(UPGRADE_ERROR_CODE_PATTERN),
    message: z.string(),
  })
  .meta({ title: "__lifecycle error" });
