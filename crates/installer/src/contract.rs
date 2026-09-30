//! The files and JSON this installer shares with the CoForge Computer product.
//!
//! The TypeScript product is the source of truth: `packages/computer` defines each shape with zod
//! and generates JSON Schema plus golden instances into `crates/installer/contract/`
//! (`bun run --cwd packages/computer generate:installer-contract`). These types read and write
//! the same shapes. Every struct ignores fields it does not know, because a contract version only
//! ever gains fields; tests in `contract/tests.rs` read every golden and round-trip it, and write
//! what this crate produces into `contract/rust/`, which a TypeScript test reads back.

use std::collections::BTreeMap;
use std::fmt;

use serde::{Deserialize, Serialize};

/// The installer protocol this build implements (`installer_protocol` in both manifests).
pub const INSTALLER_PROTOCOL: u32 = 1;
/// `schema_version` of the product release manifest.
pub const RELEASE_MANIFEST_SCHEMA_VERSION: u32 = 2;
/// `schema_version` of the installer's own release manifest.
pub const INSTALLER_MANIFEST_SCHEMA_VERSION: u32 = 1;
/// `schema_version` of `active.json`.
pub const ACTIVE_STATE_SCHEMA_VERSION: u32 = 1;
/// `schema_version` of a newly written `installation.json`; 2 and 3 are still read.
pub const INSTALLED_IDENTITY_SCHEMA_VERSION: u32 = 4;
/// `schema_version` of an upgrade receipt.
pub const RECEIPT_SCHEMA_VERSION: u32 = 1;
/// `protocol` of every receipt this installer writes.
pub const INSTALLER_RECEIPT_PROTOCOL: &str = "coforge-installer/v1";
/// Version of the JSON `coforge-computer __lifecycle` prints.
pub const LIFECYCLE_PROTOCOL: u32 = 1;

/// Exit status: the operation succeeded.
pub const EXIT_SUCCEEDED: u8 = 0;
/// Exit status: failed before any change, or rolled back to the previous version (a receipt).
/// Also a usage error, which writes no receipt: no operation began.
pub const EXIT_FAILED: u8 = 1;
/// Exit status: the operation was stopped on purpose before it settled. With a receipt its status
/// is [`ReceiptStatus::Held`]. Without one: the machine mutation lock is held by another run, or
/// the request id was already used for a different operation or target; both write nothing.
/// Busy Agents never hold an operation.
pub const EXIT_HELD: u8 = 2;
/// Exit status: rollback failed, or no previous version existed to roll back to (a receipt).
/// Also, without a receipt: recovery state exists and the operation is not `recover` or `repair`;
/// the message names `coforge-installer recover`.
pub const EXIT_UNRESOLVED: u8 = 3;
/// The largest receipt file a reader accepts; it treats a larger one as no receipt.
pub const RECEIPT_MAX_BYTES: u64 = 64 * 1024;

/// Byte size and lowercase hex SHA-256 of one file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArtifactIdentity {
    pub size: u64,
    pub checksum: String,
}

/// `<version>/manifest.json` of the product feed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReleaseManifest {
    pub schema_version: u32,
    pub version: String,
    pub commit: String,
    #[serde(rename = "buildDate")]
    pub build_date: String,
    pub platforms: BTreeMap<String, ReleasePlatform>,
    #[serde(rename = "photonWasm")]
    pub photon_wasm: NamedArtifact,
    /// The lowest installer protocol that can install this version.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub installer_protocol: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReleasePlatform {
    pub computer: ComputerArtifact,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ComputerArtifact {
    pub binary: String,
    #[serde(flatten)]
    pub identity: ArtifactIdentity,
    pub gzip: GzipObject,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GzipObject {
    pub binary: String,
    #[serde(flatten)]
    pub identity: ArtifactIdentity,
}

/// A feed object named by `file`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NamedArtifact {
    pub file: String,
    #[serde(flatten)]
    pub identity: ArtifactIdentity,
}

