/**
 * Renders the cross-language contract with the Rust installer into crates/installer/contract/: a JSON
 * Schema for every JSON shape (z.toJSONSchema, draft 2020-12; https://zod.dev/json-schema) and a
 * golden instance of every file either side writes or reads. The TypeScript modules named in each
 * entry are the source of truth; the Rust crate's tests read these files and write their own
 * output into crates/installer/contract/rust/, which test/installer-contract.test.ts reads back.
 *
 * Run `bun run generate:installer-contract` after changing any of those modules. CI regenerates
 * and fails when the committed files differ.
 */
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  computerUpgradeJobLabel,
  computerUpgradeTaskName,
  computerUpgradeUnitName,
  COORDINATOR_SERVICE,
  PROCESS_LOCK_CONTENTION_CODES,
  PROCESS_LOCK_STATEMENTS,
} from "@lrm/coforge-daemon";
import {
  isValidReleaseVersion,
  UPGRADE_ERROR_CODE,
  UPGRADE_ERROR_CODE_PATTERN,
} from "@lrm/coforge-sdk/internal";
import { z } from "zod";

import {
  resolveComputerBinaryDirectory,
  resolveComputerInstallDirectory,
  resolveComputerStateDirectory,
} from "#src/paths";
import { DEFAULT_RELEASE_FEED_URL, OFFICIAL_RELEASE_ENVIRONMENTS } from "#src/release-channel";
import {
  INSTALLER_EXIT_CODE,
  INSTALLER_PROTOCOL,
  INSTALLER_RECEIPT_PROTOCOL,
  InstallerManifestSchema,
  InstallerReceiptSchema,
  LIFECYCLE_ERROR_CODE,
  LIFECYCLE_EXIT_CODE,
  LIFECYCLE_PROTOCOL,
  LifecycleErrorSchema,
  LifecycleProtocolSchema,
  LifecycleStatusSchema,
} from "#src/release/installer-contract";
import { SUPERVISOR_PROBLEM_CODE } from "#src/release/supervisor-status";
import {
  ActiveStateSchema,
  agentCliLauncher,
  githubCliLauncher,
  InstalledIdentitySchema,
  MACHINE_MUTATION_LOCK_FILE,
  ReleaseManifestSchema,
  windowsComputerLauncher,
} from "#src/updater";

export const CONTRACT_DIRECTORY = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "crates",
  "installer",
  "contract",
);

/** Version strings on both sides of every rule in `isValidReleaseVersion`. */
const RELEASE_VERSION_SAMPLES = [
  "0.1.0",
  "0.1.1-dev.42",
  "1.2.3+build.5",
  "latest",
  "A-Z_z",
  "",
  ".",
  "..",
  "1..2",
  "1.2.",
  ".1",
  "-rc",
  "rc-",
  "1/2",
  "1\\2",
  "1 2",
  " 1.0.0",
  "1.0.0\n",
  "v1.0.0",
  "版本",
  "1".repeat(100),
  "1".repeat(101),
];

/** The request every example names; the Rust tests use the same one. */
export const EXAMPLE_REQUEST_ID = "0f8b6d5e-2a41-4c3b-9e7d-1a2b3c4d5e6f";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const BUILD_DATE = "2026-09-29T00:00:00.000Z";

