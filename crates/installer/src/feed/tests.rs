use std::fs;

use serde_json::Value;

use super::*;
use crate::contract::ReleaseManifest;
use crate::digest::measure_bytes;
use crate::manifest::{computer_artifact, parse_release_manifest};
use crate::test_support::{Release, Response, Scratch, Server, gzip};

const VERSION: &str = "0.2.0";
const TARGET: &str = "linux-x64";

fn serve(release: &Release) -> Server {
    Server::start(release.routes())
}

fn feed(server: &Server) -> Feed {
    Feed::new(&server.base_url(), crate::fetch::agent(false))
}

fn manifest_of(release: &Release) -> ReleaseManifest {
    parse_release_manifest(release.manifest().to_string().as_bytes(), &release.version).unwrap()
}

fn feed_invalid(error: UpdateError) -> String {
    match error {
        UpdateError::FeedInvalid(message) => message,
        other => panic!("expected UPDATE_FEED_INVALID, got {other:?}"),
    }
}

fn integrity_failed(error: UpdateError) -> String {
    match error {
        UpdateError::IntegrityFailed(message) => message,
        other => panic!("expected UPDATE_INTEGRITY_FAILED, got {other:?}"),
    }
}

fn with_pointer(release: &Release, pointer: impl Into<Vec<u8>>) -> Server {
    let mut routes = release.routes();
    routes.insert("/latest".into(), Response::ok(pointer));
    Server::start(routes)
}

// ---- latest and explicit versions ---------------------------------------------------------

#[test]
fn latest_resolves_through_the_pointer_file() {
    let server = serve(&Release::new(VERSION, TARGET));

    assert_eq!(feed(&server).resolve_version("latest").unwrap(), VERSION);
    assert_eq!(feed(&server).resolve_version("").unwrap(), VERSION);
    assert_eq!(server.requests(), ["/latest", "/latest"]);
}

#[test]
fn the_pointer_may_be_padded_with_whitespace() {
    let release = Release::new(VERSION, TARGET);
    let server = with_pointer(&release, "  0.2.0 \r\n\n");

    assert_eq!(feed(&server).resolve_version("latest").unwrap(), VERSION);
}

#[test]
fn a_pointer_that_is_not_one_concrete_valid_version_is_rejected() {
    let release = Release::new(VERSION, TARGET);
    for pointer in [
        "",
        "\n",
        "latest",
        "../evil",
        "-x",
        "1..2",
        ".",
        "a b",
        "0.2.0\n0.2.1",
        "0.2.0/../x",
        "caf\u{e9}",
    ] {
        let server = with_pointer(&release, pointer);
        let error = feed(&server).resolve_version("latest").unwrap_err();
        assert!(
            matches!(error, UpdateError::FeedInvalid(_)),
            "{pointer:?}: {error:?}"
        );
    }
}

#[test]
fn a_pointer_over_4096_bytes_is_rejected() {
    let release = Release::new(VERSION, TARGET);
    let server = with_pointer(&release, format!("{}0.2.0", " ".repeat(4096)));

    let message = feed_invalid(feed(&server).resolve_version("latest").unwrap_err());

    assert!(message.contains("4096"), "{message}");
}

#[test]
fn a_pointer_that_redirects_or_is_missing_is_rejected() {
    let release = Release::new(VERSION, TARGET);
    let mut routes = release.routes();
    routes.insert("/latest".into(), Response::redirect("/0.2.0/manifest.json"));
    let server = Server::start(routes);
    feed_invalid(feed(&server).resolve_version("latest").unwrap_err());
    assert_eq!(server.requests(), ["/latest"], "the redirect was followed");

    let empty = Server::start(Default::default());
    feed_invalid(feed(&empty).resolve_version("latest").unwrap_err());
}

#[test]
fn a_concrete_version_is_used_as_given_without_asking_the_feed() {
    let server = serve(&Release::new(VERSION, TARGET));

    assert_eq!(
        feed(&server).resolve_version("0.1.1-dev.42").unwrap(),
        "0.1.1-dev.42"
    );
    assert!(server.requests().is_empty());
}

