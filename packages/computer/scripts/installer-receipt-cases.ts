/**
 * The receipts `InstallerReceiptSchema` accepts and refuses, as literals. They are the rows of the
 * status / error code / exit code table the schema documents, written out (never derived from
 * `INSTALLER_EXIT_CODE` or the SDK's codes) so a change to the table is a change here.
 *
 * `scripts/installer-contract.ts` renders them into `crates/installer/contract/receipt-cases.json`
 * and the four `receipt.<slug>.json` goldens; the Rust crate reads that file, builds every allowed
 * receipt through its own constructor, checks that it equals the row, checks that each refused
 * receipt fails to parse, and writes one `receipt.<slug>.json` per allowed row into
 * `crates/installer/contract/rust/`, which `test/installer-contract.test.ts` reads back.
 */

/** The request every example names; the Rust tests use the same one. */
export const EXAMPLE_REQUEST_ID = "0f8b6d5e-2a41-4c3b-9e7d-1a2b3c4d5e6f";

/** Two processes an installer stopped, as a Linux one identifies them (`DeadProcessIdentitySchema`
 * says what each platform writes). */
export const DEAD_PROCESS_IDENTITIES = [
  {
    pid: 4242,
    startedAt: "0d9a7e64-6e5f-4a1b-8c3d-2f4e6a8b0c1d:48213337",
    executable: "/home/example/.coforge/computer/install/versions/0.1.0/coforge-computer",
  },
  {
    pid: 4243,
    startedAt: "0d9a7e64-6e5f-4a1b-8c3d-2f4e6a8b0c1d:48213351",
    executable: "/home/example/.coforge/computer/install/versions/0.1.0/coforge-computer",
  },
];

/** A receipt as the installer writes it, with `fields` deciding the outcome. */
export function receiptOf(fields: Record<string, unknown>) {
  return {
    schema_version: 1,
    request_id: EXAMPLE_REQUEST_ID,
    operation: "upgrade",
    protocol: "coforge-installer/v1",
    installer_version: "0.1.0",
    ...fields,
  };
}

/**
 * Every outcome the installer may record, with the exit status it implies. A run that stopped
 * processes names them; one that failed or was held before touching anything does not.
 */
export const ALLOWED_RECEIPTS = [
  {
    slug: "succeeded",
    fields: {
      status: "succeeded",
      version: "0.2.0",
      supervisorRunning: true,
      runtimes: [{ bindingId: "ws_example", running: true }],
      deadProcessIdentities: DEAD_PROCESS_IDENTITIES,
      exit_code: 0,
    },
  },
  // The product reads a request id case-insensitively (`RFC_UUID_PATTERN`), so a receipt for an id
  // in capitals must be writable too, version and variant digits included.
  {
    slug: "succeeded-uppercase-request-id",
    fields: {
      request_id: "0F8B6D5E-2A41-4C3B-BE7D-1A2B3C4D5E6F",
      status: "succeeded",
      version: "0.2.0",
      exit_code: 0,
    },
  },
  {
    slug: "failed-installer-unavailable",
    fields: {
      status: "failed",
      error: "The release feed did not answer",
      errorCode: "UPGRADE_INSTALLER_UNAVAILABLE",
      exit_code: 1,
    },
  },
  {
    slug: "failed-installer-incompatible",
    fields: {
      status: "failed",
      error: "This version needs a newer installer",
      errorCode: "UPGRADE_INSTALLER_INCOMPATIBLE",
      exit_code: 1,
    },
  },
  {
    slug: "failed",
    fields: { status: "failed", error: "Could not create the staging directory", exit_code: 1 },
  },
  {
    slug: "rolled-back",
    fields: {
      status: "failed",
      restoredVersion: "0.1.0",
      error: "Computer supervisor did not report 0.2.0",
      errorCode: "UPGRADE_ROLLED_BACK",
      deadProcessIdentities: DEAD_PROCESS_IDENTITIES,
      exit_code: 1,
    },
  },
  // No v1 operation is held with a receipt yet; this is what one looks like. It stopped nothing,
  // so it names no processes.
  {
    slug: "held",
    fields: {
      status: "held",
      error:
        "Version 0.1.0 is older than the installed 0.2.0, so the installer held the upgrade before changing anything",
      exit_code: 2,
    },
  },
  {
    slug: "unresolved",
    fields: {
      status: "failed",
      error:
        "Computer supervisor did not report 0.2.0; rollback failed: Computer supervisor did not report 0.1.0",
      errorCode: "UPGRADE_ROLLBACK_FAILED",
      deadProcessIdentities: DEAD_PROCESS_IDENTITIES,
      exit_code: 3,
    },
  },
  {
    slug: "unresolved-no-previous-version",
    fields: {
      status: "failed",
      error: "Computer supervisor did not report 0.1.0 and no previous version existed",
      deadProcessIdentities: DEAD_PROCESS_IDENTITIES,
      exit_code: 3,
    },
  },
] as const;

const DEAD = DEAD_PROCESS_IDENTITIES[0]!;