/// `installer/<version>/manifest.json` of the installer feed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstallerManifest {
    pub schema_version: u32,
    pub version: String,
    pub commit: String,
    #[serde(rename = "buildDate")]
    pub build_date: String,
    pub installer_protocol: u32,
    pub platforms: BTreeMap<String, InstallerPlatform>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstallerPlatform {
    pub installer: InstallerArtifact,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstallerArtifact {
    pub file: String,
    #[serde(flatten)]
    pub identity: ArtifactIdentity,
    pub gzip: NamedArtifact,
}

/// `<install root>/active.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActiveState {
    pub schema_version: u32,
    pub current: String,
    /// Always written, as `null` when there is no previous version.
    pub previous: Option<String>,
}

/// `versions/<version>/installation.json`. Schema 3 added `githubCli`, schema 4 `photonWasm`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstalledIdentity {
    pub schema_version: u32,
    pub version: String,
    pub computer: ArtifactIdentity,
    #[serde(rename = "agentCli")]
    pub agent_cli: ArtifactIdentity,
    #[serde(rename = "githubCli", default, skip_serializing_if = "Option::is_none")]
    pub github_cli: Option<ArtifactIdentity>,
    #[serde(
        rename = "photonWasm",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub photon_wasm: Option<ArtifactIdentity>,
}

/// One launcher file written into each version directory.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LauncherFile {
    pub file: String,
    pub contents: String,
}

/// The `coforge` and `gh` launchers of one platform family.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Launchers {
    #[serde(rename = "agentCli")]
    pub agent_cli: LauncherFile,
    #[serde(rename = "githubCli")]
    pub github_cli: LauncherFile,
}

/// Windows launchers plus the `coforge-computer.cmd` PATH shim, rendered for an example root.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WindowsLaunchers {
    #[serde(flatten)]
    pub launchers: Launchers,
    pub shim: WindowsShim,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WindowsShim {
    pub file: String,
    pub install_root: String,
    pub contents: String,
}

/// The version-local `coforge` launcher that runs the adjacent executable's Agent CLI.
pub fn agent_cli_launcher(windows: bool) -> &'static str {
    if windows {
        "@echo off\r\n\"%~dp0coforge-computer.exe\" __agent-cli %*\r\n"
    } else {
        "#!/bin/sh\nexec \"${0%/*}/coforge-computer\" __agent-cli \"$@\"\n"
    }
}

/// The version-local `gh` launcher that runs the adjacent executable's GitHub CLI bridge.
pub fn github_cli_launcher(windows: bool) -> &'static str {
    if windows {
        "@echo off\r\n\"%~dp0coforge-computer.exe\" __agent-cli github gh %*\r\n"
    } else {
        "#!/bin/sh\nexec \"${0%/*}/coforge-computer\" __agent-cli github gh \"$@\"\n"
    }
}

/// Windows' PATH shim `coforge-computer.cmd`: reads `active.json` on every run and starts that
/// version's executable. `install_root` is a Windows path without a trailing separator.
pub fn windows_computer_launcher(install_root: &str) -> String {
    let active_json = format!("{install_root}\\active.json").replace('\'', "''");
    [
        "@echo off".to_owned(),
        format!(
            "for /f \"usebackq tokens=*\" %%i in (`powershell -NoProfile -Command \"(Get-Content -Raw '{active_json}' | ConvertFrom-Json).current\"`) do set COFORGE_ACTIVE=%%i"
        ),
        format!("\"{install_root}\\versions\\%COFORGE_ACTIVE%\\coforge-computer.exe\" %*"),
        String::new(),
    ]
    .join("\r\n")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReceiptStatus {
    Succeeded,
    Failed,
    Held,
}

/// `error_code` of a receipt whose upgrade was rolled back to the previous version.
pub const ERROR_CODE_ROLLED_BACK: &str = "UPGRADE_ROLLED_BACK";
/// `error_code` of a receipt whose rollback failed.
pub const ERROR_CODE_ROLLBACK_FAILED: &str = "UPGRADE_ROLLBACK_FAILED";

/// How an upgrade ended. It fixes a receipt's status, error code, and exit code together, so a
/// receipt cannot pair them wrongly (`InstallerReceiptSchema` in the product has the table).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReceiptOutcome {
    /// Exit 0.
    Succeeded { version: String },
    /// Exit 1: failed before any change. `error_code` is one of the SDK's, never a rollback code,
    /// or `None` when none of them describes the failure.
    Failed {
        error: String,
        error_code: Option<String>,
    },
    /// Exit 1, `UPGRADE_ROLLED_BACK`: failed after a change and restored `restored_version`.
    RolledBack {
        error: String,
        restored_version: String,
    },
    /// Exit 2: stopped on purpose before it settled. `error_code` as for [`Self::Failed`].
    Held {
        error: String,
        error_code: Option<String>,
    },
    /// Exit 3: the rollback failed (`UPGRADE_ROLLBACK_FAILED`) or, when `rollback_failed` is
    /// false, no previous version existed to roll back to (no code).
    Unresolved {
        error: String,
        rollback_failed: bool,
    },
}

