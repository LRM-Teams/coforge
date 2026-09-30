use std::fs;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::thread;

use super::*;
use crate::test_support::{self, Scratch, gzip};

fn sha256(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

fn request(out: PathBuf, sha256: String) -> FetchRequest {
    FetchRequest {
        url: "https://example.invalid/coforge-computer.gz".into(),
        sha256,
        expanded_sha256: None,
        out,
        max_wire_bytes: DEFAULT_MAX_BYTES,
        max_written_bytes: DEFAULT_MAX_BYTES,
    }
}

#[test]
fn a_verified_gzip_object_is_expanded_into_place() {
    let scratch = Scratch::new("gzip-ok");
    let payload = b"#!/bin/sh\necho coforge\n".repeat(1000);
    let wire = gzip(&payload);
    let out = scratch.path().join("coforge-computer");
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
    let out = scratch.path().join("coforge-computer");

    let error = install(wire.as_slice(), true, &request(out.clone(), "0".repeat(64))).unwrap_err();

    assert_eq!(error.code, FetchErrorCode::ChecksumMismatch);
    assert!(!out.exists());
    assert!(scratch.entries().is_empty(), "{:?}", scratch.entries());
}

#[test]
fn an_expanded_checksum_mismatch_writes_nothing() {
    let scratch = Scratch::new("expanded-mismatch");
    let wire = gzip(b"payload");
    let out = scratch.path().join("coforge-computer");
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
    let out = scratch.path().join("coforge-computer");
    let mut req = request(out.clone(), sha256(&wire));
    req.max_written_bytes = 1024 * 1024;

    let error = install(wire.as_slice(), true, &req).unwrap_err();

    assert_eq!(error.code, FetchErrorCode::SizeLimit, "{}", error.message);
    assert!(scratch.entries().is_empty(), "{:?}", scratch.entries());
}

#[test]
fn a_download_over_the_cap_is_refused() {
    let scratch = Scratch::new("wire-cap");
    let wire = vec![7u8; 4096];
    let out = scratch.path().join("coforge-computer");
    let mut req = request(out.clone(), sha256(&wire));
    req.max_wire_bytes = 1000;

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
    let out = scratch.path().join("coforge-computer");

    let error = install(wire.as_slice(), true, &request(out.clone(), sha256(&wire))).unwrap_err();

    assert_eq!(error.code, FetchErrorCode::GzipInvalid, "{}", error.message);
    assert!(scratch.entries().is_empty(), "{:?}", scratch.entries());
}

#[test]
fn a_failed_fetch_leaves_the_existing_file_untouched() {
    let scratch = Scratch::new("keep-existing");
    let out = scratch.path().join("coforge-computer");
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
    let out = scratch.path().join("coforge-computer");
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
    let out = scratch.path().join("coforge-computer");
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
    let out = scratch.path().join("coforge-computer");
    let mut req = request(out.clone(), "0".repeat(64));
    req.url = format!("{base}/missing.gz");

    let error = fetch(&agent(false), &req).unwrap_err();

    assert_eq!(error.code, FetchErrorCode::HttpStatus, "{}", error.message);
    assert!(scratch.entries().is_empty(), "{:?}", scratch.entries());
}

#[test]
fn the_production_agent_refuses_plain_http() {
    let scratch = Scratch::new("https-only");
    let out = scratch.path().join("coforge-computer");
    let mut req = request(out, "0".repeat(64));
    req.url = "http://127.0.0.1:9/never-contacted.gz".into();

    let error = fetch(&https_agent(), &req).unwrap_err();

    assert_eq!(error.code, FetchErrorCode::Download, "{}", error.message);
}

fn serve(routes: &[(&str, test_support::Response)]) -> test_support::Server {
    test_support::Server::start(
        routes
            .iter()
            .map(|(path, response)| (path.to_string(), response.clone()))
            .collect(),
    )
}

#[test]
fn fetch_refuses_a_redirect() {
    let scratch = Scratch::new("http-redirect");
    let server = serve(&[
        (
            "/moved.gz",
            test_support::Response::redirect("/elsewhere.gz"),
        ),
        (
            "/elsewhere.gz",
            test_support::Response::ok(gzip(b"payload")),
        ),
    ]);
    let out = scratch.path().join("coforge-computer");
    let mut req = request(out, "0".repeat(64));
    req.url = format!("{}/moved.gz", server.base_url());

    let error = fetch(&agent(false), &req).unwrap_err();

    assert_eq!(error.code, FetchErrorCode::HttpStatus, "{}", error.message);
    assert!(error.message.contains("302"), "{}", error.message);
    assert_eq!(
        server.requests(),
        ["/moved.gz"],
        "the redirect was followed"
    );
    assert!(scratch.entries().is_empty(), "{:?}", scratch.entries());
}

#[test]
fn fetch_bytes_returns_a_small_object() {
    let server = serve(&[("/latest", test_support::Response::ok(b"0.2.0\n".to_vec()))]);

    let bytes = fetch_bytes(
        &agent(false),
        &format!("{}/latest", server.base_url()),
        4096,
    )
    .unwrap();

    assert_eq!(bytes, b"0.2.0\n");
}

#[test]
fn fetch_bytes_accepts_exactly_the_cap_and_refuses_one_byte_more() {
    let server = serve(&[("/object", test_support::Response::ok(vec![b'x'; 100]))]);
    let url = format!("{}/object", server.base_url());

    assert_eq!(fetch_bytes(&agent(false), &url, 100).unwrap().len(), 100);
    let error = fetch_bytes(&agent(false), &url, 99).unwrap_err();

    assert_eq!(error.code, FetchErrorCode::SizeLimit, "{}", error.message);
}

#[test]
fn fetch_bytes_reports_a_status_and_refuses_a_redirect() {
    let server = serve(&[
        ("/moved", test_support::Response::redirect("/elsewhere")),
        ("/elsewhere", test_support::Response::ok(b"x".to_vec())),
    ]);

    for path in ["/missing", "/moved"] {
        let error =
            fetch_bytes(&agent(false), &format!("{}{path}", server.base_url()), 10).unwrap_err();
        assert_eq!(
            error.code,
            FetchErrorCode::HttpStatus,
            "{path}: {}",
            error.message
        );
    }
    assert!(!server.requests().contains(&"/elsewhere".to_string()));
}

#[test]
fn fetch_bytes_refuses_plain_http_in_production() {
    let error = fetch_bytes(&https_agent(), "http://127.0.0.1:9/never-contacted", 10).unwrap_err();

    assert_eq!(error.code, FetchErrorCode::Download, "{}", error.message);
}

// ---- the wire cap and the expansion cap are separate -------------------------------------

#[test]
fn a_gzip_download_over_the_wire_cap_is_refused_even_though_its_expansion_fits() {
    let scratch = Scratch::new("wire-cap-gzip");
    let payload = b"payload ".repeat(1000);
    let wire = gzip(&payload);
    let mut req = request(scratch.path().join("coforge-computer"), sha256(&wire));
    req.max_wire_bytes = wire.len() as u64 - 1;

    let error = install(wire.as_slice(), true, &req).unwrap_err();

    assert_eq!(error.code, FetchErrorCode::SizeLimit, "{}", error.message);
    assert!(error.message.contains("download"), "{}", error.message);
    assert!(scratch.entries().is_empty(), "{:?}", scratch.entries());
}

#[test]
fn an_expansion_over_the_written_cap_is_refused_even_though_the_download_fits() {
    let scratch = Scratch::new("written-cap-gzip");
    let payload = b"payload ".repeat(1000);
    let wire = gzip(&payload);
    let mut req = request(scratch.path().join("coforge-computer"), sha256(&wire));
    req.max_written_bytes = payload.len() as u64 - 1;

    let error = install(wire.as_slice(), true, &req).unwrap_err();

    assert_eq!(error.code, FetchErrorCode::SizeLimit, "{}", error.message);
    assert!(error.message.contains("expanded file"), "{}", error.message);
    assert!(scratch.entries().is_empty(), "{:?}", scratch.entries());
}

#[test]
fn a_download_and_an_expansion_of_exactly_the_caps_are_accepted() {
    let scratch = Scratch::new("exact-caps");
    // A short payload compresses to more bytes than it started with, so the caps differ the
    // other way round from a real binary's.
    let payload = b"tiny".to_vec();
    let wire = gzip(&payload);
    assert!(wire.len() > payload.len());
    let out = scratch.path().join("coforge-computer");
    let mut req = request(out.clone(), sha256(&wire));
    req.max_wire_bytes = wire.len() as u64;
    req.max_written_bytes = payload.len() as u64;

    install(wire.as_slice(), true, &req).unwrap();

    assert_eq!(fs::read(out).unwrap(), payload);
}

// ---- what a broken body is called --------------------------------------------------------

/// A body that yields `prefix` and then fails with `kind`, as a dropped connection would.
struct FailingBody {
    prefix: io::Cursor<Vec<u8>>,
    kind: io::ErrorKind,
}

impl Read for FailingBody {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        match self.prefix.read(buffer)? {
            0 => Err(io::Error::new(self.kind, "connection reset")),
            read => Ok(read),
        }
    }
}