#[test]
fn a_version_that_is_not_a_url_segment_is_refused_before_any_request() {
    let release = Release::new(VERSION, TARGET);
    let server = serve(&release);
    for version in ["../x", "a/b", ".", "-x"] {
        feed_invalid(feed(&server).manifest(version).unwrap_err());
    }
    assert!(server.requests().is_empty());
}

#[test]
fn a_selection_that_is_neither_latest_nor_a_valid_version_is_rejected() {
    let server = serve(&Release::new(VERSION, TARGET));
    for selection in [".", "..", "../x", "a/b", "-x", "1..2", "a b", "sha256:abc"] {
        let message = feed_invalid(feed(&server).resolve_version(selection).unwrap_err());
        assert_eq!(
            message, "version must be latest or a valid version string",
            "{selection:?}"
        );
    }
    assert!(server.requests().is_empty());
}

#[test]
fn objects_are_requested_below_the_feed_url_whatever_its_trailing_slashes() {
    let release = Release::new(VERSION, TARGET);
    let routes = release
        .routes()
        .into_iter()
        .map(|(path, response)| (format!("/feed{path}"), response))
        .collect();
    let server = Server::start(routes);
    for base in ["/feed", "/feed/", "/feed//"] {
        let feed = Feed::new(
            &format!("{}{base}", server.base_url()),
            crate::fetch::agent(false),
        );
        assert_eq!(feed.resolve_version("latest").unwrap(), VERSION, "{base}");
    }
    assert_eq!(server.requests(), ["/feed/latest"; 3]);
}

// ---- manifest -----------------------------------------------------------------------------

#[test]
fn the_manifest_is_fetched_from_the_version_and_validated() {
    let release = Release::new(VERSION, TARGET);
    let server = serve(&release);

    let manifest = feed(&server).manifest(VERSION).unwrap();

    assert_eq!(manifest.version, VERSION);
    assert_eq!(server.requests(), ["/0.2.0/manifest.json"]);
    let computer = computer_artifact(&manifest, TARGET).unwrap();
    assert_eq!(computer.identity, measure_bytes(&release.computer));
}

#[test]
fn a_manifest_that_fails_validation_is_rejected() {
    let release = Release::new(VERSION, TARGET);
    let mut wrong_version = release.manifest();
    wrong_version["version"] = Value::String("0.1.9".into());
    let mut extra_key = release.manifest();
    extra_key["platforms"][TARGET]["daemon"] = Value::Bool(true);
    for (name, body) in [
        ("wrong version", wrong_version.to_string()),
        ("extra platform key", extra_key.to_string()),
        ("not json", "<html>".to_string()),
    ] {
        let mut routes = release.routes();
        routes.insert("/0.2.0/manifest.json".into(), Response::ok(body));
        let server = Server::start(routes);
        let error = feed(&server).manifest(VERSION).unwrap_err();
        assert!(
            matches!(error, UpdateError::FeedInvalid(_)),
            "{name}: {error:?}"
        );
    }
}

#[test]
fn a_manifest_over_one_mebibyte_is_rejected() {
    let release = Release::new(VERSION, TARGET);
    let mut routes = release.routes();
    let mut padded = release.manifest().to_string().into_bytes();
    padded.resize(1024 * 1024 + 1, b' ');
    routes.insert("/0.2.0/manifest.json".into(), Response::ok(padded.clone()));
    let server = Server::start(routes);

    let message = feed_invalid(feed(&server).manifest(VERSION).unwrap_err());
    assert!(message.contains("1048576"), "{message}");

    // Exactly one mebibyte still passes: JSON tolerates trailing space.
    padded.pop();
    let mut routes = release.routes();
    routes.insert("/0.2.0/manifest.json".into(), Response::ok(padded));
    let server = Server::start(routes);
    feed(&server).manifest(VERSION).unwrap();
}

