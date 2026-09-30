//! The release feed client: the `latest` pointer, `<version>/manifest.json`, and the objects a
//! manifest names (`<version>/<target>/coforge-computer.gz`, `<version>/photon_rs_bg.wasm`).
//!
//! This is what `scripts/release/install.sh` does for the Computer's updater (`resolveVersion`,
//! then the manifest and artifact phases) together with `#verifyArtifact` and
//! `#verifyPhotonWasm` (packages/computer/src/updater.ts). Nothing follows a redirect, every
//! object has a size ceiling, and a downloaded object must match its manifest entry exactly, in
//! size and checksum. Downloads are written as ordinary files and never touch `versions/`; the
//! caller places them.

use std::fs;
use std::path::Path;

use crate::contract::{ArtifactIdentity, ComputerArtifact, NamedArtifact, ReleaseManifest};
use crate::fetch::{self, FetchError, FetchErrorCode, FetchRequest};
use crate::manifest::parse_release_manifest;
use crate::update_error::UpdateError;
use crate::version::is_valid_release_version;

/// `latest` and every other small text object have a fixed ceiling rather than none.
const MAX_POINTER_BYTES: u64 = 4096;
const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;
/// A fixed ceiling for the compressed executable and for the executable it expands to; the exact
/// sizes come from the manifest.
const MAX_BINARY_BYTES: u64 = 512 * 1024 * 1024;
/// Pi's image library is about 1.8 MB.
const MAX_PHOTON_WASM_BYTES: u64 = 16 * 1024 * 1024;

const COMPUTER_BINARY: &str = "coforge-computer";
const COMPUTER_GZIP: &str = "coforge-computer.gz";
const PHOTON_WASM: &str = "photon_rs_bg.wasm";

pub struct Feed {
    base: String,
    agent: ureq::Agent,
}

impl Feed {
    /// A client for the feed at `base_url` (a trailing `/` is optional), using `agent` for every
    /// request: [`fetch::https_agent`] in production.
    pub fn new(base_url: &str, agent: ureq::Agent) -> Self {
        Self {
            base: base_url.trim_end_matches('/').to_owned(),
            agent,
        }
    }

    /// `latest` (or an empty selection) resolves through the feed's pointer file. Anything else
    /// must already be a valid version string.
    pub fn resolve_version(&self, selection: &str) -> Result<String, UpdateError> {
        if selection != "latest" && !selection.is_empty() {
            return if is_valid_release_version(selection) {
                Ok(selection.to_owned())
            } else {
                Err(UpdateError::FeedInvalid(
                    "version must be latest or a valid version string".into(),
                ))
            };
        }
        let bytes = fetch::fetch_bytes(&self.agent, &self.url("latest"), MAX_POINTER_BYTES)
            .map_err(feed_error)?;
        // Surrounding whitespace is a formatting accident; anything else must be a version.
        let pointer = String::from_utf8(bytes)
            .ok()
            .map(|text| text.trim().to_owned())
            .filter(|text| is_valid_release_version(text))
            .ok_or_else(|| {
                UpdateError::FeedInvalid("latest pointer does not contain a valid version".into())
            })?;
        if pointer == "latest" {
            return Err(UpdateError::FeedInvalid(
                "latest pointer must name a concrete version".into(),
            ));
        }
        Ok(pointer)
    }

    /// `<version>/manifest.json`, validated as the release manifest of exactly that version.
    pub fn manifest(&self, version: &str) -> Result<ReleaseManifest, UpdateError> {
        let url = self.version_url(version, "manifest.json")?;
        let bytes =
            fetch::fetch_bytes(&self.agent, &url, MAX_MANIFEST_BYTES).map_err(feed_error)?;
        parse_release_manifest(&bytes, version)
    }

