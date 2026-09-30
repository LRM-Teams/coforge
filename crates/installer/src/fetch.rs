//! Downloads one release object, verifies it, and places it atomically.
//!
//! The wire bytes are hashed as they arrive and checked against the manifest's checksum for
//! the object that was actually transferred (for a `.gz` object, the manifest's `gzip.checksum`).
//! A `.gz` object is expanded on the fly into a temporary file next to the destination; the
//! expansion is bounded by a byte cap (the manifest's uncompressed `size`), so a gzip bomb
//! fails instead of filling the disk. Nothing is renamed into place until every check passes,
//! and a failure removes the temporary file and leaves any existing destination untouched.
//! A small metadata object (a pointer, a manifest) is read into memory under a byte cap instead.
//! No request follows a redirect: the release feed is expected to answer with the object itself.

use std::io::{self, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use flate2::bufread::MultiGzDecoder;
use serde::Serialize;
use sha2::{Digest, Sha256};

use ureq::unversioned::resolver::DefaultResolver;

use crate::digest::hex;
use crate::idle_timeout;
use crate::private_fs::{self, FileMode, PendingFile};

/// How long a transfer may receive nothing before it fails. It is not a limit on the whole
/// download: a slow link that keeps delivering is never cut off.
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(60);

/// The default cap for both the downloaded and the written byte count.
pub const DEFAULT_MAX_BYTES: u64 = 256 * 1024 * 1024;

pub struct FetchRequest {
    pub url: String,
    /// Lowercase hex SHA-256 of the bytes on the wire.
    pub sha256: String,
    /// Lowercase hex SHA-256 of the written (expanded) file, when the caller knows it.
    pub expanded_sha256: Option<String>,
    pub out: PathBuf,
    /// Most bytes accepted from the network. Beyond it the download fails.
    pub max_wire_bytes: u64,
    /// Most bytes written to `out`: the bound that stops a gzip bomb.
    pub max_written_bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchReceipt {
    pub out: String,
    pub gzip: bool,
    pub wire_bytes: u64,
    pub wire_sha256: String,
    pub written_bytes: u64,
    pub written_sha256: String,
    pub elapsed_ms: u128,
}

#[derive(Debug, PartialEq, Eq)]
pub enum FetchErrorCode {
    Download,
    HttpStatus,
    SizeLimit,
    ChecksumMismatch,
    GzipInvalid,
    Write,
}

impl FetchErrorCode {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Download => "DOWNLOAD_FAILED",
            Self::HttpStatus => "HTTP_STATUS",
            Self::SizeLimit => "SIZE_LIMIT",
            Self::ChecksumMismatch => "CHECKSUM_MISMATCH",
            Self::GzipInvalid => "GZIP_INVALID",
            Self::Write => "WRITE_FAILED",
        }
    }
}

#[derive(Debug)]
pub struct FetchError {
    pub code: FetchErrorCode,
    pub message: String,
}