/// A receipt that breaks a rule the product's schema states.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvalidReceipt(String);

impl fmt::Display for InvalidReceipt {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "invalid upgrade receipt: {}", self.0)
    }
}

impl std::error::Error for InvalidReceipt {}

/// The JSON fields of a receipt, as they are written; [`UpgradeReceipt`] holds only ones that
/// [`validate`] accepts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct ReceiptFields {
    schema_version: u32,
    request_id: String,
    operation: String,
    status: ReceiptStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    version: Option<String>,
    #[serde(
        rename = "restoredVersion",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    restored_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(rename = "errorCode", default, skip_serializing_if = "Option::is_none")]
    error_code: Option<String>,
    #[serde(
        rename = "supervisorRunning",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    supervisor_running: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    runtimes: Option<Vec<RuntimeState>>,
    #[serde(
        rename = "deadProcessIdentities",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    dead_process_identities: Option<Vec<DeadProcessIdentity>>,
    protocol: String,
    exit_code: u8,
    installer_version: String,
}

/// `<install root>/upgrade-results/<request id>.result.json`: one receipt per request id, written
/// atomically and never overwritten. A repeated request id for the same operation and target
/// replays the stored receipt and its exit status; a different operation or target is held
/// without a receipt. Keep it under [`RECEIPT_MAX_BYTES`].
///
/// The status and error code fix the exit code (`InstallerReceiptSchema` in the product has the
/// table): succeeded is 0; failed is 1, or 3 when the rollback failed (`UPGRADE_ROLLBACK_FAILED`)
/// or had nothing to roll back to (no code); held is 2. `UPGRADE_ROLLED_BACK` goes with
/// `restoredVersion` and exit 1. A receipt that is not succeeded says why in `error`.
///
/// A receipt that breaks those rules cannot exist: [`UpgradeReceipt::new`] derives the exit code
/// from a [`ReceiptOutcome`] and refuses an invalid one, and reading a receipt applies the same
/// rules as the schema.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpgradeReceipt(ReceiptFields);

impl UpgradeReceipt {
    /// The receipt of one upgrade. `dead_process_identities` names the processes the installer
    /// stopped and is left out of the receipt when empty.
    pub fn new(
        request_id: &str,
        outcome: ReceiptOutcome,
        dead_process_identities: Vec<DeadProcessIdentity>,
    ) -> Result<Self, InvalidReceipt> {
        let (status, exit_code, version, restored_version, error, error_code) = match outcome {
            ReceiptOutcome::Succeeded { version } => (
                ReceiptStatus::Succeeded,
                EXIT_SUCCEEDED,
                Some(version),
                None,
                None,
                None,
            ),
            ReceiptOutcome::Failed { error, error_code } => (
                ReceiptStatus::Failed,
                EXIT_FAILED,
                None,
                None,
                Some(error),
                error_code,
            ),
            ReceiptOutcome::RolledBack {
                error,
                restored_version,
            } => (
                ReceiptStatus::Failed,
                EXIT_FAILED,
                None,
                Some(restored_version),
                Some(error),
                Some(ERROR_CODE_ROLLED_BACK.to_owned()),
            ),
            ReceiptOutcome::Held { error, error_code } => (
                ReceiptStatus::Held,
                EXIT_HELD,
                None,
                None,
                Some(error),
                error_code,
            ),
            ReceiptOutcome::Unresolved {
                error,
                rollback_failed,
            } => (
                ReceiptStatus::Failed,
                EXIT_UNRESOLVED,
                None,
                None,
                Some(error),
                rollback_failed.then(|| ERROR_CODE_ROLLBACK_FAILED.to_owned()),
            ),
        };
        let fields = ReceiptFields {
            schema_version: RECEIPT_SCHEMA_VERSION,
            request_id: request_id.to_owned(),
            operation: "upgrade".to_owned(),
            status,
            version,
            restored_version,
            error,
            error_code,
            supervisor_running: None,
            runtimes: None,
            dead_process_identities: (!dead_process_identities.is_empty())
                .then_some(dead_process_identities),
            protocol: INSTALLER_RECEIPT_PROTOCOL.to_owned(),
            exit_code,
            installer_version: env!("CARGO_PKG_VERSION").to_owned(),
        };
        validate(&fields)?;
        Ok(Self(fields))
    }