function identity(size: number, digit: string) {
  return { size, checksum: digit.repeat(64) };
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** A golden instance, validated by its schema so an example can never drift from the contract. */
function instance(schema: z.ZodType, value: unknown): string {
  return json(schema.parse(value));
}

function jsonSchema(schema: z.ZodType): string {
  return json(z.toJSONSchema(schema));
}

function computerArtifact(size: number) {
  return {
    binary: "coforge-computer",
    ...identity(size, "a"),
    gzip: { binary: "coforge-computer.gz", ...identity(Math.floor(size / 3), "b") },
  };
}

function installerArtifact(windows: boolean) {
  const file = windows ? "coforge-installer.exe" : "coforge-installer";
  return {
    installer: {
      file,
      ...identity(1_572_864, "e"),
      gzip: { file: `${file}.gz`, ...identity(786_432, "f") },
    },
  };
}

const HOMES = { posix: "/home/example", darwin: "/Users/example", win32: "C:\\Users\\example" };

function pathCase(
  platform: "linux" | "darwin" | "win32",
  home: string,
  environment: Record<string, string>,
) {
  const input = { platform, homeDirectory: home, environment };
  return {
    platform,
    home,
    environment,
    install_root: resolveComputerInstallDirectory(input),
    state_directory: resolveComputerStateDirectory(input),
    binary_directory: resolveComputerBinaryDirectory(input),
  };
}

/**
 * Homes and `XDG_BIN_HOME` values that `posix.join` and `win32.join` rewrite: the root, doubled or
 * trailing separators, `.` and `..` segments, forward slashes on Windows, UNC and drive roots, and
 * no home at all. The Rust installer reproduces each result byte for byte, so a string comparison
 * against these is what proves it resolves the same directories as the Computer.
 */
const ADVERSARIAL_PATH_CASES = [
  pathCase("linux", "/", {}),
  pathCase("linux", "/home//example/", {}),
  pathCase("linux", "/home/./example", {}),
  pathCase("linux", "/home/example/../example", {}),
  pathCase("linux", "/home/../../example", {}),
  pathCase("linux", "../example", {}),
  pathCase("linux", "", {}),
  pathCase("darwin", "/Users/example/", {}),
  // An absolute XDG_BIN_HOME is used as written, separators and all; an empty one is ignored.
  pathCase("darwin", HOMES.darwin, { XDG_BIN_HOME: "/Users//example/./bin/" }),
  pathCase("linux", HOMES.posix, { XDG_BIN_HOME: "" }),
  pathCase("win32", "C:/Users/example", {}),
  pathCase("win32", "C:\\Users\\example\\", {}),
  pathCase("win32", "C:\\Users\\\\example", {}),
  pathCase("win32", "\\\\server\\share\\example", {}),
  pathCase("win32", "//server/share/example", {}),
  pathCase("win32", "C:\\", {}),
  pathCase("win32", "C:\\Users\\..\\..\\example", {}),
  pathCase("win32", "\\home\\example", {}),
  pathCase("win32", "..\\example", {}),
  pathCase("win32", "", {}),
  pathCase("linux", "/ab/../x", {}),
  pathCase("win32", "/", {}),
  pathCase("win32", "\\", {}),
  pathCase("win32", "///x", {}),
  pathCase("win32", "a:b", {}),
];

function receipt(fields: Record<string, unknown>) {
  return {
    schema_version: 1,
    request_id: EXAMPLE_REQUEST_ID,
    operation: "upgrade",
    ...fields,
    protocol: INSTALLER_RECEIPT_PROTOCOL,
    installer_version: "0.1.0",
  };
}

/** Every contract file, by name under crates/installer/contract/. */
export function renderInstallerContract(): Map<string, string> {
  const windowsInstallRoot = resolveComputerInstallDirectory({
    platform: "win32",
    homeDirectory: HOMES.win32,
    environment: {},
  });
  const requestScoped = (name: string) => name.replace(EXAMPLE_REQUEST_ID, "{request_id}");
  const files: [string, string][] = [
    // Release manifest schema 2 (updater.ts reads it; scripts/release/build-release.ts writes it).
    ["manifest.schema.json", jsonSchema(ReleaseManifestSchema)],
    [
      "manifest.v2.json",
      instance(ReleaseManifestSchema, {
        schema_version: 2,
        version: "0.2.0",
        commit: COMMIT,
        buildDate: BUILD_DATE,
        platforms: {
          "darwin-arm64": { computer: computerArtifact(71_303_168) },
          "windows-x64": { computer: computerArtifact(125_829_120) },
        },
        photonWasm: { file: "photon_rs_bg.wasm", ...identity(1_843_200, "c") },
        installer_protocol: INSTALLER_PROTOCOL,
      }),
    ],
    // The installer's own release manifest (installer-contract.ts).
    ["installer-manifest.schema.json", jsonSchema(InstallerManifestSchema)],
    [
      "installer-manifest.v1.json",
      instance(InstallerManifestSchema, {
        schema_version: 1,
        version: "0.1.0",
        commit: COMMIT,
        buildDate: BUILD_DATE,
        installer_protocol: INSTALLER_PROTOCOL,
        platforms: {
          "darwin-arm64": installerArtifact(false),
          "linux-x64": installerArtifact(false),
          "windows-x64": installerArtifact(true),
        },
      }),
    ],
    // Version store (updater.ts).
    ["active.schema.json", jsonSchema(ActiveStateSchema)],
    [
      "active.v1.json",
      instance(ActiveStateSchema, { schema_version: 1, current: "0.2.0", previous: "0.1.0" }),
    ],
    ["installation.schema.json", jsonSchema(InstalledIdentitySchema)],
    [
      "installation.v2.json",
      instance(InstalledIdentitySchema, {
        schema_version: 2,
        version: "0.0.8",
        computer: identity(70_254_592, "a"),
        agentCli: identity(63, "b"),
      }),
    ],
    [
      "installation.v3.json",
      instance(InstalledIdentitySchema, {
        schema_version: 3,
        version: "0.0.9",
        computer: identity(70_254_592, "a"),
        agentCli: identity(63, "b"),
        githubCli: identity(74, "c"),
      }),
    ],
    [
      "installation.v4.json",
      instance(InstalledIdentitySchema, {
        schema_version: 4,
        version: "0.1.0",
        computer: identity(71_303_168, "a"),
        agentCli: identity(63, "b"),
        githubCli: identity(74, "c"),
        photonWasm: identity(1_843_200, "d"),
      }),
    ],
    // Launchers written next to each version, and Windows' PATH shim (updater.ts).
    [
      "launchers.posix.json",
      json({
        agentCli: { file: "coforge", contents: agentCliLauncher(false) },
        githubCli: { file: "gh", contents: githubCliLauncher(false) },
      }),
    ],
    [
      "launchers.windows.json",
      json({
        agentCli: { file: "coforge.cmd", contents: agentCliLauncher(true) },
        githubCli: { file: "gh.cmd", contents: githubCliLauncher(true) },
        // The PATH shim embeds the install root, so it is rendered for an example one. Its CRLF
        // bytes live only as JSON escapes: a raw .cmd golden would fail `git diff --check`.
        shim: {
          file: "coforge-computer.cmd",
          install_root: windowsInstallRoot,
          contents: windowsComputerLauncher(windowsInstallRoot),
        },
      }),
    ],
    // Upgrade receipts (upgrade-coordinator.ts, installer-contract.ts). No receipt is ever
    // "held": that is only the installer's process exit status.
    ["receipt.schema.json", jsonSchema(InstallerReceiptSchema)],
    [
      "receipt.succeeded.json",
      instance(
        InstallerReceiptSchema,
        receipt({
          status: "succeeded",
          version: "0.2.0",
          supervisorRunning: true,
          runtimes: [{ bindingId: "ws_example", running: true }],
          exit_code: INSTALLER_EXIT_CODE.SUCCEEDED,
        }),
      ),
    ],
    [
      "receipt.rolled-back.json",
      instance(
        InstallerReceiptSchema,
        receipt({
          status: "failed",
          restoredVersion: "0.1.0",
          error: "Computer supervisor did not report 0.2.0",
          errorCode: UPGRADE_ERROR_CODE.ROLLED_BACK,
          exit_code: INSTALLER_EXIT_CODE.FAILED,
        }),
      ),
    ],
    [
      "receipt.unresolved.json",
      instance(
        InstallerReceiptSchema,
        receipt({
          status: "failed",
          error:
            "Computer supervisor did not report 0.2.0; rollback failed: Computer supervisor did not report 0.1.0",
          errorCode: UPGRADE_ERROR_CODE.ROLLBACK_FAILED,
          exit_code: INSTALLER_EXIT_CODE.UNRESOLVED,
        }),
      ),
    ],
    // The Coordinator writes supervisor.lock/owner as its bare process ID.
    ["supervisor-lock-owner.txt", "4242"],
    // Machine mutation lock (updater.ts, @lrm/coforge-daemon process-lock.ts).
    [
      "lock.json",
      json({
        directory: "install_root",
        file: MACHINE_MUTATION_LOCK_FILE,
        mode: "0600",
        engine: "sqlite",
        statements: PROCESS_LOCK_STATEMENTS,
        contention_codes: PROCESS_LOCK_CONTENTION_CODES,
        busy_error_code: UPGRADE_ERROR_CODE.UPDATE_BUSY,
        held_for: "the whole install, upgrade, or repair transaction",
      }),
    ],
    // Services the product installs and the installer controls (@lrm/coforge-daemon).
    [
      "service-identities.json",
      json({
        coordinator: {
          launchd_label: COORDINATOR_SERVICE.launchdLabel,
          launchd_domain: "gui/{uid}",
          systemd_user_unit: COORDINATOR_SERVICE.systemdUserUnit,
          windows_task: COORDINATOR_SERVICE.windowsTask,
        },
        upgrade_job: {
          launchd_label: requestScoped(computerUpgradeJobLabel(EXAMPLE_REQUEST_ID)),
          systemd_user_unit: requestScoped(computerUpgradeUnitName(EXAMPLE_REQUEST_ID)),
          windows_task: requestScoped(computerUpgradeTaskName(EXAMPLE_REQUEST_ID)),
        },
      }),
    ],
    // Installation roots (paths.ts), resolved by the real functions.
    [
      "paths.json",
      json({
        home_directory:
          "os.homedir(): HOME on POSIX, else the account's passwd entry; USERPROFILE on Windows, else the profile directory",
        cases: [
          pathCase("linux", HOMES.posix, {}),
          pathCase("linux", HOMES.posix, { XDG_BIN_HOME: "/home/example/bin" }),
          pathCase("linux", HOMES.posix, { XDG_BIN_HOME: "relative/bin" }),
          pathCase("darwin", HOMES.darwin, {}),
          pathCase("win32", HOMES.win32, {}),
          pathCase("win32", HOMES.win32, { XDG_BIN_HOME: "C:\\bin" }),
          ...ADVERSARIAL_PATH_CASES,
        ],
      }),
    ],
    // `coforge-computer __lifecycle` output (installer-contract.ts).
    ["lifecycle.protocol.schema.json", jsonSchema(LifecycleProtocolSchema)],
    [
      "lifecycle.protocol.json",
      instance(LifecycleProtocolSchema, {
        lifecycle_protocol: LIFECYCLE_PROTOCOL,
        version: "0.2.0",
      }),
    ],
    ["lifecycle.status.schema.json", jsonSchema(LifecycleStatusSchema)],
    [
      "lifecycle.status.running.json",
      instance(LifecycleStatusSchema, {
        lifecycle_protocol: LIFECYCLE_PROTOCOL,
        version: "0.1.0",
        supervisor: { running: true, id: "supervisor_example", version: "0.1.0" },
        bindings: [
          { binding_id: "ws_example", enabled: true, running: true, process_id: 4243 },
          { binding_id: "ws_stopped", enabled: false, running: false, process_id: null },
        ],
        healthy: true,
        problems: [],
      }),
    ],
    [
      "lifecycle.status.absent.json",
      instance(LifecycleStatusSchema, {
        lifecycle_protocol: LIFECYCLE_PROTOCOL,
        version: "0.1.0",
        supervisor: { running: false },
        bindings: [{ binding_id: "ws_example", enabled: true, running: false, process_id: null }],
        healthy: false,
        problems: [
          {
            code: SUPERVISOR_PROBLEM_CODE.SUPERVISOR_NOT_RUNNING,
            message:
              "configured running bindings have no healthy supervisor. Run 'coforge-computer start' to recover them, then upgrade again.",
          },
        ],
      }),
    ],
    ["lifecycle.error.schema.json", jsonSchema(LifecycleErrorSchema)],
    [
      "lifecycle.error.json",
      instance(LifecycleErrorSchema, {
        lifecycle_protocol: LIFECYCLE_PROTOCOL,
        ok: false,
        code: LIFECYCLE_ERROR_CODE.FAILED,
        message: "invalid process identity",
      }),
    ],
    // `__lifecycle` exit statuses and error codes (installer-contract.ts) and status problem codes
    // (release/supervisor-status.ts).
    [
      "lifecycle-codes.json",
      json({
        exit_codes: LIFECYCLE_EXIT_CODE,
        error_codes: LIFECYCLE_ERROR_CODE,
        problem_codes: SUPERVISOR_PROBLEM_CODE,
      }),
    ],
    // Which release version strings are valid (@lrm/coforge-sdk release-version.ts). A version is
    // a URL segment and a directory under versions/, so both sides must agree on every edge.
    [
      "release-versions.json",
      json({
        cases: RELEASE_VERSION_SAMPLES.map((value) => ({
          value,
          valid: isValidReleaseVersion(value),
        })),
      }),
    ],
    // Error codes the installer may report (@lrm/coforge-sdk).
    [
      "upgrade-error-codes.json",
      json({ pattern: UPGRADE_ERROR_CODE_PATTERN.source, codes: UPGRADE_ERROR_CODE }),
    ],
    // Official feeds and their servers (release-channel.ts).
    [
      "feed-environments.json",
      json({ default_feed: DEFAULT_RELEASE_FEED_URL, environments: OFFICIAL_RELEASE_ENVIRONMENTS }),
    ],
  ];
  return new Map(files);
}

/** Replaces every generated file, leaving dotfiles and the Rust output directory alone. */
export async function writeInstallerContract(): Promise<void> {
  const rendered = renderInstallerContract();
  await mkdir(CONTRACT_DIRECTORY, { recursive: true });
  for (const entry of await readdir(CONTRACT_DIRECTORY, { withFileTypes: true })) {
    if (entry.isFile() && !entry.name.startsWith(".") && !rendered.has(entry.name))
      await rm(join(CONTRACT_DIRECTORY, entry.name));
  }
  for (const [name, contents] of rendered)
    await writeFile(join(CONTRACT_DIRECTORY, name), contents);
}

if (import.meta.main) await writeInstallerContract();