/// A body whose first read is interrupted, as a signal can interrupt a socket read.
struct InterruptedOnce<'a> {
    body: io::Cursor<&'a [u8]>,
    interrupted: bool,
}

impl Read for InterruptedOnce<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if !self.interrupted {
            self.interrupted = true;
            return Err(io::ErrorKind::Interrupted.into());
        }
        self.body.read(buffer)
    }
}

#[test]
fn an_interrupted_read_is_retried_and_is_not_a_transport_failure() {
    let wire = gzip(&b"payload".repeat(1000));
    fn body(wire: &[u8]) -> InterruptedOnce<'_> {
        InterruptedOnce {
            body: io::Cursor::new(wire),
            interrupted: false,
        }
    }

    // A complete body still installs.
    let scratch = Scratch::new("interrupted-ok");
    let req = request(scratch.path().join("coforge-computer"), sha256(&wire));
    install(body(&wire), true, &req).unwrap();

    // And a gzip stream that is cut short afterwards is still the object's fault, not the
    // network's: the interruption must not have marked the transport as failed.
    let scratch = Scratch::new("interrupted-cut");
    let cut = &wire[..wire.len() / 2];
    let req = request(scratch.path().join("coforge-computer"), sha256(cut));
    let error = install(body(cut), true, &req).unwrap_err();
    assert_eq!(error.code, FetchErrorCode::GzipInvalid, "{}", error.message);
}