#[test]
fn a_manifest_that_redirects_or_is_missing_is_rejected() {
    let release = Release::new(VERSION, TARGET);
    let mut routes = release.routes();
    let elsewhere = "/0.2.0/elsewhere.json".to_string();
    routes.insert(elsewhere.clone(), routes["/0.2.0/manifest.json"].clone());
    routes.insert(
        "/0.2.0/manifest.json".into(),
        Response::redirect(&elsewhere),
    );
    let server = Server::start(routes);

    feed_invalid(feed(&server).manifest(VERSION).unwrap_err());
    assert_eq!(server.requests(), ["/0.2.0/manifest.json"]);

    let empty = Server::start(Default::default());
    feed_invalid(feed(&empty).manifest(VERSION).unwrap_err());
}

// ---- the executable -----------------------------------------------------------------------

fn download_computer(
    release: &Release,
    server: &Server,
    manifest: &ReleaseManifest,
    out: &Scratch,
) -> Result<ArtifactIdentity, UpdateError> {
    let artifact = computer_artifact(manifest, &release.target).unwrap();
    feed(server).download_computer(
        &release.version,
        &release.target,
        artifact,
        &out.path().join("coforge-computer"),
    )
}

#[test]
fn the_executable_is_downloaded_expanded_and_verified() {
    let release = Release::new(VERSION, TARGET);
    let server = serve(&release);
    let out = Scratch::new("feed-computer");

    let identity = download_computer(&release, &server, &manifest_of(&release), &out).unwrap();

    assert_eq!(
        fs::read(out.path().join("coforge-computer")).unwrap(),
        release.computer
    );
    assert_eq!(identity, measure_bytes(&release.computer));
    assert_eq!(server.requests(), ["/0.2.0/linux-x64/coforge-computer.gz"]);
}

#[test]
fn a_wrong_size_or_checksum_for_the_executable_is_an_integrity_failure() {
    let release = Release::new(VERSION, TARGET);
    type Edit = fn(&mut Value);
    let edits: [(&str, &str, Edit); 6] = [
        ("gzip checksum", "downloaded bytes hash to", |m| {
            m["platforms"][TARGET]["computer"]["gzip"]["checksum"] = Value::String("0".repeat(64))
        }),
        ("gzip size too large", "not the recorded", |m| {
            let size = m["platforms"][TARGET]["computer"]["gzip"]["size"]
                .as_u64()
                .unwrap();
            m["platforms"][TARGET]["computer"]["gzip"]["size"] = (size + 1).into()
        }),
        (
            "gzip size too small",
            "larger than its recorded size (download",
            |m| {
                let size = m["platforms"][TARGET]["computer"]["gzip"]["size"]
                    .as_u64()
                    .unwrap();
                m["platforms"][TARGET]["computer"]["gzip"]["size"] = (size - 1).into()
            },
        ),
        ("expanded checksum", "written file hashes to", |m| {
            m["platforms"][TARGET]["computer"]["checksum"] = Value::String("1".repeat(64))
        }),
        ("expanded size too large", "not the recorded", |m| {
            let size = m["platforms"][TARGET]["computer"]["size"].as_u64().unwrap();
            m["platforms"][TARGET]["computer"]["size"] = (size + 1).into()
        }),
        (
            "expanded size too small",
            "larger than its recorded size (expanded file",
            |m| {
                let size = m["platforms"][TARGET]["computer"]["size"].as_u64().unwrap();
                m["platforms"][TARGET]["computer"]["size"] = (size - 1).into()
            },
        ),
    ];
    for (name, expected, edit) in edits {
        let mut manifest = release.manifest();
        edit(&mut manifest);
        let manifest = parse_release_manifest(manifest.to_string().as_bytes(), VERSION).unwrap();
        let server = serve(&release);
        let out = Scratch::new("feed-computer-bad");

        let error = download_computer(&release, &server, &manifest, &out).unwrap_err();

        // Which check stopped it is part of the behaviour: a recorded size that is too small is
        // refused while streaming, a checksum after it, and a size that is too large last.
        assert!(
            matches!(&error, UpdateError::IntegrityFailed(message) if message.contains(expected)),
            "{name}: {error:?}"
        );
        assert!(
            fs::read_dir(out.path()).unwrap().next().is_none(),
            "{name} left a file behind"
        );
    }
}

