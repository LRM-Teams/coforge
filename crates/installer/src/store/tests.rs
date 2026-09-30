use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use super::*;
use crate::contract::{
    INSTALLED_IDENTITY_SCHEMA_VERSION, InstalledIdentity, agent_cli_launcher, github_cli_launcher,
    to_file_json,
};
use crate::digest::measure_bytes;
use crate::lock::MachineMutationLock;
use crate::test_support::Scratch;

const VERSION: &str = "0.2.0";

fn computer_bytes() -> Vec<u8> {
    b"#!/bin/sh\necho a fake coforge-computer\n".to_vec()
}

fn wasm_bytes() -> Vec<u8> {
    b"\0asm\x01\0\0\0a fake photon".to_vec()
}

/// Stages `VERSION` the way the feed does (the two payload files land in the staging directory)
/// and installs it.
fn install(store: &VersionStore, lock: &MachineMutationLock) -> Installation {
    let staging = store.begin_staging(lock, VERSION).unwrap();
    fs::write(staging.computer_path(), computer_bytes()).unwrap();
    fs::write(staging.photon_wasm_path(), wasm_bytes()).unwrap();
    staging
        .install(
            measure_bytes(&computer_bytes()),
            measure_bytes(&wasm_bytes()),
        )
        .unwrap()
}