/** Combinations the schema refuses, and receipts whose dead-process evidence is malformed. */
export const REJECTED_RECEIPTS = [
  { name: "succeeded with exit 1", fields: { status: "succeeded", exit_code: 1 } },
  { name: "succeeded with exit 2", fields: { status: "succeeded", exit_code: 2 } },
  { name: "succeeded with exit 3", fields: { status: "succeeded", exit_code: 3 } },
  {
    name: "succeeded naming an error code",
    fields: { status: "succeeded", errorCode: "UPDATE_FEED_INVALID", exit_code: 0 },
  },
  { name: "failed with exit 0", fields: { status: "failed", error: "x", exit_code: 0 } },
  { name: "failed with exit 2", fields: { status: "failed", error: "x", exit_code: 2 } },
  { name: "failed with an unknown exit", fields: { status: "failed", error: "x", exit_code: 4 } },
  { name: "failed with no reason", fields: { status: "failed", exit_code: 1 } },
  { name: "held with exit 0", fields: { status: "held", error: "x", exit_code: 0 } },
  { name: "held with exit 1", fields: { status: "held", error: "x", exit_code: 1 } },
  { name: "held with exit 3", fields: { status: "held", error: "x", exit_code: 3 } },
  { name: "held with no reason", fields: { status: "held", exit_code: 2 } },
  {
    name: "held naming a rollback code",
    fields: { status: "held", error: "x", errorCode: "UPGRADE_ROLLBACK_FAILED", exit_code: 2 },
  },
  {
    name: "rolled back with exit 3",
    fields: {
      status: "failed",
      error: "x",
      errorCode: "UPGRADE_ROLLED_BACK",
      restoredVersion: "0.1.0",
      exit_code: 3,
    },
  },
  {
    name: "rolled back without the restored version",
    fields: { status: "failed", error: "x", errorCode: "UPGRADE_ROLLED_BACK", exit_code: 1 },
  },
  {
    name: "a restored version without the rolled-back code",
    fields: { status: "failed", error: "x", restoredVersion: "0.1.0", exit_code: 1 },
  },
  {
    name: "rollback failed with exit 1",
    fields: { status: "failed", error: "x", errorCode: "UPGRADE_ROLLBACK_FAILED", exit_code: 1 },
  },
  {
    name: "exit 3 with a code other than rollback failed",
    fields: { status: "failed", error: "x", errorCode: "UPDATE_FEED_INVALID", exit_code: 3 },
  },
  {
    name: "an error code in the wrong format",
    fields: { status: "failed", error: "x", errorCode: "not-a-code", exit_code: 1 },
  },
  { name: "an unknown status", fields: { status: "running", error: "x", exit_code: 1 } },
  {
    name: "a receipt of another protocol",
    fields: { status: "succeeded", exit_code: 0, protocol: "coforge-installer/v2" },
  },
  {
    name: "a receipt of another schema version",
    fields: { status: "succeeded", exit_code: 0, schema_version: 2 },
  },
  {
    name: "a receipt for another operation",
    fields: { status: "succeeded", exit_code: 0, operation: "rollback" },
  },
  {
    name: "a request id with a version digit outside 1-8",
    fields: {
      status: "succeeded",
      exit_code: 0,
      request_id: "0f8b6d5e-2a41-9c3b-9e7d-1a2b3c4d5e6f",
    },
  },
  {
    name: "a request id with a variant digit outside 8-b",
    fields: {
      status: "succeeded",
      exit_code: 0,
      request_id: "0F8B6D5E-2A41-4C3B-CE7D-1A2B3C4D5E6F",
    },
  },
  {
    name: "a request id that is not a UUID",
    fields: { status: "succeeded", exit_code: 0, request_id: "request-a" },
  },
  {
    name: "dead-process evidence as a JSON string holding an array",
    fields: { status: "succeeded", exit_code: 0, deadProcessIdentities: JSON.stringify([DEAD]) },
  },
  {
    name: "dead-process evidence as an empty array",
    fields: { status: "succeeded", exit_code: 0, deadProcessIdentities: [] },
  },
  {
    name: "a dead process with a string pid",
    fields: {
      status: "succeeded",
      exit_code: 0,
      deadProcessIdentities: [{ ...DEAD, pid: "4242" }],
    },
  },
  {
    name: "a dead process with pid 0",
    fields: { status: "succeeded", exit_code: 0, deadProcessIdentities: [{ ...DEAD, pid: 0 }] },
  },
  {
    name: "a dead process with a fractional pid",
    fields: { status: "succeeded", exit_code: 0, deadProcessIdentities: [{ ...DEAD, pid: 1.5 }] },
  },
  {
    name: "a dead process with no start time",
    fields: {
      status: "succeeded",
      exit_code: 0,
      deadProcessIdentities: [{ pid: DEAD.pid, executable: DEAD.executable }],
    },
  },
  {
    name: "a dead process with a numeric start time",
    fields: {
      status: "succeeded",
      exit_code: 0,
      deadProcessIdentities: [{ ...DEAD, startedAt: 48213337 }],
    },
  },
  {
    name: "a dead process with an empty start time",
    fields: {
      status: "succeeded",
      exit_code: 0,
      deadProcessIdentities: [{ ...DEAD, startedAt: "" }],
    },
  },
  {
    name: "a dead process with no executable",
    fields: {
      status: "succeeded",
      exit_code: 0,
      deadProcessIdentities: [{ pid: DEAD.pid, startedAt: DEAD.startedAt }],
    },
  },
  {
    name: "a dead process with an empty executable",
    fields: {
      status: "succeeded",
      exit_code: 0,
      deadProcessIdentities: [{ ...DEAD, executable: "" }],
    },
  },
] as const;