#[test]
fn a_gzip_bomb_is_stopped_at_the_recorded_size() {
    let release = Release::new(VERSION, TARGET);
    // 64 MiB of zeros compresses to about 64 KiB, but the manifest records the real 39 bytes.
    // The gzip identity is the bomb's own, so only the size bound can stop it.
    let bomb = gzip(&vec![0u8; 64 * 1024 * 1024]);
    let identity = measure_bytes(&bomb);
    let mut manifest = release.manifest();
    manifest["platforms"][TARGET]["computer"]["gzip"]["size"] = identity.size.into();
    manifest["platforms"][TARGET]["computer"]["gzip"]["checksum"] = identity.checksum.into();
    let manifest = parse_release_manifest(manifest.to_string().as_bytes(), VERSION).unwrap();
    let mut routes = release.routes();
    routes.insert(release.computer_path(), Response::ok(bomb));
    let server = Server::start(routes);
    let out = Scratch::new("feed-bomb");

    let message =
        integrity_failed(download_computer(&release, &server, &manifest, &out).unwrap_err());

    assert!(message.contains("recorded size"), "{message}");
    assert!(fs::read_dir(out.path()).unwrap().next().is_none());
}

#[test]
fn a_corrupt_gzip_stream_with_the_recorded_checksum_is_an_integrity_failure() {
    let mut release = Release::new(VERSION, TARGET);
    let mut corrupt = release.computer_gzip.clone();
    let middle = corrupt.len() / 2;
    corrupt[middle] ^= 0xff;
    release.computer_gzip = corrupt;
    let server = serve(&release);
    let out = Scratch::new("feed-corrupt");

    let message = integrity_failed(
        download_computer(&release, &server, &manifest_of(&release), &out).unwrap_err(),
    );

    assert!(
        message.contains("compressed artifact is invalid"),
        "{message}"
    );
}

#[test]
fn a_body_cut_short_is_an_integrity_failure_without_a_length_and_a_feed_error_with_one() {
    // What TS does: install.sh's curl accepts a close-delimited body as complete, so the size
    // check in `#verifyArtifact` reports an integrity failure; a body shorter than its
    // Content-Length makes curl itself fail, which the updater reports as a feed error.
    let release = Release::new(VERSION, TARGET);
    let cut = release.computer_gzip[..release.computer_gzip.len() / 2].to_vec();
    let out = Scratch::new("feed-cut-short");

    let mut routes = release.routes();
    routes.insert(
        release.computer_path(),
        Response::ok(cut.clone()).without_content_length(),
    );
    let server = Server::start(routes);
    integrity_failed(
        download_computer(&release, &server, &manifest_of(&release), &out).unwrap_err(),
    );

    let mut routes = release.routes();
    routes.insert(
        release.computer_path(),
        Response::ok(cut).declaring(release.computer_gzip.len()),
    );
    let server = Server::start(routes);
    feed_invalid(download_computer(&release, &server, &manifest_of(&release), &out).unwrap_err());
    assert!(fs::read_dir(out.path()).unwrap().next().is_none());
}

#[test]
fn bytes_after_the_last_gzip_member_are_an_integrity_failure_even_when_the_manifest_covers_them() {
    let mut release = Release::new(VERSION, TARGET);
    release.computer_gzip.extend_from_slice(b"trailing bytes");
    let server = serve(&release);
    let out = Scratch::new("feed-trailing");

    let message = integrity_failed(
        download_computer(&release, &server, &manifest_of(&release), &out).unwrap_err(),
    );

    assert!(
        message.contains("compressed artifact is invalid"),
        "{message}"
    );
    assert!(fs::read_dir(out.path()).unwrap().next().is_none());
}