impl FetchError {
    fn new(code: FetchErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

/// The production agent: HTTPS only, rustls with the webpki (Mozilla) roots, no transparent
/// content decoding, no redirects, and a non-2xx status reported as an error.
pub fn https_agent() -> ureq::Agent {
    agent(true)
}

pub(crate) fn agent(https_only: bool) -> ureq::Agent {
    agent_with_idle_timeout(https_only, IDLE_TIMEOUT)
}

/// An agent whose transfers fail once they have received nothing for `idle`.
pub(crate) fn agent_with_idle_timeout(https_only: bool, idle: Duration) -> ureq::Agent {
    let config = ureq::Agent::config_builder()
        .https_only(https_only)
        // install.sh and install.ps1 refuse every redirect when preparing for the updater, so a
        // 3xx is an error here, not a hop.
        .max_redirects(0)
        .timeout_connect(Some(Duration::from_secs(30)))
        .timeout_recv_response(Some(Duration::from_secs(60)))
        .build();
    ureq::Agent::with_parts(
        config,
        idle_timeout::connector(idle),
        DefaultResolver::default(),
    )
}

pub fn fetch(agent: &ureq::Agent, request: &FetchRequest) -> Result<FetchReceipt, FetchError> {
    let started = Instant::now();
    let body = get(agent, &request.url)?;
    let gzip = url_names_gzip(&request.url);
    let mut receipt = install(body.into_reader(), gzip, request)?;
    receipt.elapsed_ms = started.elapsed().as_millis();
    Ok(receipt)
}

/// Reads a small object (a pointer or a manifest) into memory, failing with `SizeLimit` as soon
/// as it is more than `max_bytes` long. Exactly `max_bytes` is accepted.
pub fn fetch_bytes(agent: &ureq::Agent, url: &str, max_bytes: u64) -> Result<Vec<u8>, FetchError> {
    let mut bytes = Vec::new();
    get(agent, url)?
        .into_reader()
        .take(max_bytes.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|error| FetchError::new(FetchErrorCode::Download, format!("{url}: {error}")))?;
    if bytes.len() as u64 > max_bytes {
        return Err(FetchError::new(
            FetchErrorCode::SizeLimit,
            format!("{url} is more than {max_bytes} bytes"),
        ));
    }
    Ok(bytes)
}

/// Starts a GET. Only a 2xx answer is a success: with redirects disabled a 3xx comes back as an
/// ordinary response, and it is refused here like any other status.
fn get(agent: &ureq::Agent, url: &str) -> Result<ureq::Body, FetchError> {
    let response = agent.get(url).call().map_err(|error| match error {
        ureq::Error::StatusCode(status) => FetchError::new(
            FetchErrorCode::HttpStatus,
            format!("{url} answered HTTP {status}"),
        ),
        other => FetchError::new(FetchErrorCode::Download, format!("{url}: {other}")),
    })?;
    if !response.status().is_success() {
        return Err(FetchError::new(
            FetchErrorCode::HttpStatus,
            format!("{url} answered HTTP {}", response.status().as_u16()),
        ));
    }
    Ok(response.into_body())
}

/// Whether the URL path (ignoring any query or fragment) names a `.gz` object.
pub fn url_names_gzip(url: &str) -> bool {
    let path = url.split(['?', '#']).next().unwrap_or(url);
    path.ends_with(".gz")
}

/// Streams `wire` to a temporary file beside `request.out`, verifies it, then renames it into
/// place. Transport-independent so the checks are testable without a network.
pub fn install(
    wire: impl Read,
    gzip: bool,
    request: &FetchRequest,
) -> Result<FetchReceipt, FetchError> {
    let mut wire = Measured::new(wire, request.max_wire_bytes, "download");
    let temp = create_partial_file(&request.out)?;

    let written = {
        let mut sink = Measured::new(temp.file(), request.max_written_bytes, "expanded file");
        let copied = if gzip {
            expand_gzip(&mut wire, &mut sink)
        } else {
            copy(&mut wire, &mut sink).map(drop)
        };
        copied.map_err(|failure| failure.into_error(gzip, wire.failed))?;
        sink.finish()
    };
    let wire = wire.finish();

    if wire.sha256 != request.sha256 {
        return Err(FetchError::new(
            FetchErrorCode::ChecksumMismatch,
            format!(
                "downloaded bytes hash to {}, expected {}",
                wire.sha256, request.sha256
            ),
        ));
    }
    if let Some(expected) = &request.expanded_sha256
        && &written.sha256 != expected
    {
        return Err(FetchError::new(
            FetchErrorCode::ChecksumMismatch,
            format!(
                "written file hashes to {}, expected {expected}",
                written.sha256
            ),
        ));
    }

    temp.commit(&request.out)
        .map_err(|error| FetchError::new(FetchErrorCode::Write, error.to_string()))?;
    Ok(FetchReceipt {
        out: request.out.display().to_string(),
        gzip,
        wire_bytes: wire.bytes,
        wire_sha256: wire.sha256,
        written_bytes: written.bytes,
        written_sha256: written.sha256,
        elapsed_ms: 0,
    })
}

/// What went wrong while moving bytes from the wire to the file.
enum Failure {
    /// Reading failed: the transport, or (when expanding) the gzip stream itself.
    Read(io::Error),
    Write(io::Error),
}

impl Failure {
    /// `transport_failed`: the wire reader itself returned an error, as opposed to a gzip decoder
    /// rejecting bytes that arrived fine.
    fn into_error(self, gzip: bool, transport_failed: bool) -> FetchError {
        match self {
            Self::Read(error) if is_size_limit(&error) => {
                FetchError::new(FetchErrorCode::SizeLimit, error.to_string())
            }
            // A corrupt or truncated gzip stream arrives as an error of the decoder, whatever
            // its kind. A failing network arrives as an error of the wire, which must never be
            // mistaken for a bad object.
            Self::Read(error) if gzip && !transport_failed => {
                FetchError::new(FetchErrorCode::GzipInvalid, error.to_string())
            }
            Self::Read(error) => FetchError::new(FetchErrorCode::Download, error.to_string()),
            Self::Write(error) if is_size_limit(&error) => {
                FetchError::new(FetchErrorCode::SizeLimit, error.to_string())
            }
            Self::Write(error) => FetchError::new(FetchErrorCode::Write, error.to_string()),
        }
    }
}

/// Expands the gzip members of `wire` into `sink`, one after the other. Anything after the last
/// member that is not itself a member is refused, as the Computer's decompression refuses it, and
/// a decoder that reads to the end also makes the wire checksum cover the whole object.
fn expand_gzip(wire: &mut impl Read, sink: &mut impl Write) -> Result<(), Failure> {
    let mut decoder = MultiGzDecoder::new(BufReader::new(wire));
    copy(&mut decoder, sink).map(drop)
}

fn copy(reader: &mut impl Read, writer: &mut impl Write) -> Result<u64, Failure> {
    let mut buffer = vec![0u8; 64 * 1024];
    let mut total = 0u64;
    loop {
        let read = match reader.read(&mut buffer) {
            Ok(0) => return Ok(total),
            Ok(read) => read,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(Failure::Read(error)),
        };
        writer.write_all(&buffer[..read]).map_err(Failure::Write)?;
        total += read as u64;
    }
}

fn size_limit_error(what: &str, cap: u64) -> io::Error {
    io::Error::other(SizeLimitMessage(format!(
        "{what} exceeds the {cap}-byte cap"
    )))
}

#[derive(Debug)]
struct SizeLimitMessage(String);

impl std::fmt::Display for SizeLimitMessage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for SizeLimitMessage {}

fn is_size_limit(error: &io::Error) -> bool {
    error
        .get_ref()
        .is_some_and(|inner| inner.is::<SizeLimitMessage>())
}

struct Digested {
    bytes: u64,
    sha256: String,
}

/// Counts and hashes every byte that passes through, failing once `cap` is exceeded.
struct Measured<T> {
    inner: T,
    cap: u64,
    what: &'static str,
    bytes: u64,
    hasher: Sha256,
    /// A read of `inner` failed (as opposed to the cap being exceeded).
    failed: bool,
}

impl<T> Measured<T> {
    fn new(inner: T, cap: u64, what: &'static str) -> Self {
        Self {
            inner,
            cap,
            what,
            bytes: 0,
            hasher: Sha256::new(),
            failed: false,
        }
    }

    fn account(&mut self, chunk: &[u8]) -> io::Result<()> {
        self.bytes += chunk.len() as u64;
        if self.bytes > self.cap {
            return Err(size_limit_error(self.what, self.cap));
        }
        self.hasher.update(chunk);
        Ok(())
    }

    fn finish(self) -> Digested {
        Digested {
            bytes: self.bytes,
            sha256: hex(&self.hasher.finalize()),
        }
    }
}

impl<T: Read> Read for Measured<T> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let read = match self.inner.read(buffer) {
            Ok(read) => read,
            Err(error) => {
                // An interrupted read is retried by the caller and is not a failure.
                self.failed |= error.kind() != io::ErrorKind::Interrupted;
                return Err(error);
            }
        };
        self.account(&buffer[..read])?;
        Ok(read)
    }
}

impl<T: Write> Write for Measured<T> {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.account(buffer)?;
        self.inner.write_all(buffer)?;
        Ok(buffer.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

/// A uniquely named file in the destination's directory, owner-only (`0700`, whatever the umask),
/// removed on drop unless committed.
fn create_partial_file(out: &Path) -> Result<PendingFile, FetchError> {
    let path = private_fs::partial_sibling(out).ok_or_else(|| {
        FetchError::new(
            FetchErrorCode::Write,
            format!("{} names no file", out.display()),
        )
    })?;
    PendingFile::create(path.clone(), FileMode::Exact(0o700)).map_err(|error| {
        FetchError::new(
            FetchErrorCode::Write,
            format!("cannot create {}: {error}", path.display()),
        )
    })
}

#[cfg(test)]
mod tests;