fn names(directory: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(directory)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

fn installed(root: &Scratch) -> PathBuf {
    root.path().join("versions").join(VERSION)
}

fn integrity_message(result: Result<(), UpdateError>) -> String {
    match result {
        Err(UpdateError::IntegrityFailed(message)) => message,
        other => panic!("expected an integrity failure, got {other:?}"),
    }
}

fn read_identity(directory: &Path) -> Value {
    serde_json::from_str(&fs::read_to_string(directory.join("installation.json")).unwrap()).unwrap()
}

fn write_identity(directory: &Path, identity: &Value) {
    fs::write(directory.join("installation.json"), identity.to_string()).unwrap();
}

#[test]
fn an_installed_version_holds_exactly_the_files_the_product_writes() {
    let root = Scratch::new("store-layout");
    let lock = MachineMutationLock::acquire(root.path()).unwrap();
    let store = VersionStore::new(root.path(), "linux-x64");

    assert_eq!(install(&store, &lock), Installation::Installed);

    let directory = installed(&root);
    assert_eq!(
        names(&directory),
        [
            "coforge",
            "coforge-computer",
            "gh",
            "installation.json",
            "photon_rs_bg.wasm",
            "version"
        ]
    );
    assert_eq!(
        fs::read(directory.join("coforge-computer")).unwrap(),
        computer_bytes()
    );
    assert_eq!(
        fs::read(directory.join("photon_rs_bg.wasm")).unwrap(),
        wasm_bytes()
    );
    assert_eq!(
        fs::read_to_string(directory.join("version")).unwrap(),
        "0.2.0\n"
    );
    assert_eq!(
        fs::read_to_string(directory.join("coforge")).unwrap(),
        "#!/bin/sh\nexec \"${0%/*}/coforge-computer\" __agent-cli \"$@\"\n"
    );
    assert_eq!(
        fs::read_to_string(directory.join("gh")).unwrap(),
        "#!/bin/sh\nexec \"${0%/*}/coforge-computer\" __agent-cli github gh \"$@\"\n"
    );
    // Nothing is left in `.staging`.
    assert!(names(&root.path().join(".staging")).is_empty());
    store.verify_installed(VERSION).unwrap();
}

#[test]
fn installation_json_is_a_schema_4_identity_written_compact() {
    let root = Scratch::new("store-identity");
    let lock = MachineMutationLock::acquire(root.path()).unwrap();
    install(&VersionStore::new(root.path(), "linux-x64"), &lock);

    let text = fs::read_to_string(installed(&root).join("installation.json")).unwrap();

    assert!(
        text.ends_with("}\n") && !text[..text.len() - 1].contains('\n'),
        "{text:?}"
    );
    let identity: InstalledIdentity = serde_json::from_str(&text).unwrap();
    assert_eq!(identity.schema_version, INSTALLED_IDENTITY_SCHEMA_VERSION);
    assert_eq!(identity.version, VERSION);
    assert_eq!(identity.computer, measure_bytes(&computer_bytes()));
    assert_eq!(identity.photon_wasm, Some(measure_bytes(&wasm_bytes())));
    assert_eq!(identity.agent_cli.size, 59);
    assert_eq!(identity.github_cli.as_ref().map(|g| g.size), Some(69));
    assert_eq!(text, to_file_json(&identity));
}

#[test]
fn a_windows_target_names_the_files_the_windows_way() {
    let root = Scratch::new("store-windows");
    let lock = MachineMutationLock::acquire(root.path()).unwrap();
    let store = VersionStore::new(root.path(), "windows-arm64");

    install(&store, &lock);

    let directory = installed(&root);
    assert_eq!(
        names(&directory),
        [
            "coforge-computer.exe",
            "coforge.cmd",
            "gh.cmd",
            "installation.json",
            "photon_rs_bg.wasm",
            "version"
        ]
    );
    assert_eq!(
        fs::read_to_string(directory.join("coforge.cmd")).unwrap(),
        agent_cli_launcher(true)
    );
    assert_eq!(
        fs::read_to_string(directory.join("gh.cmd")).unwrap(),
        github_cli_launcher(true)
    );
    store.verify_installed(VERSION).unwrap();
}

#[cfg(unix)]
#[test]
fn files_and_directories_are_owner_only() {
    use std::os::unix::fs::PermissionsExt;
    let root = Scratch::new("store-modes");
    let lock = MachineMutationLock::acquire(root.path()).unwrap();
    install(&VersionStore::new(root.path(), "linux-x64"), &lock);
    let mode = |path: PathBuf| fs::metadata(path).unwrap().permissions().mode() & 0o777;

    let directory = installed(&root);
    for executable in ["coforge-computer", "coforge", "gh"] {
        assert_eq!(mode(directory.join(executable)), 0o700, "{executable}");
    }
    for data in ["photon_rs_bg.wasm", "version", "installation.json"] {
        assert_eq!(mode(directory.join(data)), 0o600, "{data}");
    }
    assert_eq!(mode(directory.clone()), 0o700);
    assert_eq!(mode(root.path().join("versions")), 0o700);
}

#[test]
fn installing_a_version_that_is_already_installed_leaves_it_untouched() {
    let root = Scratch::new("store-idempotent");
    let lock = MachineMutationLock::acquire(root.path()).unwrap();
    let store = VersionStore::new(root.path(), "linux-x64");
    install(&store, &lock);
    let before = fs::read(installed(&root).join("installation.json")).unwrap();

    let staging = store.begin_staging(&lock, VERSION).unwrap();
    fs::write(staging.computer_path(), b"different bytes").unwrap();
    fs::write(staging.photon_wasm_path(), b"different wasm").unwrap();
    let outcome = staging
        .install(
            measure_bytes(b"different bytes"),
            measure_bytes(b"different wasm"),
        )
        .unwrap();

    assert_eq!(outcome, Installation::AlreadyInstalled);
    assert_eq!(
        fs::read(installed(&root).join("installation.json")).unwrap(),
        before
    );
    assert_eq!(
        fs::read(installed(&root).join("coforge-computer")).unwrap(),
        computer_bytes()
    );
    assert!(names(&root.path().join(".staging")).is_empty());
}

#[test]
fn an_incomplete_version_directory_is_an_integrity_error_and_is_not_overwritten() {
    let root = Scratch::new("store-incomplete");
    let lock = MachineMutationLock::acquire(root.path()).unwrap();
    let store = VersionStore::new(root.path(), "linux-x64");
    let directory = installed(&root);
    fs::create_dir_all(&directory).unwrap();
    fs::write(directory.join("coforge-computer"), b"half an install").unwrap();

    let staging = store.begin_staging(&lock, VERSION).unwrap();
    fs::write(staging.computer_path(), computer_bytes()).unwrap();
    fs::write(staging.photon_wasm_path(), wasm_bytes()).unwrap();
    let error = staging
        .install(
            measure_bytes(&computer_bytes()),
            measure_bytes(&wasm_bytes()),
        )
        .unwrap_err();

    assert!(
        matches!(error, UpdateError::IntegrityFailed(_)),
        "{error:?}"
    );
    assert_eq!(names(&directory), ["coforge-computer"]);
    assert_eq!(
        fs::read(directory.join("coforge-computer")).unwrap(),
        b"half an install"
    );
    assert!(names(&root.path().join(".staging")).is_empty());
}

#[test]
fn a_staging_directory_that_is_never_installed_is_removed() {
    let root = Scratch::new("store-abandoned");
    let lock = MachineMutationLock::acquire(root.path()).unwrap();
    let store = VersionStore::new(root.path(), "linux-x64");

    let staging = store.begin_staging(&lock, VERSION).unwrap();
    fs::write(staging.computer_path(), computer_bytes()).unwrap();
    assert_eq!(names(&root.path().join(".staging")).len(), 1);
    drop(staging);

    assert!(names(&root.path().join(".staging")).is_empty());
    assert!(!installed(&root).exists());
}

#[test]
fn two_stagings_of_one_version_do_not_collide() {
    let root = Scratch::new("store-unique");
    let lock = MachineMutationLock::acquire(root.path()).unwrap();
    let store = VersionStore::new(root.path(), "linux-x64");

    let first = store.begin_staging(&lock, VERSION).unwrap();
    let second = store.begin_staging(&lock, VERSION).unwrap();

    assert_ne!(first.computer_path(), second.computer_path());
}

#[test]
fn a_lock_on_another_install_root_is_refused_and_nothing_is_created() {
    let root = Scratch::new("store-wrong-lock");
    let elsewhere = Scratch::new("store-wrong-lock-elsewhere");
    let lock = MachineMutationLock::acquire(elsewhere.path()).unwrap();
    let store = VersionStore::new(root.path(), "linux-x64");

    let error = store.begin_staging(&lock, VERSION).unwrap_err();

    // Not a feed, integrity, or busy failure, so no receipt code: a caller mistake.
    assert_eq!(error.code(), None);
    assert!(
        matches!(&error, UpdateError::Local(message) if message.contains("machine mutation lock")),
        "{error:?}"
    );
    assert!(root.entries().is_empty(), "{:?}", root.entries());
}

#[test]
fn a_lock_on_the_same_install_root_spelled_differently_is_accepted() {
    let root = Scratch::new("store-spelling");
    let lock = MachineMutationLock::acquire(root.path()).unwrap();
    let store = VersionStore::new(root.path().join("."), "linux-x64");

    store.begin_staging(&lock, VERSION).unwrap();
}

#[test]
fn staging_removes_what_an_earlier_run_left_behind() {
    let root = Scratch::new("store-sweep");
    let lock = MachineMutationLock::acquire(root.path()).unwrap();
    let store = VersionStore::new(root.path(), "linux-x64");
    let staging_root = root.path().join(".staging");
    // A run killed mid-download leaves its directory, about 140 MB of it, and nothing else does
    // the cleanup. Names in this scheme carry the pid of the run that made them.
    let crashed = staging_root.join(format!("0.1.0-{}-1-1", u32::MAX));
    fs::create_dir_all(&crashed).unwrap();
    fs::write(crashed.join("coforge-computer"), vec![0u8; 4096]).unwrap();
    fs::write(staging_root.join("stray-file"), b"x").unwrap();
    fs::create_dir_all(staging_root.join("not-our-naming")).unwrap();

    let staging = store.begin_staging(&lock, VERSION).unwrap();

    assert_eq!(
        names(&staging_root),
        [staging
            .computer_path()
            .parent()
            .unwrap()
            .file_name()
            .unwrap()
            .to_string_lossy()]
    );
}

#[test]
fn staging_removes_a_directory_left_by_an_earlier_process_that_had_this_pid() {
    // Process IDs repeat, and in a container every run tends to get the same one. What tells this
    // run's directories from a killed run's is the token, not the pid alone.
    let root = Scratch::new("store-sweep-same-pid");
    let lock = MachineMutationLock::acquire(root.path()).unwrap();
    let store = VersionStore::new(root.path(), "linux-x64");
    let staging_root = root.path().join(".staging");
    let earlier = staging_root.join(format!("0.1.0-{}-1-1", std::process::id()));
    fs::create_dir_all(&earlier).unwrap();
    fs::write(earlier.join("coforge-computer"), vec![0u8; 4096]).unwrap();

    let staging = store.begin_staging(&lock, VERSION).unwrap();

    assert!(!earlier.exists(), "{:?}", names(&staging_root));
    assert_eq!(names(&staging_root).len(), 1);
    drop(staging);
}

#[test]
fn staging_leaves_a_directory_this_process_is_still_filling() {
    let root = Scratch::new("store-sweep-live");
    let lock = MachineMutationLock::acquire(root.path()).unwrap();
    let store = VersionStore::new(root.path(), "linux-x64");
    let first = store.begin_staging(&lock, VERSION).unwrap();
    fs::write(first.computer_path(), computer_bytes()).unwrap();
    fs::write(first.photon_wasm_path(), wasm_bytes()).unwrap();

    let second = store.begin_staging(&lock, "0.3.0").unwrap();

    assert_eq!(names(&root.path().join(".staging")).len(), 2);
    assert_eq!(fs::read(first.computer_path()).unwrap(), computer_bytes());
    drop(second);
    assert_eq!(
        first
            .install(
                measure_bytes(&computer_bytes()),
                measure_bytes(&wasm_bytes())
            )
            .unwrap(),
        Installation::Installed
    );
}

#[test]
fn a_version_that_is_not_one_safe_path_segment_is_refused() {
    let root = Scratch::new("store-bad-version");
    let lock = MachineMutationLock::acquire(root.path()).unwrap();
    let store = VersionStore::new(root.path(), "linux-x64");
    for bad in ["", ".", "..", "../x", "a/b", "-x", "1..2"] {
        assert!(
            matches!(
                store.begin_staging(&lock, bad),
                Err(UpdateError::FeedInvalid(_))
            ),
            "{bad:?}"
        );
        assert!(
            matches!(
                store.verify_installed(bad),
                Err(UpdateError::FeedInvalid(_))
            ),
            "{bad:?}"
        );
    }
    assert!(!root.path().join(".staging").exists());
}

#[test]
fn presence_tells_absent_from_verified_from_broken() {
    let root = Scratch::new("store-presence");
    let lock = MachineMutationLock::acquire(root.path()).unwrap();
    let store = VersionStore::new(root.path(), "linux-x64");
    assert_eq!(store.presence(VERSION).unwrap(), Presence::Absent);

    install(&store, &lock);
    assert_eq!(store.presence(VERSION).unwrap(), Presence::Verified);

    fs::write(installed(&root).join("gh"), "tampered").unwrap();
    assert!(matches!(
        store.presence(VERSION),
        Err(UpdateError::IntegrityFailed(_))
    ));
}

/// Every way an installed version can stop matching what `installation.json` recorded.
#[test]
fn verification_rejects_a_tampered_or_incomplete_installation() {
    type Tamper = fn(&Path);
    let cases: [(&str, Tamper); 12] = [
        ("computer bytes", |d| {
            fs::write(d.join("coforge-computer"), b"x").unwrap()
        }),
        ("computer same size", |d| {
            let mut bytes = fs::read(d.join("coforge-computer")).unwrap();
            bytes[0] ^= 1;
            fs::write(d.join("coforge-computer"), bytes).unwrap();
        }),
        ("agent cli launcher", |d| {
            fs::write(d.join("coforge"), "#!/bin/sh\nexit 0\n").unwrap()
        }),
        ("github cli launcher", |d| {
            fs::write(d.join("gh"), "#!/bin/sh\nexit 0\n").unwrap()
        }),
        ("photon wasm", |d| {
            fs::write(d.join("photon_rs_bg.wasm"), b"x").unwrap()
        }),
        ("version marker", |d| {
            fs::write(d.join("version"), "0.1.0\n").unwrap()
        }),
        ("missing computer", |d| {
            fs::remove_file(d.join("coforge-computer")).unwrap()
        }),
        ("missing launcher", |d| {
            fs::remove_file(d.join("coforge")).unwrap()
        }),
        ("missing wasm", |d| {
            fs::remove_file(d.join("photon_rs_bg.wasm")).unwrap()
        }),
        ("missing marker", |d| {
            fs::remove_file(d.join("version")).unwrap()
        }),
        ("missing identity", |d| {
            fs::remove_file(d.join("installation.json")).unwrap()
        }),
        ("identity is not JSON", |d| {
            fs::write(d.join("installation.json"), "{").unwrap()
        }),
    ];
    for (name, tamper) in cases {
        let root = Scratch::new("store-tamper");
        let lock = MachineMutationLock::acquire(root.path()).unwrap();
        let store = VersionStore::new(root.path(), "linux-x64");
        install(&store, &lock);
        tamper(&installed(&root));

        let result = store.verify_installed(VERSION);

        assert!(
            matches!(result, Err(UpdateError::IntegrityFailed(_))),
            "{name}: {result:?}"
        );
    }
}

#[test]
fn verification_rejects_an_identity_that_disagrees_with_the_directory() {
    type Edit = fn(&mut Value);
    let edits: [(&str, Edit); 8] = [
        ("other version", |i| i["version"] = json!("0.1.0")),
        ("daemon payload", |i| {
            i["daemon"] = json!({"size": 1, "checksum": "a".repeat(64)})
        }),
        ("unknown schema", |i| i["schema_version"] = json!(5)),
        ("no github cli in schema 4", |i| {
            i.as_object_mut().unwrap().remove("githubCli");
        }),
        ("no photon wasm in schema 4", |i| {
            i.as_object_mut().unwrap().remove("photonWasm");
        }),
        ("uppercase checksum", |i| {
            let upper = i["computer"]["checksum"].as_str().unwrap().to_uppercase();
            i["computer"]["checksum"] = json!(upper);
        }),
        ("short checksum", |i| {
            i["agentCli"]["checksum"] = json!("abc")
        }),
        ("size beyond 2^53", |i| {
            i["photonWasm"]["size"] = json!(9_007_199_254_740_992u64)
        }),
    ];
    for (name, edit) in edits {
        let root = Scratch::new("store-identity-edit");
        let lock = MachineMutationLock::acquire(root.path()).unwrap();
        let store = VersionStore::new(root.path(), "linux-x64");
        install(&store, &lock);
        let directory = installed(&root);
        let mut identity = read_identity(&directory);
        edit(&mut identity);
        write_identity(&directory, &identity);

        let result = store.verify_installed(VERSION);

        assert!(
            matches!(result, Err(UpdateError::IntegrityFailed(_))),
            "{name}: {result:?}"
        );
    }
}

/// A retained older version (a rollback target) is a schema 2 or 3 directory.
fn write_older_version(root: &Path, schema: u32) {
    let directory = root.join("versions").join(VERSION);
    fs::create_dir_all(&directory).unwrap();
    let agent_cli = agent_cli_launcher(false);
    let github_cli = github_cli_launcher(false);
    fs::write(directory.join("coforge-computer"), computer_bytes()).unwrap();
    fs::write(directory.join("coforge"), agent_cli).unwrap();
    fs::write(directory.join("version"), format!("{VERSION}\n")).unwrap();
    let mut identity = InstalledIdentity {
        schema_version: schema,
        version: VERSION.into(),
        computer: measure_bytes(&computer_bytes()),
        agent_cli: measure_bytes(agent_cli.as_bytes()),
        github_cli: None,
        photon_wasm: None,
    };
    if schema >= 3 {
        fs::write(directory.join("gh"), github_cli).unwrap();
        identity.github_cli = Some(measure_bytes(github_cli.as_bytes()));
    }
    fs::write(directory.join("installation.json"), to_file_json(&identity)).unwrap();
}

#[test]
fn a_schema_2_version_verifies_without_a_github_launcher_or_image_library() {
    let root = Scratch::new("store-schema-2");
    write_older_version(root.path(), 2);

    VersionStore::new(root.path(), "linux-x64")
        .verify_installed(VERSION)
        .unwrap();
}

#[test]
fn a_schema_3_version_verifies_without_an_image_library() {
    let root = Scratch::new("store-schema-3");
    write_older_version(root.path(), 3);
    let store = VersionStore::new(root.path(), "linux-x64");

    store.verify_installed(VERSION).unwrap();

    // Schema 3 does carry the GitHub launcher, so tampering with it is caught.
    fs::write(installed(&root).join("gh"), "tampered").unwrap();
    assert!(
        integrity_message(store.verify_installed(VERSION)).contains("GitHub CLI"),
        "schema 3 checks its gh launcher"
    );
}

#[test]
fn an_older_schema_does_not_excuse_a_missing_agent_cli_launcher() {
    let root = Scratch::new("store-schema-2-tamper");
    write_older_version(root.path(), 2);
    fs::write(installed(&root).join("coforge"), "tampered").unwrap();

    let message =
        integrity_message(VersionStore::new(root.path(), "linux-x64").verify_installed(VERSION));

    assert!(message.contains("Agent CLI"), "{message}");
}