#[test]
fn a_gzip_of_several_members_is_expanded_whole() {
    // Bun's `DecompressionStream`, which the updater uses, accepts concatenated members.
    let mut release = Release::new(VERSION, TARGET);
    release.computer = b"first, second".to_vec();
    release.computer_gzip = [gzip(b"first, "), gzip(b"second")].concat();
    let server = serve(&release);
    let out = Scratch::new("feed-members");

    let identity = download_computer(&release, &server, &manifest_of(&release), &out).unwrap();

    assert_eq!(
        fs::read(out.path().join("coforge-computer")).unwrap(),
        b"first, second"
    );
    assert_eq!(identity, measure_bytes(b"first, second"));
}

#[test]
fn the_download_is_capped_at_the_recorded_compressed_size_not_at_the_larger_expanded_size() {
    // A real executable expands to far more bytes than it downloads. Serving a few bytes beyond
    // the recorded compressed size must be refused as an oversized download, however much room
    // the expanded size would leave.
    let mut release = Release::new(VERSION, TARGET);
    release.computer = vec![0u8; 100_000];
    release.computer_gzip = gzip(&release.computer);
    let recorded = release.computer_gzip.len();
    assert!(recorded < 1_000, "the fixture must compress well");
    let mut oversized = release.computer_gzip.clone();
    oversized.extend_from_slice(&[0u8; 500]);
    let mut routes = release.routes();
    routes.insert(release.computer_path(), Response::ok(oversized));
    let server = Server::start(routes);
    let out = Scratch::new("feed-wire-cap");

    let message = integrity_failed(
        download_computer(&release, &server, &manifest_of(&release), &out).unwrap_err(),
    );

    assert!(
        message.contains(&format!("download exceeds the {recorded}-byte cap")),
        "{message}"
    );
    assert!(fs::read_dir(out.path()).unwrap().next().is_none());
}

#[test]
fn a_failure_to_write_the_download_has_no_product_code() {
    // TS reports it as UPDATE_FEED_INVALID only because `#prepareArtifact` wraps every failure
    // of the curl child (a full disk is curl's exit 23) in one catch-all; that is not a decision
    // about what a full disk means, and the message here names the real cause.
    let release = Release::new(VERSION, TARGET);
    let server = serve(&release);
    let out = Scratch::new("feed-unwritable");
    let manifest = manifest_of(&release);

    let error = feed(&server)
        .download_computer(
            VERSION,
            TARGET,
            computer_artifact(&manifest, TARGET).unwrap(),
            &out.path()
                .join("missing-directory")
                .join("coforge-computer"),
        )
        .unwrap_err();

    assert!(
        matches!(&error, UpdateError::Local(message) if message.contains("cannot create")),
        "{error:?}"
    );
    assert_eq!(error.code(), None);
}

#[test]
fn a_missing_or_redirected_executable_is_a_feed_error() {
    let release = Release::new(VERSION, TARGET);
    let out = Scratch::new("feed-computer-404");
    let mut routes = release.routes();
    routes.remove(&release.computer_path());
    let server = Server::start(routes);
    feed_invalid(download_computer(&release, &server, &manifest_of(&release), &out).unwrap_err());

    let mut routes = release.routes();
    routes.insert(release.computer_path(), Response::redirect("/elsewhere.gz"));
    let server = Server::start(routes);
    feed_invalid(download_computer(&release, &server, &manifest_of(&release), &out).unwrap_err());
    assert_eq!(server.requests(), [release.computer_path()]);
}