    /// Adds what `__lifecycle status` said about the supervisor and its Workspace runtimes.
    #[must_use]
    pub fn with_runtimes(mut self, supervisor_running: bool, runtimes: Vec<RuntimeState>) -> Self {
        self.0.supervisor_running = Some(supervisor_running);
        self.0.runtimes = Some(runtimes);
        self
    }

    pub fn request_id(&self) -> &str {
        &self.0.request_id
    }

    pub fn status(&self) -> ReceiptStatus {
        self.0.status
    }

    /// The exit status this receipt implies (0, 1, 2, or 3), which a replay exits with.
    pub fn exit_code(&self) -> u8 {
        self.0.exit_code
    }

    pub fn version(&self) -> Option<&str> {
        self.0.version.as_deref()
    }

    pub fn restored_version(&self) -> Option<&str> {
        self.0.restored_version.as_deref()
    }

    pub fn error(&self) -> Option<&str> {
        self.0.error.as_deref()
    }

    pub fn error_code(&self) -> Option<&str> {
        self.0.error_code.as_deref()
    }

    pub fn supervisor_running(&self) -> Option<bool> {
        self.0.supervisor_running
    }

    pub fn runtimes(&self) -> Option<&[RuntimeState]> {
        self.0.runtimes.as_deref()
    }

    /// The processes the installer stopped; present, and never empty, exactly when it stopped any.
    pub fn dead_process_identities(&self) -> Option<&[DeadProcessIdentity]> {
        self.0.dead_process_identities.as_deref()
    }

    pub fn protocol(&self) -> &str {
        &self.0.protocol
    }

    pub fn installer_version(&self) -> &str {
        &self.0.installer_version
    }
}

impl Serialize for UpgradeReceipt {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.0.serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for UpgradeReceipt {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let fields = ReceiptFields::deserialize(deserializer)?;
        validate(&fields).map_err(serde::de::Error::custom)?;
        Ok(Self(fields))
    }
}