#[test]
fn a_gzip_stream_cut_short_by_a_complete_body_is_a_gzip_error() {
    let scratch = Scratch::new("truncated-gzip");
    let wire = gzip(&b"payload".repeat(1000));
    let cut = &wire[..wire.len() / 2];
    let req = request(scratch.path().join("coforge-computer"), sha256(cut));

    let error = install(cut, true, &req).unwrap_err();

    assert_eq!(error.code, FetchErrorCode::GzipInvalid, "{}", error.message);
    assert!(scratch.entries().is_empty(), "{:?}", scratch.entries());
}

#[test]
fn a_failing_transport_is_a_download_error_whatever_kind_of_error_it_reports() {
    let wire = gzip(&b"payload".repeat(1000));
    for kind in [
        io::ErrorKind::Other,
        io::ErrorKind::ConnectionReset,
        io::ErrorKind::TimedOut,
        io::ErrorKind::UnexpectedEof,
        // These two are what a corrupt gzip stream reports, but here the network failed.
        io::ErrorKind::InvalidData,
        io::ErrorKind::InvalidInput,
    ] {
        let scratch = Scratch::new("failing-transport");
        let body = FailingBody {
            prefix: io::Cursor::new(wire[..wire.len() / 2].to_vec()),
            kind,
        };
        let req = request(scratch.path().join("coforge-computer"), sha256(&wire));

        let error = install(body, true, &req).unwrap_err();

        assert_eq!(
            error.code,
            FetchErrorCode::Download,
            "{kind:?}: {}",
            error.message
        );
        assert!(
            scratch.entries().is_empty(),
            "{kind:?}: {:?}",
            scratch.entries()
        );
    }
}