#[test]
fn an_object_recorded_beyond_the_transport_ceiling_is_refused_before_any_download() {
    // The compressed object and the file it expands to each have the 512 MiB ceiling that
    // install.sh applies to the download and to the expansion.
    type Edit = fn(&mut Value);
    let edits: [(&str, Edit); 2] = [
        ("compressed size", |m| {
            m["platforms"][TARGET]["computer"]["gzip"]["size"] = (512u64 * 1024 * 1024 + 1).into()
        }),
        ("expanded size", |m| {
            m["platforms"][TARGET]["computer"]["size"] = (512u64 * 1024 * 1024 + 1).into()
        }),
    ];
    for (name, edit) in edits {
        let release = Release::new(VERSION, TARGET);
        let server = serve(&release);
        let out = Scratch::new("feed-ceiling");
        let mut manifest = release.manifest();
        edit(&mut manifest);
        let manifest = parse_release_manifest(manifest.to_string().as_bytes(), VERSION).unwrap();

        let message =
            feed_invalid(download_computer(&release, &server, &manifest, &out).unwrap_err());

        assert!(message.contains("limit"), "{name}: {message}");
        assert!(server.requests().is_empty(), "{name}");
    }
}

// ---- Pi's image library -------------------------------------------------------------------

fn download_wasm(
    release: &Release,
    server: &Server,
    manifest: &ReleaseManifest,
    out: &Scratch,
) -> Result<ArtifactIdentity, UpdateError> {
    feed(server).download_photon_wasm(
        &release.version,
        &manifest.photon_wasm,
        &out.path().join("photon_rs_bg.wasm"),
    )
}

#[test]
fn the_image_library_is_downloaded_and_verified() {
    let release = Release::new(VERSION, TARGET);
    let server = serve(&release);
    let out = Scratch::new("feed-wasm");

    let identity = download_wasm(&release, &server, &manifest_of(&release), &out).unwrap();

    assert_eq!(
        fs::read(out.path().join("photon_rs_bg.wasm")).unwrap(),
        release.photon_wasm
    );
    assert_eq!(identity, measure_bytes(&release.photon_wasm));
    assert_eq!(server.requests(), ["/0.2.0/photon_rs_bg.wasm"]);
}

#[test]
fn a_wrong_size_or_checksum_for_the_image_library_is_an_integrity_failure() {
    let release = Release::new(VERSION, TARGET);
    type Edit = fn(&mut Value);
    let edits: [(&str, &str, Edit); 3] = [
        ("checksum", "downloaded bytes hash to", |m| {
            m["photonWasm"]["checksum"] = Value::String("2".repeat(64))
        }),
        ("size too large", "not the recorded", |m| {
            let size = m["photonWasm"]["size"].as_u64().unwrap();
            m["photonWasm"]["size"] = (size + 1).into()
        }),
        (
            "size too small",
            "larger than its recorded size (download",
            |m| {
                let size = m["photonWasm"]["size"].as_u64().unwrap();
                m["photonWasm"]["size"] = (size - 1).into()
            },
        ),
    ];
    for (name, expected, edit) in edits {
        let mut manifest = release.manifest();
        edit(&mut manifest);
        let manifest = parse_release_manifest(manifest.to_string().as_bytes(), VERSION).unwrap();
        let server = serve(&release);
        let out = Scratch::new("feed-wasm-bad");

        let error = download_wasm(&release, &server, &manifest, &out).unwrap_err();

        assert!(
            matches!(&error, UpdateError::IntegrityFailed(message) if message.contains(expected)),
            "{name}: {error:?}"
        );
        assert!(fs::read_dir(out.path()).unwrap().next().is_none(), "{name}");
    }
}

#[test]
fn a_missing_image_library_is_a_feed_error_and_an_oversized_record_is_refused() {
    let release = Release::new(VERSION, TARGET);
    let out = Scratch::new("feed-wasm-404");
    let mut routes = release.routes();
    routes.remove(&release.photon_wasm_path());
    let server = Server::start(routes);
    feed_invalid(download_wasm(&release, &server, &manifest_of(&release), &out).unwrap_err());

    let server = serve(&release);
    let mut manifest = release.manifest();
    manifest["photonWasm"]["size"] = (16u64 * 1024 * 1024 + 1).into();
    let manifest = parse_release_manifest(manifest.to_string().as_bytes(), VERSION).unwrap();
    feed_invalid(download_wasm(&release, &server, &manifest, &out).unwrap_err());
    assert!(server.requests().is_empty());
}