/// The rules of `InstallerReceiptSchema`: fixed fields, the pairing of status, error code, and
/// exit code, and well-formed dead-process evidence.
fn validate(fields: &ReceiptFields) -> Result<(), InvalidReceipt> {
    let invalid = |reason: &str| Err(InvalidReceipt(reason.to_owned()));
    if fields.schema_version != RECEIPT_SCHEMA_VERSION {
        return invalid("schema_version is not 1");
    }
    if fields.operation != "upgrade" {
        return invalid("operation is not upgrade");
    }
    if fields.protocol != INSTALLER_RECEIPT_PROTOCOL {
        return invalid("protocol is not coforge-installer/v1");
    }
    if !is_request_id(&fields.request_id) {
        return invalid("request_id is not a UUID");
    }
    let code = fields.error_code.as_deref();
    if code.is_some_and(|code| !is_error_code(code)) {
        return invalid("errorCode is not an upper-case code");
    }
    let has_reason = fields
        .error
        .as_deref()
        .is_some_and(|error| !error.is_empty());
    let restored = fields.restored_version.as_deref();
    let rollback_code = matches!(
        code,
        Some(ERROR_CODE_ROLLED_BACK | ERROR_CODE_ROLLBACK_FAILED)
    );
    let paired = match (fields.status, fields.exit_code) {
        (ReceiptStatus::Succeeded, EXIT_SUCCEEDED) => code.is_none() && restored.is_none(),
        (ReceiptStatus::Held, EXIT_HELD) => has_reason && !rollback_code && restored.is_none(),
        (ReceiptStatus::Failed, EXIT_FAILED) if code == Some(ERROR_CODE_ROLLED_BACK) => {
            has_reason && restored.is_some_and(|version| !version.is_empty())
        }
        (ReceiptStatus::Failed, EXIT_FAILED) => has_reason && !rollback_code && restored.is_none(),
        (ReceiptStatus::Failed, EXIT_UNRESOLVED) => {
            has_reason
                && matches!(code, None | Some(ERROR_CODE_ROLLBACK_FAILED))
                && restored.is_none()
        }
        (status, exit_code) => {
            return Err(InvalidReceipt(format!(
                "a {status:?} receipt cannot exit with {exit_code}"
            )));
        }
    };
    if !paired {
        return Err(InvalidReceipt(format!(
            "a {:?} receipt with exit {} cannot carry error {:?}, errorCode {:?}, restoredVersion {:?}",
            fields.status, fields.exit_code, fields.error, code, restored
        )));
    }
    if let Some(processes) = &fields.dead_process_identities
        && (processes.is_empty() || !processes.iter().all(DeadProcessIdentity::is_identified))
    {
        return invalid("deadProcessIdentities is empty or names a process without an identity");
    }
    Ok(())
}

/// An RFC 9562 UUID in either case, as the product's `request_id` pattern reads it
/// (`RFC_UUID_PATTERN`, case-insensitive): a `1`-`8` version digit and an `8`, `9`, `a`, or `b`
/// variant digit.
fn is_request_id(value: &str) -> bool {
    let groups: Vec<&str> = value.split('-').collect();
    let lengths = [8, 4, 4, 4, 12];
    groups.len() == lengths.len()
        && groups.iter().zip(lengths).all(|(group, length)| {
            group.len() == length && group.bytes().all(|byte| byte.is_ascii_hexdigit())
        })
        && matches!(groups[2].as_bytes()[0], b'1'..=b'8')
        && matches!(
            groups[3].as_bytes()[0],
            b'8' | b'9' | b'a' | b'b' | b'A' | b'B'
        )
}

/// The shape every upgrade error code has, known or not (`upgrade-error-codes.json`'s `pattern`).
fn is_error_code(value: &str) -> bool {
    let bytes = value.as_bytes();
    (3..=64).contains(&bytes.len())
        && bytes[0].is_ascii_uppercase()
        && bytes[1..]
            .iter()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || *byte == b'_')
}

/// A process the installer stopped. The Computer only checks the shape; the installer compares
/// the values, on the machine that wrote them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeadProcessIdentity {
    pub pid: u32,
    /// Opaque, compared only for equality: each platform's own start time, unconverted.
    /// Linux `<boot id>:<start ticks>` (`/proc/sys/kernel/random/boot_id`, field 22 of
    /// `/proc/<pid>/stat`, read after the last `)` because the command name can hold spaces and
    /// parentheses); macOS `<seconds>.<microseconds>` (six digits, from
    /// `proc_pidinfo(PROC_PIDTBSDINFO)`); Windows the decimal `FILETIME` creation time from
    /// `GetProcessTimes`.
    #[serde(rename = "startedAt")]
    pub started_at: String,
    pub executable: String,
}

impl DeadProcessIdentity {
    /// Whether it names a real process: a positive ID, a start time, and an executable.
    fn is_identified(&self) -> bool {
        self.pid > 0 && !self.started_at.is_empty() && !self.executable.is_empty()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuntimeState {
    #[serde(rename = "bindingId")]
    pub binding_id: String,
    pub running: bool,
}

/// `coforge-computer __lifecycle protocol`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LifecycleProtocol {
    pub lifecycle_protocol: u32,
    pub version: String,
}

/// `coforge-computer __lifecycle status`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LifecycleStatus {
    pub lifecycle_protocol: u32,
    pub version: String,
    pub supervisor: SupervisorState,
    pub bindings: Vec<LifecycleBinding>,
    pub healthy: bool,
    /// Why the runtime set is not healthy; empty exactly when `healthy` is true.
    pub problems: Vec<LifecycleProblem>,
}

