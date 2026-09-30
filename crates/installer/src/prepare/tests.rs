use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use super::*;
use crate::contract::InstalledIdentity;
use crate::digest::measure_bytes;
use crate::lock::MachineMutationLock;
use crate::test_support::{Release, Response, Scratch, Server};

const VERSION: &str = "0.2.0";

fn feed(server: &Server) -> Feed {
    Feed::new(&server.base_url(), crate::fetch::agent(false))
}

fn names(directory: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(directory)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

#[test]
fn latest_is_resolved_downloaded_verified_and_installed() {
    let release = Release::new(VERSION, "linux-x64");
    let server = Server::start(release.routes());
    let root = Scratch::new("prepare-latest");
    let lock = MachineMutationLock::acquire(root.path()).unwrap();
    let store = VersionStore::new(root.path(), "linux-x64");

    let prepared = prepare_version(&lock, &feed(&server), &store, "latest").unwrap();

    assert_eq!(
        prepared,
        Prepared {
            version: VERSION.into(),
            installation: Installation::Installed
        }
    );
    store.verify_installed(VERSION).unwrap();
    let directory = store.version_directory(VERSION);
    assert_eq!(
        fs::read(directory.join("coforge-computer")).unwrap(),
        release.computer
    );
    assert_eq!(
        fs::read(directory.join("photon_rs_bg.wasm")).unwrap(),
        release.photon_wasm
    );
    assert_eq!(
        server.requests(),
        [
            "/latest",
            "/0.2.0/manifest.json",
            "/0.2.0/linux-x64/coforge-computer.gz",
            "/0.2.0/photon_rs_bg.wasm"
        ]
    );
    assert!(names(&root.path().join(".staging")).is_empty());
}

#[test]
fn a_named_version_does_not_consult_the_pointer() {
    let release = Release::new(VERSION, "linux-x64");
    let server = Server::start(release.routes());
    let root = Scratch::new("prepare-named");
    let lock = MachineMutationLock::acquire(root.path()).unwrap();
    let store = VersionStore::new(root.path(), "linux-x64");

    prepare_version(&lock, &feed(&server), &store, VERSION).unwrap();

    assert!(!server.requests().contains(&"/latest".to_string()));
}

#[test]
fn a_version_that_is_already_installed_is_not_downloaded_again() {
    let release = Release::new(VERSION, "linux-x64");
    let server = Server::start(release.routes());
    let root = Scratch::new("prepare-again");
    let lock = MachineMutationLock::acquire(root.path()).unwrap();
    let store = VersionStore::new(root.path(), "linux-x64");
    prepare_version(&lock, &feed(&server), &store, "latest").unwrap();
    let identity = fs::read(store.version_directory(VERSION).join("installation.json")).unwrap();

    let prepared = prepare_version(&lock, &feed(&server), &store, "latest").unwrap();

    assert_eq!(prepared.installation, Installation::AlreadyInstalled);
    assert_eq!(
        fs::read(store.version_directory(VERSION).join("installation.json")).unwrap(),
        identity
    );
    let requests = server.requests();
    assert_eq!(
        requests.len(),
        4 + 1,
        "only the pointer is read the second time: {requests:?}"
    );
    assert!(names(&root.path().join(".staging")).is_empty());
}

#[test]
fn a_lock_on_another_install_root_stops_the_preparation_before_the_feed_is_asked() {
    let release = Release::new(VERSION, "linux-x64");
    let server = Server::start(release.routes());
    let root = Scratch::new("prepare-wrong-lock");
    let elsewhere = Scratch::new("prepare-wrong-lock-elsewhere");
    let lock = MachineMutationLock::acquire(elsewhere.path()).unwrap();
    let store = VersionStore::new(root.path(), "linux-x64");

    let error = prepare_version(&lock, &feed(&server), &store, "latest").unwrap_err();

    assert!(matches!(error, UpdateError::Local(_)), "{error:?}");
    assert!(server.requests().is_empty(), "{:?}", server.requests());
    assert!(root.entries().is_empty(), "{:?}", root.entries());
}

#[test]
fn what_a_killed_run_left_in_staging_is_removed_by_the_next_preparation() {
    let release = Release::new(VERSION, "linux-x64");
    let server = Server::start(release.routes());
    let root = Scratch::new("prepare-stale-staging");
    let lock = MachineMutationLock::acquire(root.path()).unwrap();
    let store = VersionStore::new(root.path(), "linux-x64");
    let stale = root
        .path()
        .join(".staging")
        .join(format!("0.1.0-{}-1-1", u32::MAX));
    fs::create_dir_all(&stale).unwrap();
    fs::write(stale.join("coforge-computer"), vec![0u8; 4096]).unwrap();

    prepare_version(&lock, &feed(&server), &store, "latest").unwrap();

    assert!(names(&root.path().join(".staging")).is_empty());
    store.verify_installed(VERSION).unwrap();
}

#[test]
fn an_incomplete_version_directory_stops_the_preparation() {
    let release = Release::new(VERSION, "linux-x64");
    let server = Server::start(release.routes());
    let root = Scratch::new("prepare-incomplete");
    let lock = MachineMutationLock::acquire(root.path()).unwrap();
    let store = VersionStore::new(root.path(), "linux-x64");
    let directory = store.version_directory(VERSION);
    fs::create_dir_all(&directory).unwrap();
    fs::write(directory.join("version"), "0.2.0\n").unwrap();

    let error = prepare_version(&lock, &feed(&server), &store, VERSION).unwrap_err();

    assert!(
        matches!(error, UpdateError::IntegrityFailed(_)),
        "{error:?}"
    );
    assert_eq!(names(&directory), ["version"]);
    assert!(server.requests().is_empty());
}

#[test]
fn a_manifest_without_this_target_is_unsupported_and_leaves_nothing_behind() {
    let release = Release::new(VERSION, "linux-arm64");
    let server = Server::start(release.routes());
    let root = Scratch::new("prepare-unsupported");
    let lock = MachineMutationLock::acquire(root.path()).unwrap();
    let store = VersionStore::new(root.path(), "linux-x64");

    let error = prepare_version(&lock, &feed(&server), &store, "latest").unwrap_err();

    assert_eq!(
        error,
        UpdateError::UnsupportedTarget("manifest has no platform entry for linux-x64".into())
    );
    assert!(!root.path().join("versions").exists());
    assert!(!root.path().join(".staging").exists());
}

#[test]
fn a_failed_download_installs_nothing_and_removes_its_staging_directory() {
    for broken in ["computer", "wasm"] {
        let release = Release::new(VERSION, "linux-x64");
        let mut routes = release.routes();
        let path = match broken {
            "computer" => release.computer_path(),
            _ => release.photon_wasm_path(),
        };
        routes.insert(
            path,
            Response::ok(b"not what the manifest promised".to_vec()),
        );
        let server = Server::start(routes);
        let root = Scratch::new("prepare-corrupt");
        let lock = MachineMutationLock::acquire(root.path()).unwrap();
        let store = VersionStore::new(root.path(), "linux-x64");

        let error = prepare_version(&lock, &feed(&server), &store, "latest").unwrap_err();

        assert!(
            matches!(error, UpdateError::IntegrityFailed(_)),
            "{broken}: {error:?}"
        );
        assert!(!store.version_directory(VERSION).exists(), "{broken}");
        assert!(names(&root.path().join(".staging")).is_empty(), "{broken}");
    }
}

#[test]
fn a_manifest_missing_from_the_feed_is_a_feed_error() {
    let release = Release::new(VERSION, "linux-x64");
    let mut routes = release.routes();
    routes.remove("/0.2.0/manifest.json");
    let server = Server::start(routes);
    let root = Scratch::new("prepare-no-manifest");
    let lock = MachineMutationLock::acquire(root.path()).unwrap();
    let store = VersionStore::new(root.path(), "linux-x64");

    let error = prepare_version(&lock, &feed(&server), &store, "latest").unwrap_err();

    assert!(matches!(error, UpdateError::FeedInvalid(_)), "{error:?}");
    assert!(!root.path().join("versions").exists());
}

// ---- what the product reads back ----------------------------------------------------------

fn contract_rust_directory() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("contract/rust")
}

