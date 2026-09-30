use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;

use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

use super::*;

const REQUEST_ID: &str = "0f8b6d5e-2a41-4c3b-9e7d-1a2b3c4d5e6f";

fn contract_directory() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("contract")
}

fn read_text(name: &str) -> String {
    let path = contract_directory().join(name);
    fs::read_to_string(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

/// Reads one TypeScript golden into `T`, asserts that writing it back yields the same JSON
/// value, and asserts that a field this build has never heard of is ignored rather than
/// rejected (fields only ever get added to a contract version).
fn golden<T: DeserializeOwned + Serialize>(name: &str) -> T {
    let original: Value = serde_json::from_str(&read_text(name))
        .unwrap_or_else(|error| panic!("{name} is not JSON: {error}"));
    let parsed: T = serde_json::from_value(original.clone())
        .unwrap_or_else(|error| panic!("{name} does not match its type: {error}"));
    assert_eq!(
        serde_json::to_value(&parsed).unwrap(),
        original,
        "{name} does not round-trip"
    );

    let mut extended = original;
    extended
        .as_object_mut()
        .unwrap_or_else(|| panic!("{name} is not a JSON object"))
        .insert("x_field_from_a_later_version".into(), Value::Bool(true));
    serde_json::from_value::<T>(extended)
        .unwrap_or_else(|error| panic!("{name} rejects an unknown field: {error}"));
    parsed
}

/// Writes what the installer itself produces into `contract/rust/`, where a TypeScript test
/// reads it back with the product's schemas and readers. CI fails if the committed copy differs.
fn emit(name: &str, contents: &str) {
    let directory = contract_directory().join("rust");
    fs::create_dir_all(&directory).unwrap();
    fs::write(directory.join(name), contents).unwrap();
}

#[test]
fn every_golden_is_covered_by_a_test() {
    let names: BTreeSet<String> = fs::read_dir(contract_directory())
        .unwrap()
        .map(|entry| entry.unwrap())
        .filter(|entry| entry.file_type().unwrap().is_file())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| !name.starts_with('.') && !name.ends_with(".schema.json"))
        .collect();
    let covered: BTreeSet<String> = [
        "active.v1.json",
        "feed-environments.json",
        "installation.v2.json",
        "installation.v3.json",
        "installation.v4.json",
        "installer-codes.json",
        "installer-manifest.v1.json",
        "launchers.posix.json",
        "launchers.windows.json",
        "lifecycle-codes.json",
        "lifecycle.error.json",
        "lifecycle.protocol.json",
        "lifecycle.status.absent.json",
        "lifecycle.status.running.json",
        "lock.json",
        "manifest.v2.json",
        "paths.json",
        "release-versions.json",
        "receipt-cases.json",
        "receipt.held.json",
        "receipt.rolled-back.json",
        "receipt.succeeded.json",
        "receipt.unresolved.json",
        "service-identities.json",
        "supervisor-lock-owner.txt",
        "upgrade-error-codes.json",
    ]
    .into_iter()
    .map(String::from)
    .collect();
    assert_eq!(names, covered);
}

#[test]
fn json_schemas_are_draft_2020_12() {
    for entry in fs::read_dir(contract_directory()).unwrap() {
        let name = entry.unwrap().file_name().to_string_lossy().into_owned();
        if !name.ends_with(".schema.json") {
            continue;
        }
        let schema: Value = serde_json::from_str(&read_text(&name)).unwrap();
        assert_eq!(
            schema["$schema"], "https://json-schema.org/draft/2020-12/schema",
            "{name}"
        );
    }
}

#[test]
fn release_manifest_v2() {
    let manifest: ReleaseManifest = golden("manifest.v2.json");
    assert_eq!(manifest.schema_version, RELEASE_MANIFEST_SCHEMA_VERSION);
    assert_eq!(manifest.installer_protocol, Some(INSTALLER_PROTOCOL));
    assert_eq!(manifest.photon_wasm.file, "photon_rs_bg.wasm");
    for platform in manifest.platforms.values() {
        assert_eq!(platform.computer.binary, "coforge-computer");
        assert_eq!(platform.computer.gzip.binary, "coforge-computer.gz");
    }
}

#[test]
fn installer_manifest_v1() {
    let manifest: InstallerManifest = golden("installer-manifest.v1.json");
    assert_eq!(manifest.schema_version, INSTALLER_MANIFEST_SCHEMA_VERSION);
    assert_eq!(manifest.installer_protocol, INSTALLER_PROTOCOL);
    let windows = &manifest.platforms["windows-x64"].installer;
    assert_eq!(windows.file, "coforge-installer.exe");
    assert_eq!(windows.gzip.file, "coforge-installer.exe.gz");
}

#[test]
fn active_state_v1() {
    let active: ActiveState = golden("active.v1.json");
    assert_eq!(active.schema_version, ACTIVE_STATE_SCHEMA_VERSION);
    assert!(active.previous.is_some());
}

#[test]
fn installed_identity_v2_v3_v4() {
    let v2: InstalledIdentity = golden("installation.v2.json");
    assert_eq!(v2.schema_version, 2);
    assert!(v2.github_cli.is_none() && v2.photon_wasm.is_none());
    let v3: InstalledIdentity = golden("installation.v3.json");
    assert_eq!(v3.schema_version, 3);
    assert!(v3.github_cli.is_some() && v3.photon_wasm.is_none());
    let v4: InstalledIdentity = golden("installation.v4.json");
    assert_eq!(v4.schema_version, INSTALLED_IDENTITY_SCHEMA_VERSION);
    assert!(v4.github_cli.is_some() && v4.photon_wasm.is_some());
}

#[test]
fn launchers() {
    let posix: Launchers = golden("launchers.posix.json");
    assert_eq!(posix.agent_cli.file, "coforge");
    assert!(posix.agent_cli.contents.starts_with("#!/bin/sh\n"));
    let windows: WindowsLaunchers = golden("launchers.windows.json");
    assert_eq!(windows.launchers.agent_cli.file, "coforge.cmd");
    assert_eq!(windows.launchers.github_cli.file, "gh.cmd");
    // Byte for byte, CRLF included: what this crate would write is what the product writes.
    assert_eq!(posix.agent_cli.contents, agent_cli_launcher(false));
    assert_eq!(posix.github_cli.contents, github_cli_launcher(false));
    assert_eq!(
        windows.launchers.agent_cli.contents,
        agent_cli_launcher(true)
    );
    assert_eq!(
        windows.launchers.github_cli.contents,
        github_cli_launcher(true)
    );
    assert_eq!(windows.shim.file, "coforge-computer.cmd");
    assert_eq!(
        windows.shim.contents,
        windows_computer_launcher(&windows.shim.install_root)
    );
    for contents in [
        &windows.launchers.agent_cli.contents,
        &windows.launchers.github_cli.contents,
        &windows.shim.contents,
    ] {
        assert!(contents.ends_with("\r\n") && !contents.replace("\r\n", "").contains('\n'));
    }
}

#[test]
fn receipts() {
    let succeeded: UpgradeReceipt = golden("receipt.succeeded.json");
    assert_eq!(succeeded.status(), ReceiptStatus::Succeeded);
    assert_eq!(succeeded.exit_code(), EXIT_SUCCEEDED);
    assert_eq!(succeeded.protocol(), INSTALLER_RECEIPT_PROTOCOL);
    assert_eq!(
        succeeded.dead_process_identities(),
        Some(dead_processes().as_slice())
    );
    let rolled_back: UpgradeReceipt = golden("receipt.rolled-back.json");
    assert_eq!(rolled_back.status(), ReceiptStatus::Failed);
    assert_eq!(rolled_back.error_code(), Some("UPGRADE_ROLLED_BACK"));
    assert_eq!(rolled_back.exit_code(), EXIT_FAILED);
    assert!(rolled_back.restored_version().is_some());
    assert_eq!(
        rolled_back.dead_process_identities(),
        Some(dead_processes().as_slice())
    );
    // No v1 operation is held with a receipt yet; the example says what one looks like.
    let held: UpgradeReceipt = golden("receipt.held.json");
    assert_eq!(held.status(), ReceiptStatus::Held);
    assert_eq!(held.exit_code(), EXIT_HELD);
    assert!(held.error().is_some());
    assert_eq!(held.error_code(), None);
    assert_eq!(held.dead_process_identities(), None);
    let unresolved: UpgradeReceipt = golden("receipt.unresolved.json");
    assert_eq!(unresolved.error_code(), Some("UPGRADE_ROLLBACK_FAILED"));
    assert_eq!(unresolved.exit_code(), EXIT_UNRESOLVED);
    assert_eq!(
        unresolved.dead_process_identities(),
        Some(dead_processes().as_slice())
    );
}

/// The processes the receipt examples say the installer stopped.
fn dead_processes() -> Vec<DeadProcessIdentity> {
    let boot_id = "0d9a7e64-6e5f-4a1b-8c3d-2f4e6a8b0c1d";
    let executable = "/home/example/.coforge/computer/install/versions/0.1.0/coforge-computer";
    [(4242, 48_213_337), (4243, 48_213_351)]
        .into_iter()
        .map(|(pid, ticks)| DeadProcessIdentity {
            pid,
            started_at: format!("{boot_id}:{ticks}"),
            executable: executable.into(),
        })
        .collect()
}

#[test]
fn installer_codes() {
    let codes: InstallerCodes = golden("installer-codes.json");
    assert_eq!(
        codes.exit_codes,
        BTreeMap::from([
            ("SUCCEEDED".to_owned(), EXIT_SUCCEEDED),
            ("FAILED".to_owned(), EXIT_FAILED),
            ("HELD".to_owned(), EXIT_HELD),
            ("UNRESOLVED".to_owned(), EXIT_UNRESOLVED),
        ])
    );
    assert_eq!(codes.max_receipt_bytes, RECEIPT_MAX_BYTES);
}

#[test]
fn lifecycle_responses() {
    let protocol: LifecycleProtocol = golden("lifecycle.protocol.json");
    assert_eq!(protocol.lifecycle_protocol, LIFECYCLE_PROTOCOL);
    let running: LifecycleStatus = golden("lifecycle.status.running.json");
    assert!(running.supervisor.running && running.supervisor.id.is_some());
    assert!(
        running
            .bindings
            .iter()
            .any(|binding| binding.process_id.is_some())
    );
    assert!(running.healthy && running.problems.is_empty());
    let absent: LifecycleStatus = golden("lifecycle.status.absent.json");
    assert!(!absent.supervisor.running && absent.supervisor.id.is_none());
    assert!(!absent.healthy && !absent.problems.is_empty());
    let codes: LifecycleCodes = golden("lifecycle-codes.json");
    assert_eq!(
        absent.problems[0].code,
        codes.problem_codes["SUPERVISOR_NOT_RUNNING"]
    );
    assert!(
        absent
            .bindings
            .iter()
            .all(|binding| binding.process_id.is_none())
    );
    let error: LifecycleError = golden("lifecycle.error.json");
    assert!(!error.ok);
    assert_eq!(error.code, codes.error_codes["FAILED"]);
}

#[test]
fn lifecycle_codes() {
    let codes: LifecycleCodes = golden("lifecycle-codes.json");
    assert_eq!(codes.exit_codes["OK"], 0);
    assert_eq!(codes.exit_codes["FAILED"], 1);
    assert_eq!(codes.exit_codes["USAGE"], 2);
    assert_eq!(codes.error_codes["USAGE"], "LIFECYCLE_USAGE");
}

#[test]
fn supervisor_lock_owner() {
    assert_eq!(
        parse_supervisor_lock_owner(&read_text("supervisor-lock-owner.txt")),
        Some(4242)
    );
}

#[test]
fn machine_mutation_lock() {
    let lock: MachineMutationLock = golden("lock.json");
    assert_eq!(lock.file, "machine-mutation-lock.sqlite");
    assert_eq!(
        lock.statements.last().map(String::as_str),
        Some("BEGIN IMMEDIATE")
    );
}

#[test]
fn service_identities() {
    let identities: ServiceIdentities = golden("service-identities.json");
    assert_eq!(
        request_scoped(&identities.upgrade_job.launchd_label, REQUEST_ID),
        format!("cn.coforge.upgrade.{REQUEST_ID}")
    );
}

#[test]
fn paths() {
    let paths: Paths = golden("paths.json");
    for platform in ["linux", "darwin", "win32"] {
        assert!(
            paths.cases.iter().any(|case| case.platform == platform),
            "{platform}"
        );
    }
}

#[test]
fn release_versions() {
    let versions: ReleaseVersions = golden("release-versions.json");
    assert!(versions.cases.iter().any(|case| case.valid));
    assert!(versions.cases.iter().any(|case| !case.valid));
}

#[test]
fn upgrade_error_codes() {
    let codes: UpgradeErrorCodes = golden("upgrade-error-codes.json");
    assert_eq!(codes.codes["ROLLED_BACK"], ERROR_CODE_ROLLED_BACK);
    assert_eq!(codes.codes["ROLLBACK_FAILED"], ERROR_CODE_ROLLBACK_FAILED);
    assert_eq!(
        codes.codes["INSTALLER_UNAVAILABLE"],
        "UPGRADE_INSTALLER_UNAVAILABLE"
    );
    assert_eq!(
        codes.codes["INSTALLER_INCOMPATIBLE"],
        "UPGRADE_INSTALLER_INCOMPATIBLE"
    );
    assert_eq!(codes.codes["UPDATE_BUSY"], lock_busy_code());
}

fn lock_busy_code() -> String {
    golden::<MachineMutationLock>("lock.json").busy_error_code
}

#[test]
fn feed_environments() {
    let feeds: FeedEnvironments = golden("feed-environments.json");
    assert!(
        feeds
            .environments
            .iter()
            .any(|environment| feeds.default_feed.starts_with(&environment.feed))
    );
}

fn identity(size: u64, byte: char) -> ArtifactIdentity {
    ArtifactIdentity {
        size,
        checksum: byte.to_string().repeat(64),
    }
}

#[test]
fn emits_installed_identity() {
    emit(
        "installation.v4.json",
        &to_file_json(&InstalledIdentity {
            schema_version: INSTALLED_IDENTITY_SCHEMA_VERSION,
            version: "0.2.0".into(),
            computer: identity(71_303_168, 'a'),
            agent_cli: identity(63, 'b'),
            github_cli: Some(identity(74, 'c')),
            photon_wasm: Some(identity(1_843_200, 'd')),
        }),
    );
}

/// One receipt per allowed row of `receipt-cases.json`, built the only way the crate builds one.
/// The texts are the rows' own; `receipt_cases` fails when they drift.
fn constructed_receipts() -> Vec<(&'static str, UpgradeReceipt)> {
    let new = |outcome, stopped| UpgradeReceipt::new(REQUEST_ID, outcome, stopped).unwrap();
    let failed = |error: &str, error_code: Option<&str>| ReceiptOutcome::Failed {
        error: error.into(),
        error_code: error_code.map(Into::into),
    };
    vec![
        (
            "succeeded",
            new(
                ReceiptOutcome::Succeeded {
                    version: "0.2.0".into(),
                },
                dead_processes(),
            )
            .with_runtimes(
                true,
                vec![RuntimeState {
                    binding_id: "ws_example".into(),
                    running: true,
                }],
            ),
        ),
        (
            "succeeded-uppercase-request-id",
            UpgradeReceipt::new(
                "0F8B6D5E-2A41-4C3B-BE7D-1A2B3C4D5E6F",
                ReceiptOutcome::Succeeded {
                    version: "0.2.0".into(),
                },
                vec![],
            )
            .unwrap(),
        ),
        (
            "failed-installer-unavailable",
            new(
                failed(
                    "The release feed did not answer",
                    Some("UPGRADE_INSTALLER_UNAVAILABLE"),
                ),
                vec![],
            ),
        ),
        (
            "failed-installer-incompatible",
            new(
                failed(
                    "This version needs a newer installer",
                    Some("UPGRADE_INSTALLER_INCOMPATIBLE"),
                ),
                vec![],
            ),
        ),
        (
            "failed",
            new(failed("Could not create the staging directory", None), vec![]),
        ),
        (
            "rolled-back",
            new(
                ReceiptOutcome::RolledBack {
                    error: "Computer supervisor did not report 0.2.0".into(),
                    restored_version: "0.1.0".into(),
                },
                dead_processes(),
            ),
        ),
        (
            "held",
            new(
                ReceiptOutcome::Held {
                    error: "Version 0.1.0 is older than the installed 0.2.0, so the installer held the upgrade before changing anything".into(),
                    error_code: None,
                },
                vec![],
            ),
        ),
        (
            "unresolved",
            new(
                ReceiptOutcome::Unresolved {
                    error: "Computer supervisor did not report 0.2.0; rollback failed: Computer supervisor did not report 0.1.0".into(),
                    rollback_failed: true,
                },
                dead_processes(),
            ),
        ),
        (
            "unresolved-no-previous-version",
            new(
                ReceiptOutcome::Unresolved {
                    error: "Computer supervisor did not report 0.1.0 and no previous version existed".into(),
                    rollback_failed: false,
                },
                dead_processes(),
            ),
        ),
    ]
}

#[test]
fn receipt_cases() {
    let cases: ReceiptCases = golden("receipt-cases.json");
    let built: BTreeMap<&str, UpgradeReceipt> = constructed_receipts().into_iter().collect();
    assert_eq!(
        built.keys().copied().collect::<BTreeSet<_>>(),
        cases
            .allowed
            .iter()
            .map(|case| case.slug.as_str())
            .collect::<BTreeSet<_>>(),
        "the constructed receipts are not the allowed rows"
    );
    for case in &cases.allowed {
        let parsed: UpgradeReceipt = serde_json::from_value(case.receipt.clone())
            .unwrap_or_else(|error| panic!("{} is refused: {error}", case.slug));
        assert_eq!(
            serde_json::to_value(&parsed).unwrap(),
            case.receipt,
            "{} does not round-trip",
            case.slug
        );
        // Built from its outcome, the receipt is the row: its exit code is derived, not chosen.
        let mut expected = case.receipt.clone();
        expected["installer_version"] = env!("CARGO_PKG_VERSION").into();
        assert_eq!(
            serde_json::to_value(&built[case.slug.as_str()]).unwrap(),
            expected,
            "{} is not what the constructor builds",
            case.slug
        );
    }
    for case in &cases.rejected {
        assert!(
            serde_json::from_value::<UpgradeReceipt>(case.receipt.clone()).is_err(),
            "{} is accepted",
            case.name
        );
    }
}

#[test]
fn a_receipt_is_only_built_in_a_valid_shape() {
    let build = |outcome, stopped| UpgradeReceipt::new(REQUEST_ID, outcome, stopped);
    let held = |error: &str, error_code: Option<&str>| ReceiptOutcome::Held {
        error: error.into(),
        error_code: error_code.map(Into::into),
    };
    let failed = |error: &str, error_code: Option<&str>| ReceiptOutcome::Failed {
        error: error.into(),
        error_code: error_code.map(Into::into),
    };

    // The exit code follows the outcome; nothing else picks it.
    assert_eq!(
        build(held("why", None), vec![]).unwrap().exit_code(),
        EXIT_HELD
    );
    assert_eq!(
        build(failed("why", None), vec![]).unwrap().exit_code(),
        EXIT_FAILED
    );
    let unresolved = |rollback_failed| ReceiptOutcome::Unresolved {
        error: "why".into(),
        rollback_failed,
    };
    let rollback_failed = build(unresolved(true), vec![]).unwrap();
    assert_eq!(rollback_failed.exit_code(), EXIT_UNRESOLVED);
    assert_eq!(
        rollback_failed.error_code(),
        Some(ERROR_CODE_ROLLBACK_FAILED)
    );
    let nothing_to_restore = build(unresolved(false), vec![]).unwrap();
    assert_eq!(nothing_to_restore.exit_code(), EXIT_UNRESOLVED);
    assert_eq!(nothing_to_restore.error_code(), None);

    // A receipt that is not succeeded says why, and only the outcome that means it names a
    // rollback code.
    assert!(build(held("", None), vec![]).is_err());
    assert!(build(failed("", None), vec![]).is_err());
    assert!(build(held("why", Some(ERROR_CODE_ROLLED_BACK)), vec![]).is_err());
    assert!(build(held("why", Some(ERROR_CODE_ROLLBACK_FAILED)), vec![]).is_err());
    assert!(build(failed("why", Some(ERROR_CODE_ROLLED_BACK)), vec![]).is_err());
    assert!(build(failed("why", Some(ERROR_CODE_ROLLBACK_FAILED)), vec![]).is_err());
    assert!(build(failed("why", Some("not-a-code")), vec![]).is_err());
    let no_restored_version = ReceiptOutcome::RolledBack {
        error: "why".into(),
        restored_version: String::new(),
    };
    assert!(build(no_restored_version, vec![]).is_err());

    // Processes are named exactly when some were stopped, and each is a real identity.
    let stopped_nothing = build(failed("why", None), vec![]).unwrap();
    assert_eq!(stopped_nothing.dead_process_identities(), None);
    assert!(
        serde_json::to_value(&stopped_nothing)
            .unwrap()
            .get("deadProcessIdentities")
            .is_none()
    );
    let dead = |pid, started_at: &str, executable: &str| DeadProcessIdentity {
        pid,
        started_at: started_at.into(),
        executable: executable.into(),
    };
    assert!(build(failed("why", None), vec![dead(1, "7", "/bin/x")]).is_ok());
    assert!(build(failed("why", None), vec![dead(0, "7", "/bin/x")]).is_err());
    assert!(build(failed("why", None), vec![dead(1, "", "/bin/x")]).is_err());
    assert!(build(failed("why", None), vec![dead(1, "7", "")]).is_err());
}

#[test]
fn emits_receipts() {
    for (slug, receipt) in constructed_receipts() {
        let text = to_file_json(&receipt);
        assert!(
            text.len() as u64 <= RECEIPT_MAX_BYTES,
            "{slug} is too large"
        );
        emit(&format!("receipt.{slug}.json"), &text);
    }
}