/// One reason a runtime set is not healthy. `message` names the command that fixes it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LifecycleProblem {
    pub code: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binding_id: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SupervisorState {
    pub running: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LifecycleBinding {
    pub binding_id: String,
    pub enabled: bool,
    pub running: bool,
    pub process_id: Option<u32>,
}

/// `__lifecycle` exit statuses, error codes, and status problem codes (`lifecycle-codes.json`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LifecycleCodes {
    pub exit_codes: BTreeMap<String, u8>,
    pub error_codes: BTreeMap<String, String>,
    pub problem_codes: BTreeMap<String, String>,
}

/// Any failed `__lifecycle` call, printed with a non-zero exit status.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LifecycleError {
    pub lifecycle_protocol: u32,
    pub ok: bool,
    pub code: String,
    pub message: String,
}

/// How the machine mutation lock is taken (`lock.json`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MachineMutationLock {
    pub directory: String,
    pub file: String,
    pub mode: String,
    pub engine: String,
    pub statements: Vec<String>,
    pub contention_codes: Vec<String>,
    pub busy_error_code: String,
    pub held_for: String,
}

/// Services the product installs and the installer controls.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ServiceIdentities {
    pub coordinator: CoordinatorService,
    /// Names containing `{request_id}`; see [`request_scoped`].
    pub upgrade_job: UpgradeJobIdentity,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CoordinatorService {
    pub launchd_label: String,
    pub launchd_domain: String,
    pub systemd_user_unit: String,
    pub windows_task: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpgradeJobIdentity {
    pub launchd_label: String,
    pub systemd_user_unit: String,
    pub windows_task: String,
}

/// Fills a `{request_id}` name template.
pub fn request_scoped(template: &str, request_id: &str) -> String {
    template.replace("{request_id}", request_id)
}

/// Installation roots, as the product resolves them for example homes (`paths.json`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Paths {
    pub home_directory: String,
    pub cases: Vec<PathCase>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PathCase {
    pub platform: String,
    pub home: String,
    pub environment: BTreeMap<String, String>,
    pub install_root: String,
    pub state_directory: String,
    pub binary_directory: String,
}

/// Release version strings and whether the product accepts each (`release-versions.json`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReleaseVersions {
    pub cases: Vec<ReleaseVersionCase>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReleaseVersionCase {
    pub value: String,
    pub valid: bool,
}

/// Upgrade error codes a receipt may name (`upgrade-error-codes.json`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpgradeErrorCodes {
    pub pattern: String,
    pub codes: BTreeMap<String, String>,
}

/// The receipts the product accepts and refuses (`receipt-cases.json`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReceiptCases {
    pub allowed: Vec<AllowedReceipt>,
    pub rejected: Vec<RejectedReceipt>,
}

/// One allowed row; `slug` names the `receipt.<slug>.json` the installer writes for it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AllowedReceipt {
    pub slug: String,
    pub receipt: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RejectedReceipt {
    pub name: String,
    pub receipt: serde_json::Value,
}

/// The installer's exit statuses and the receipt size a reader accepts (`installer-codes.json`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstallerCodes {
    pub exit_codes: BTreeMap<String, u8>,
    pub max_receipt_bytes: u64,
}

/// The official feeds and the server each one belongs to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FeedEnvironments {
    pub default_feed: String,
    pub environments: Vec<FeedEnvironment>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FeedEnvironment {
    pub feed: String,
    pub server: String,
}

/// A JSON state file's contents as the product writes them: compact, newline-terminated.
pub fn to_file_json<T: Serialize>(value: &T) -> String {
    let mut text = serde_json::to_string(value).expect("contract types always serialize");
    text.push('\n');
    text
}

/// The process ID in `<state>/supervisor.lock/owner`, if it names one.
pub fn parse_supervisor_lock_owner(contents: &str) -> Option<u32> {
    contents.trim().parse().ok().filter(|pid| *pid > 0)
}

#[cfg(test)]
mod tests;