#[test]
fn bytes_after_the_gzip_stream_that_are_not_a_gzip_member_are_refused_even_when_the_checksum_covers_them()
 {
    // Whatever trails the stream, from one stray byte to a run of padding: the Computer's
    // decompression refuses all of it, so the checksum over the whole object cannot excuse it.
    let trailers: [(&str, &[u8]); 4] = [
        ("text", b"trailing garbage"),
        ("one byte", b"x"),
        ("a torn header", &[0x1f, 0x8b, 0x08]),
        ("padding", &[0u8; 20]),
    ];
    for (name, trailer) in trailers {
        let scratch = Scratch::new("trailing-bytes");
        let mut wire = gzip(b"payload");
        wire.extend_from_slice(trailer);
        let req = request(scratch.path().join("coforge-computer"), sha256(&wire));

        let error = install(wire.as_slice(), true, &req).unwrap_err();

        assert_eq!(
            error.code,
            FetchErrorCode::GzipInvalid,
            "{name}: {}",
            error.message
        );
        assert!(
            scratch.entries().is_empty(),
            "{name}: {:?}",
            scratch.entries()
        );
    }
}

#[test]
fn concatenated_gzip_members_are_expanded_one_after_the_other() {
    // Bun's `DecompressionStream`, which the Computer's updater uses, accepts them.
    let scratch = Scratch::new("second-member");
    let mut wire = gzip(b"first, ");
    wire.extend_from_slice(&gzip(b"second"));
    let out = scratch.path().join("coforge-computer");
    let mut req = request(out.clone(), sha256(&wire));
    req.expanded_sha256 = Some(sha256(b"first, second"));

    let receipt = install(wire.as_slice(), true, &req).unwrap();

    assert_eq!(fs::read(out).unwrap(), b"first, second");
    assert_eq!(receipt.wire_bytes, wire.len() as u64);
    assert_eq!(receipt.wire_sha256, sha256(&wire));
}

#[test]
fn the_expansion_cap_counts_every_member() {
    let scratch = Scratch::new("members-cap");
    let mut wire = gzip(&[b'a'; 600]);
    wire.extend_from_slice(&gzip(&[b'b'; 600]));
    let mut req = request(scratch.path().join("coforge-computer"), sha256(&wire));
    req.max_written_bytes = 1000;

    let error = install(wire.as_slice(), true, &req).unwrap_err();

    assert_eq!(error.code, FetchErrorCode::SizeLimit, "{}", error.message);
}

#[test]
fn a_body_cut_short_without_a_length_is_a_gzip_error_and_with_a_length_a_download_error() {
    let wire = gzip(&b"payload".repeat(1000));
    let cut = wire[..wire.len() / 2].to_vec();
    let cases = [
        // Nothing says the body is incomplete: the gzip stream is what is wrong.
        (
            "no length",
            test_support::Response::ok(cut.clone()).without_content_length(),
            FetchErrorCode::GzipInvalid,
        ),
        // The server promised more bytes than it sent: the connection failed.
        (
            "short length",
            test_support::Response::ok(cut.clone()).declaring(wire.len()),
            FetchErrorCode::Download,
        ),
    ];
    for (name, response, expected) in cases {
        let scratch = Scratch::new("cut-short");
        let server = serve(&[("/coforge-computer.gz", response)]);
        let mut req = request(scratch.path().join("coforge-computer"), sha256(&wire));
        req.url = format!("{}/coforge-computer.gz", server.base_url());

        let error = fetch(&agent(false), &req).unwrap_err();

        assert_eq!(error.code, expected, "{name}: {}", error.message);
        assert!(
            scratch.entries().is_empty(),
            "{name}: {:?}",
            scratch.entries()
        );
    }
}

// ---- a body that stops arriving ----------------------------------------------------------

/// Runs `work` on its own thread and fails the test, instead of hanging it, when it has not
/// finished within `limit`.
fn within<T: Send + 'static>(limit: Duration, work: impl FnOnce() -> T + Send + 'static) -> T {
    let (sender, receiver) = std::sync::mpsc::channel();
    thread::spawn(move || {
        let _ = sender.send(work());
    });
    receiver
        .recv_timeout(limit)
        .unwrap_or_else(|_| panic!("did not finish within {limit:?}"))
}

