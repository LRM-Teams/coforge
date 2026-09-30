//! The files and JSON this installer shares with the CoForge Computer product.
//!
//! The TypeScript product is the source of truth: `packages/computer` defines each shape with zod
//! and generates JSON Schema plus golden instances into `crates/installer/contract/`
//! (`bun run --cwd packages/computer generate:installer-contract`). These types read and write
//! the same shapes. Every struct ignores fields it does not know, because a contract version only
//! ever gains fields; tests in `contract/tests.rs` read every golden and round-trip it, and write
//! what this crate produces into `contract/rust/`, which a TypeScript test reads back.

use std::collections::BTreeMap;

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
/// Exit status: failed before any change, or rolled back to the previous version.
pub const EXIT_FAILED: u8 = 1;
/// Exit status: the outcome is committed in a receipt, but the operation has not settled;
/// `recover` finishes it. Never in a receipt.
pub const EXIT_HELD: u8 = 2;
/// Exit status: rollback failed, or no previous version existed to roll back to.
pub const EXIT_UNRESOLVED: u8 = 3;

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
}

/// `<install root>/upgrade-results/<request id>.result.json`, written once.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpgradeReceipt {
    pub schema_version: u32,
    pub request_id: String,
    pub operation: String,
    pub status: ReceiptStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(
        rename = "restoredVersion",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub restored_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(rename = "errorCode", default, skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    #[serde(
        rename = "supervisorRunning",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub supervisor_running: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtimes: Option<Vec<RuntimeState>>,
    pub protocol: String,
    /// The exit status the committed outcome implies: 0, 1, or 3 (never 2).
    pub exit_code: u8,
    pub installer_version: String,
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

/// Upgrade error codes a receipt may name (`upgrade-error-codes.json`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpgradeErrorCodes {
    pub pattern: String,
    pub codes: BTreeMap<String, String>,
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
