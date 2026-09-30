use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::thread;

use flate2::Compression;
use flate2::write::GzEncoder;

use super::*;

/// A fresh, empty directory under the system temp directory, removed on drop.
struct Scratch(PathBuf);

impl Scratch {
    fn new(label: &str) -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "coforge-installer-test-{label}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn entries(&self) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(&self.0)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn sha256(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

fn gzip(bytes: &[u8]) -> Vec<u8> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(bytes).unwrap();
    encoder.finish().unwrap()
}

fn request(out: PathBuf, sha256: String) -> FetchRequest {
    FetchRequest {
        url: "https://example.invalid/coforge-computer.gz".into(),
        sha256,
        expanded_sha256: None,
        out,
        max_bytes: DEFAULT_MAX_BYTES,
    }
}

#[test]
fn a_verified_gzip_object_is_expanded_into_place() {
    let scratch = Scratch::new("gzip-ok");
    let payload = b"#!/bin/sh\necho coforge\n".repeat(1000);
    let wire = gzip(&payload);
    let out = scratch.0.join("coforge-computer");
    let mut req = request(out.clone(), sha256(&wire));
    req.expanded_sha256 = Some(sha256(&payload));

    let receipt = install(wire.as_slice(), true, &req).unwrap();

    assert_eq!(fs::read(&out).unwrap(), payload);
    assert_eq!(receipt.wire_bytes, wire.len() as u64);
    assert_eq!(receipt.written_bytes, payload.len() as u64);
    assert_eq!(receipt.written_sha256, sha256(&payload));
    assert_eq!(scratch.entries(), vec!["coforge-computer"]);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&out).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }
}

#[test]
fn a_wire_checksum_mismatch_writes_nothing() {
    let scratch = Scratch::new("sha-mismatch");
    let wire = gzip(b"payload");
    let out = scratch.0.join("coforge-computer");

    let error = install(wire.as_slice(), true, &request(out.clone(), "0".repeat(64))).unwrap_err();

    assert_eq!(error.code, FetchErrorCode::ChecksumMismatch);
    assert!(!out.exists());
    assert!(scratch.entries().is_empty(), "{:?}", scratch.entries());
}

#[test]
fn an_expanded_checksum_mismatch_writes_nothing() {
    let scratch = Scratch::new("expanded-mismatch");
    let wire = gzip(b"payload");
    let out = scratch.0.join("coforge-computer");
    let mut req = request(out.clone(), sha256(&wire));
    req.expanded_sha256 = Some(sha256(b"something else"));

    let error = install(wire.as_slice(), true, &req).unwrap_err();

    assert_eq!(error.code, FetchErrorCode::ChecksumMismatch);
    assert!(scratch.entries().is_empty(), "{:?}", scratch.entries());
}

#[test]
fn a_gzip_bomb_stops_at_the_expanded_size_cap() {
    let scratch = Scratch::new("bomb");
    // 64 MiB of zeros compresses to roughly 64 KiB.
    let wire = gzip(&vec![0u8; 64 * 1024 * 1024]);
    let out = scratch.0.join("coforge-computer");
    let mut req = request(out.clone(), sha256(&wire));
    req.max_bytes = 1024 * 1024;

    let error = install(wire.as_slice(), true, &req).unwrap_err();

    assert_eq!(error.code, FetchErrorCode::SizeLimit, "{}", error.message);
    assert!(scratch.entries().is_empty(), "{:?}", scratch.entries());
}

#[test]
fn a_download_over_the_cap_is_refused() {
    let scratch = Scratch::new("wire-cap");
    let wire = vec![7u8; 4096];
    let out = scratch.0.join("coforge-computer");
    let mut req = request(out.clone(), sha256(&wire));
    req.max_bytes = 1000;

    let error = install(wire.as_slice(), false, &req).unwrap_err();

    assert_eq!(error.code, FetchErrorCode::SizeLimit, "{}", error.message);
    assert!(scratch.entries().is_empty(), "{:?}", scratch.entries());
}