/// How long the stall test lets a transfer sit silent. It only has to be longer than a hiccup.
const STALL: Duration = Duration::from_millis(400);

#[test]
fn a_body_that_stalls_partway_is_abandoned_after_the_idle_timeout() {
    let wire = gzip(&b"payload".repeat(1000));
    let stalled = |body: Vec<u8>| {
        // The header promises the whole object; the server sends a piece and goes silent.
        test_support::Response::ok(body[..10].to_vec())
            .declaring(body.len())
            .then_stalling()
    };
    let server = serve(&[
        ("/latest", stalled(b"0.2.0-and-more".to_vec())),
        ("/coforge-computer.gz", stalled(wire.clone())),
        ("/photon_rs_bg.wasm", stalled(vec![1u8; 4096])),
    ]);
    let base = server.base_url();
    // Owned by the test, not by the thread that may have to be abandoned: it is removed however
    // the test ends.
    let scratch = Scratch::new("stalled");
    let directory = scratch.path().to_owned();
    let started = Instant::now();

    let outcomes = within(Duration::from_secs(20), move || {
        let agent = agent_with_idle_timeout(false, STALL);
        let bytes = fetch_bytes(&agent, &format!("{base}/latest"), 4096).map(drop);
        let mut gz = request(directory.join("coforge-computer"), sha256(&wire));
        gz.url = format!("{base}/coforge-computer.gz");
        let mut raw = request(directory.join("photon_rs_bg.wasm"), "0".repeat(64));
        raw.url = format!("{base}/photon_rs_bg.wasm");
        (
            bytes,
            fetch(&agent, &gz).map(drop),
            fetch(&agent, &raw).map(drop),
        )
    });

    // Each case reached the server and stalled while receiving the body. Were the server to
    // answer one connection at a time, the later cases would wait for headers instead and
    // "time out" without ever testing the body.
    assert_eq!(
        server.requests(),
        ["/latest", "/coforge-computer.gz", "/photon_rs_bg.wasm"]
    );
    for (name, outcome) in [
        ("small object", outcomes.0),
        ("gzip", outcomes.1),
        ("plain", outcomes.2),
    ] {
        let error = outcome.unwrap_err();
        assert_eq!(
            error.code,
            FetchErrorCode::Download,
            "{name}: {}",
            error.message
        );
        assert!(
            error.message.contains("timeout: receive body"),
            "{name}: {}",
            error.message
        );
    }
    assert!(
        scratch.entries().is_empty(),
        "left behind: {:?}",
        scratch.entries()
    );
    assert!(
        started.elapsed() < Duration::from_secs(15),
        "three stalls at {STALL:?} took {:?}",
        started.elapsed()
    );
}

#[test]
fn a_slow_body_that_keeps_arriving_is_not_cut_off() {
    // A body that takes longer than the idle limit to arrive, in pieces 20 ms apart against a
    // 1 s limit. The bound is on idleness, not on the whole download, and the 50:1 ratio leaves
    // room for a loaded runner to be late by a long way.
    const LIMIT: Duration = Duration::from_secs(1);
    const PIECES: usize = 60;
    // Bytes that do not compress, so the wire really is as long as the payload.
    let mut state = 0x2545_f491_4f6c_dd1du64;
    let payload: Vec<u8> = (0..PIECES * 16)
        .map(|_| {
            state = state
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (state >> 56) as u8
        })
        .collect();
    let wire = gzip(&payload);
    let piece = wire.len().div_ceil(PIECES);
    let server = serve(&[(
        "/coforge-computer.gz",
        test_support::Response::ok(wire.clone()).dripping(piece, Duration::from_millis(20)),
    )]);
    let scratch = Scratch::new("slow-body");
    let out = scratch.path().join("coforge-computer");
    let mut req = request(out.clone(), sha256(&wire));
    req.url = format!("{}/coforge-computer.gz", server.base_url());

    let started = Instant::now();
    fetch(&agent_with_idle_timeout(false, LIMIT), &req).unwrap();

    assert!(
        started.elapsed() > LIMIT,
        "the body was not slow enough to prove anything: {:?}",
        started.elapsed()
    );
    assert_eq!(fs::read(out).unwrap(), payload);
}