/// One installed file in `contract/rust/installed-versions.json`: printable text as it is,
/// anything else as base64. A committed file must never hold raw CRLF line ends, which
/// `git diff --check` reports as trailing whitespace, so the Windows launchers travel as JSON
/// escapes (see `contract/.gitattributes`).
#[derive(Serialize)]
struct InstalledFile {
    encoding: &'static str,
    content: String,
}

impl InstalledFile {
    fn new(bytes: &[u8]) -> Self {
        let printable = bytes
            .iter()
            .all(|byte| byte.is_ascii_graphic() || matches!(byte, b' ' | b'\n' | b'\r' | b'\t'));
        if printable {
            Self {
                encoding: "utf8",
                content: String::from_utf8(bytes.to_vec()).expect("ASCII is UTF-8"),
            }
        } else {
            Self {
                encoding: "base64",
                content: base64(bytes),
            }
        }
    }
}

/// Standard base64 (RFC 4648, padded).
fn base64(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let group = chunk.iter().enumerate().fold(0u32, |group, (index, byte)| {
            group | u32::from(*byte) << (16 - 8 * index)
        });
        for position in 0..4 {
            if position <= chunk.len() {
                out.push(DIGITS[(group >> (18 - 6 * position) & 0x3f) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

#[test]
fn base64_matches_the_rfc_4648_vectors() {
    for (plain, encoded) in [
        ("", ""),
        ("f", "Zg=="),
        ("fo", "Zm8="),
        ("foo", "Zm9v"),
        ("foob", "Zm9vYg=="),
        ("fooba", "Zm9vYmE="),
        ("foobar", "Zm9vYmFy"),
    ] {
        assert_eq!(base64(plain.as_bytes()), encoded, "{plain:?}");
    }
    assert_eq!(base64(&[0, 255, 254]), "AP/+");
}

/// Installs the fixture release for `target` through a loopback feed and returns every file of
/// the install root's `versions/<v>`, keyed by its path relative to the root.
/// `packages/computer` materializes them and verifies them with its own `ComputerUpdater`, which
/// must accept every file byte for byte.
fn installed_files(target: &str) -> BTreeMap<String, InstalledFile> {
    let release = Release::new(VERSION, target);
    let server = Server::start(release.routes());
    let root = Scratch::new("prepare-emit");
    let lock = MachineMutationLock::acquire(root.path()).unwrap();
    let store = VersionStore::new(root.path(), target);
    prepare_version(&lock, &feed(&server), &store, "latest").unwrap();

    let directory = store.version_directory(VERSION);
    let files: BTreeMap<String, InstalledFile> = names(&directory)
        .into_iter()
        .map(|name| {
            let bytes = fs::read(directory.join(&name)).unwrap();
            (
                format!("versions/{VERSION}/{name}"),
                InstalledFile::new(&bytes),
            )
        })
        .collect();
    let identity: InstalledIdentity =
        serde_json::from_slice(&fs::read(directory.join("installation.json")).unwrap()).unwrap();
    assert_eq!(identity.computer, measure_bytes(&release.computer));
    files
}

#[test]
fn emits_installed_versions_for_the_product() {
    let installed: BTreeMap<&str, BTreeMap<String, InstalledFile>> = ["linux-x64", "windows-x64"]
        .into_iter()
        .map(|target| (target, installed_files(target)))
        .collect();
    // The Windows launchers are the reason for the encoding: they must come out as escapes.
    let windows = &installed["windows-x64"][&format!("versions/{VERSION}/coforge.cmd")];
    assert_eq!(
        (windows.encoding, windows.content.contains("\r\n")),
        ("utf8", true)
    );

    let mut text = serde_json::to_string_pretty(&installed).unwrap();
    text.push('\n');
    assert!(
        !text.contains('\r'),
        "the committed file must hold no raw CR"
    );
    let directory = contract_rust_directory();
    fs::create_dir_all(&directory).unwrap();
    fs::write(directory.join("installed-versions.json"), text).unwrap();
}