#[test]
fn a_corrupt_gzip_stream_is_reported_as_such() {
    let scratch = Scratch::new("corrupt");
    let mut wire = gzip(&b"payload".repeat(100));
    let middle = wire.len() / 2;
    wire[middle] ^= 0xff;
    let out = scratch.0.join("coforge-computer");

    let error = install(wire.as_slice(), true, &request(out.clone(), sha256(&wire))).unwrap_err();

    assert_eq!(error.code, FetchErrorCode::GzipInvalid, "{}", error.message);
    assert!(scratch.entries().is_empty(), "{:?}", scratch.entries());
}

#[test]
fn a_failed_fetch_leaves_the_existing_file_untouched() {
    let scratch = Scratch::new("keep-existing");
    let out = scratch.0.join("coforge-computer");
    fs::write(&out, b"previous version").unwrap();
    let wire = gzip(b"new version");

    let error = install(wire.as_slice(), true, &request(out.clone(), "f".repeat(64))).unwrap_err();

    assert_eq!(error.code, FetchErrorCode::ChecksumMismatch);
    assert_eq!(fs::read(&out).unwrap(), b"previous version");
    assert_eq!(scratch.entries(), vec!["coforge-computer"]);
}

#[test]
fn a_verified_fetch_replaces_the_existing_file() {
    let scratch = Scratch::new("replace-existing");
    let out = scratch.0.join("coforge-computer");
    fs::write(&out, b"previous version").unwrap();
    let wire = gzip(b"new version");

    install(wire.as_slice(), true, &request(out.clone(), sha256(&wire))).unwrap();

    assert_eq!(fs::read(&out).unwrap(), b"new version");
    assert_eq!(scratch.entries(), vec!["coforge-computer"]);
}

#[test]
fn only_a_gz_path_is_expanded() {
    assert!(url_names_gzip(
        "https://h/0.1.1/darwin-arm64/coforge-computer.gz"
    ));
    assert!(url_names_gzip("https://h/a.gz?token=1#frag"));
    assert!(!url_names_gzip("https://h/a.gz.sha256"));
    assert!(!url_names_gzip("https://h/a?name=b.gz"));
}

/// Serves exactly one HTTP/1.1 response on a loopback port and returns its base URL.
fn serve_once(status: &'static str, body: Vec<u8>) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut line = String::new();
        while reader.read_line(&mut line).unwrap() > 0 && line != "\r\n" {
            line.clear();
        }
        write!(
            stream,
            "HTTP/1.1 {status}\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .unwrap();
        stream.write_all(&body).unwrap();
    });
    format!("http://{address}")
}

#[test]
fn fetch_downloads_verifies_and_places_an_object_over_http() {
    let scratch = Scratch::new("http-ok");
    let payload = b"binary bytes".repeat(500);
    let wire = gzip(&payload);
    let base = serve_once("200 OK", wire.clone());
    let out = scratch.0.join("coforge-computer");
    let mut req = request(out.clone(), sha256(&wire));
    req.url = format!("{base}/0.0.0/darwin-arm64/coforge-computer.gz");
    req.expanded_sha256 = Some(sha256(&payload));

    let receipt = fetch(&agent(false), &req).unwrap();

    assert!(receipt.gzip);
    assert_eq!(fs::read(&out).unwrap(), payload);
}

#[test]
fn fetch_reports_a_non_success_status() {
    let scratch = Scratch::new("http-404");
    let base = serve_once("404 Not Found", b"missing".to_vec());
    let out = scratch.0.join("coforge-computer");
    let mut req = request(out.clone(), "0".repeat(64));
    req.url = format!("{base}/missing.gz");

    let error = fetch(&agent(false), &req).unwrap_err();

    assert_eq!(error.code, FetchErrorCode::HttpStatus, "{}", error.message);
    assert!(scratch.entries().is_empty(), "{:?}", scratch.entries());
}

#[test]
fn the_production_agent_refuses_plain_http() {
    let scratch = Scratch::new("https-only");
    let out = scratch.0.join("coforge-computer");
    let mut req = request(out, "0".repeat(64));
    req.url = "http://127.0.0.1:9/never-contacted.gz".into();

    let error = fetch(&https_agent(), &req).unwrap_err();

    assert_eq!(error.code, FetchErrorCode::Download, "{}", error.message);
}
