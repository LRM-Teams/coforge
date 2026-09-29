//! Downloads one release object, verifies it, and places it atomically.
//!
//! The wire bytes are hashed as they arrive and checked against the manifest's checksum for
//! the object that was actually transferred (for a `.gz` object, the manifest's `gzip.checksum`).
//! A `.gz` object is expanded on the fly into a temporary file next to the destination; the
//! expansion is bounded by a byte cap (the manifest's uncompressed `size`), so a gzip bomb
//! fails instead of filling the disk. Nothing is renamed into place until every check passes,
//! and a failure removes the temporary file and leaves any existing destination untouched.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use flate2::read::GzDecoder;
use serde::Serialize;
use sha2::{Digest, Sha256};

/// The default cap for both the downloaded and the written byte count.
pub const DEFAULT_MAX_BYTES: u64 = 256 * 1024 * 1024;

pub struct FetchRequest {
    pub url: String,
    /// Lowercase hex SHA-256 of the bytes on the wire.
    pub sha256: String,
    /// Lowercase hex SHA-256 of the written (expanded) file, when the caller knows it.
    pub expanded_sha256: Option<String>,
    pub out: PathBuf,
    pub max_bytes: u64,
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
/// content decoding, and a non-2xx status reported as an error.
pub fn https_agent() -> ureq::Agent {
    agent(true)
}

pub(crate) fn agent(https_only: bool) -> ureq::Agent {
    ureq::Agent::config_builder()
        .https_only(https_only)
        .timeout_connect(Some(Duration::from_secs(30)))
        .timeout_recv_response(Some(Duration::from_secs(60)))
        .build()
        .new_agent()
}

pub fn fetch(agent: &ureq::Agent, request: &FetchRequest) -> Result<FetchReceipt, FetchError> {
    let started = Instant::now();
    let response = agent
        .get(&request.url)
        .call()
        .map_err(|error| match error {
            ureq::Error::StatusCode(status) => FetchError::new(
                FetchErrorCode::HttpStatus,
                format!("{} answered HTTP {status}", request.url),
            ),
            other => FetchError::new(
                FetchErrorCode::Download,
                format!("{}: {other}", request.url),
            ),
        })?;
    let body = response.into_body().into_reader();
    let gzip = url_names_gzip(&request.url);
    let mut receipt = install(body, gzip, request)?;
    receipt.elapsed_ms = started.elapsed().as_millis();
    Ok(receipt)
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
    let mut wire = Measured::new(wire, request.max_bytes, "download");
    let temp = TempFile::create(&request.out)?;

    let written = {
        let mut sink = Measured::new(temp.file(), request.max_bytes, "expanded file");
        let copied = if gzip {
            let mut decoder = GzDecoder::new(&mut wire);
            copy(&mut decoder, &mut sink, true)
        } else {
            copy(&mut wire, &mut sink, false)
        };
        copied?;
        // Drain anything after the gzip member so the wire checksum covers the whole object.
        io::copy(&mut wire, &mut io::sink()).map_err(|error| read_error(error, false))?;
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

    temp.commit(&request.out)?;
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

fn copy(reader: &mut impl Read, writer: &mut impl Write, gzip: bool) -> Result<u64, FetchError> {
    let mut buffer = vec![0u8; 64 * 1024];
    let mut total = 0u64;
    loop {
        let read = match reader.read(&mut buffer) {
            Ok(0) => return Ok(total),
            Ok(read) => read,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(read_error(error, gzip)),
        };
        writer.write_all(&buffer[..read]).map_err(|error| {
            if is_size_limit(&error) {
                FetchError::new(FetchErrorCode::SizeLimit, error.to_string())
            } else {
                FetchError::new(FetchErrorCode::Write, error.to_string())
            }
        })?;
        total += read as u64;
    }
}

fn read_error(error: io::Error, gzip: bool) -> FetchError {
    if is_size_limit(&error) {
        FetchError::new(FetchErrorCode::SizeLimit, error.to_string())
    } else if gzip
        && matches!(
            error.kind(),
            io::ErrorKind::InvalidInput | io::ErrorKind::InvalidData
        )
    {
        // flate2 reports a corrupt stream as InvalidInput or InvalidData; transport failures
        // surface with other kinds.
        FetchError::new(FetchErrorCode::GzipInvalid, error.to_string())
    } else {
        FetchError::new(FetchErrorCode::Download, error.to_string())
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
}

impl<T> Measured<T> {
    fn new(inner: T, cap: u64, what: &'static str) -> Self {
        Self {
            inner,
            cap,
            what,
            bytes: 0,
            hasher: Sha256::new(),
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
        let read = self.inner.read(buffer)?;
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

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(DIGITS[(byte >> 4) as usize] as char);
        out.push(DIGITS[(byte & 0x0f) as usize] as char);
    }
    out
}

/// A uniquely named file in the destination's directory, removed on drop unless committed.
struct TempFile {
    path: PathBuf,
    /// Closed before the rename or removal: Windows refuses both on an open handle.
    file: Option<File>,
}

impl TempFile {
    fn create(out: &Path) -> Result<Self, FetchError> {
        let directory = match out.parent() {
            Some(parent) if !parent.as_os_str().is_empty() => parent.to_path_buf(),
            _ => PathBuf::from("."),
        };
        let name = out
            .file_name()
            .ok_or_else(|| {
                FetchError::new(
                    FetchErrorCode::Write,
                    format!("{} names no file", out.display()),
                )
            })?
            .to_string_lossy()
            .into_owned();
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or_default();
        let path = directory.join(format!(".{name}.{}.{nonce}.partial", std::process::id()));

        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o700);
        }
        let file = options.open(&path).map_err(|error| {
            FetchError::new(
                FetchErrorCode::Write,
                format!("cannot create {}: {error}", path.display()),
            )
        })?;
        Ok(Self {
            path,
            file: Some(file),
        })
    }

    fn file(&self) -> &File {
        self.file
            .as_ref()
            .expect("the temporary file is open until commit or drop")
    }

    fn commit(mut self, out: &Path) -> Result<(), FetchError> {
        let write_error =
            |error: io::Error| FetchError::new(FetchErrorCode::Write, error.to_string());
        let file = self.file.take().expect("commit runs once");
        #[cfg(unix)]
        {
            // The creation mode is filtered by the umask; set the final mode explicitly.
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(fs::Permissions::from_mode(0o700))
                .map_err(write_error)?;
        }
        file.sync_all().map_err(write_error)?;
        drop(file);
        fs::rename(&self.path, out).map_err(write_error)?;
        self.path = PathBuf::new();
        #[cfg(unix)]
        if let Some(parent) = out.parent().filter(|parent| !parent.as_os_str().is_empty()) {
            // Persist the rename itself. Best effort: some filesystems refuse to fsync a directory.
            let _ = File::open(parent).and_then(|directory| directory.sync_all());
        }
        Ok(())
    }
}

impl Drop for TempFile {
    fn drop(&mut self) {
        drop(self.file.take());
        if !self.path.as_os_str().is_empty() {
            let _ = fs::remove_file(&self.path);
        }
    }
}

#[cfg(test)]
mod tests;