    /// Downloads `<version>/<target>/coforge-computer.gz`, expands it to `out`, and checks it
    /// against `artifact`: the compressed object's exact size and checksum, the expanded file's
    /// checksum, and an expansion no larger than the recorded size. Nothing is left at `out` on
    /// failure. Returns the identity of the expanded file.
    pub fn download_computer(
        &self,
        version: &str,
        target: &str,
        artifact: &ComputerArtifact,
        out: &Path,
    ) -> Result<ArtifactIdentity, UpdateError> {
        let compressed = &artifact.gzip.identity;
        // install.sh bounds the download and the expansion by the same ceiling, whatever the
        // manifest says; a larger record is refused without asking the feed for anything.
        for (object, size) in [
            (COMPUTER_GZIP, compressed.size),
            (COMPUTER_BINARY, artifact.identity.size),
        ] {
            if size > MAX_BINARY_BYTES {
                return Err(UpdateError::FeedInvalid(format!(
                    "{object} is recorded as {size} bytes, above the {MAX_BINARY_BYTES}-byte limit"
                )));
            }
        }
        let url = self.version_url(version, &format!("{target}/{COMPUTER_GZIP}"))?;
        let request = FetchRequest {
            url,
            sha256: compressed.checksum.clone(),
            expanded_sha256: Some(artifact.identity.checksum.clone()),
            out: out.to_owned(),
            max_wire_bytes: compressed.size,
            max_written_bytes: artifact.identity.size,
        };
        let receipt = fetch::fetch(&self.agent, &request)
            .map_err(|error| transfer_error(error, COMPUTER_GZIP))?;
        let identity = ArtifactIdentity {
            size: receipt.written_bytes,
            checksum: receipt.written_sha256,
        };
        if receipt.wire_bytes != compressed.size || identity.size != artifact.identity.size {
            let _ = fs::remove_file(out);
            return Err(UpdateError::IntegrityFailed(format!(
                "{COMPUTER_GZIP} is {} bytes and expands to {}, not the recorded {} and {}",
                receipt.wire_bytes, identity.size, compressed.size, artifact.identity.size
            )));
        }
        Ok(identity)
    }

    /// Downloads `<version>/photon_rs_bg.wasm` to `out` and checks its exact size and checksum.
    pub fn download_photon_wasm(
        &self,
        version: &str,
        artifact: &NamedArtifact,
        out: &Path,
    ) -> Result<ArtifactIdentity, UpdateError> {
        let recorded = &artifact.identity;
        if recorded.size > MAX_PHOTON_WASM_BYTES {
            return Err(UpdateError::FeedInvalid(format!(
                "{PHOTON_WASM} is recorded as {} bytes, above the {MAX_PHOTON_WASM_BYTES}-byte limit",
                recorded.size
            )));
        }
        let request = FetchRequest {
            url: self.version_url(version, PHOTON_WASM)?,
            sha256: recorded.checksum.clone(),
            expanded_sha256: None,
            out: out.to_owned(),
            max_wire_bytes: recorded.size,
            max_written_bytes: recorded.size,
        };
        let receipt = fetch::fetch(&self.agent, &request)
            .map_err(|error| transfer_error(error, PHOTON_WASM))?;
        if receipt.written_bytes != recorded.size {
            let _ = fs::remove_file(out);
            return Err(UpdateError::IntegrityFailed(format!(
                "{PHOTON_WASM} is {} bytes, not the recorded {}",
                receipt.written_bytes, recorded.size
            )));
        }
        Ok(recorded.clone())
    }

    fn url(&self, path: &str) -> String {
        format!("{}/{path}", self.base)
    }

    /// `<base>/<version>/<path>`, for a version that is one safe URL segment.
    fn version_url(&self, version: &str, path: &str) -> Result<String, UpdateError> {
        if !is_valid_release_version(version) {
            return Err(UpdateError::FeedInvalid(format!(
                "version is invalid: {version:?}"
            )));
        }
        Ok(self.url(&format!("{version}/{path}")))
    }
}

/// A metadata object that could not be fetched is a feed problem, whatever went wrong.
fn feed_error(error: FetchError) -> UpdateError {
    UpdateError::FeedInvalid(error.message)
}

/// The updater reports a failed transfer as a feed problem and a bad object as an integrity
/// failure.
fn transfer_error(error: FetchError, object: &str) -> UpdateError {
    match error.code {
        FetchErrorCode::Download | FetchErrorCode::HttpStatus => {
            UpdateError::FeedInvalid(error.message)
        }
        FetchErrorCode::SizeLimit => UpdateError::IntegrityFailed(format!(
            "{object} is larger than its recorded size ({})",
            error.message
        )),
        FetchErrorCode::ChecksumMismatch => UpdateError::IntegrityFailed(format!(
            "downloaded artifact failed integrity: {object} ({})",
            error.message
        )),
        FetchErrorCode::GzipInvalid => UpdateError::IntegrityFailed(format!(
            "compressed artifact is invalid: {object} ({})",
            error.message
        )),
        FetchErrorCode::Write => UpdateError::Local(error.message),
    }
}

#[cfg(test)]
mod tests;
