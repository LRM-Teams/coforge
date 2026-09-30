//! What a valid release manifest is: `<version>/manifest.json` of the release feed.
//!
//! This is the Computer's `#assertManifest` with `validPlatformEntry`, `validArtifact`, and
//! `validPhotonWasmEntry` (packages/computer/src/updater.ts). The manifest is checked as raw JSON
//! first because the contract types ignore unknown fields, while a platform entry holding
//! anything beside `computer` must be refused. The artifact names are pinned to the feed's fixed
//! layout rather than accepted as "some safe file name": a manifest that named another file
//! could otherwise pick an unexpected object while keeping a self-consistent checksum.

use serde_json::Value;

use crate::contract::{
    ArtifactIdentity, ComputerArtifact, RELEASE_MANIFEST_SCHEMA_VERSION, ReleaseManifest,
};
use crate::digest::is_valid_identity;
use crate::update_error::UpdateError;

const COMPUTER_BINARY: &str = "coforge-computer";
const COMPUTER_GZIP: &str = "coforge-computer.gz";
const PHOTON_WASM: &str = "photon_rs_bg.wasm";

/// Parses and validates a manifest fetched from `<expected_version>/manifest.json`.
pub fn parse_release_manifest(
    bytes: &[u8],
    expected_version: &str,
) -> Result<ReleaseManifest, UpdateError> {
    let value: Value = serde_json::from_slice(bytes)
        .map_err(|_| UpdateError::FeedInvalid("manifest is not valid JSON".into()))?;
    let schema_invalid = || UpdateError::FeedInvalid("manifest schema is invalid".into());

    let is_text = |key: &str| value.get(key).is_some_and(Value::is_string);
    let platforms = value.get("platforms").and_then(Value::as_object);
    if value.get("schema_version").and_then(Value::as_u64)
        != Some(u64::from(RELEASE_MANIFEST_SCHEMA_VERSION))
        || !is_text("version")
        || !is_text("commit")
        || !is_text("buildDate")
        || platforms.is_none()
        // A manifest without the image library fails closed: every installed version must ship it.
        || !valid_photon_wasm(value.get("photonWasm"))
    {
        return Err(schema_invalid());
    }
    // The manifest is fetched from `<version>/manifest.json`, so its own `version` is redundant
    // unless it is also checked: an object served under the wrong version path would otherwise
    // pass every other check here.
    let version = value["version"].as_str().unwrap_or_default();
    if version != expected_version {
        return Err(UpdateError::FeedInvalid(format!(
            "manifest version {version} does not match requested version {expected_version}"
        )));
    }
    for (name, entry) in platforms.into_iter().flatten() {
        if !valid_platform_entry(entry) {
            return Err(UpdateError::FeedInvalid(format!(
                "manifest platform entry for {name} is invalid"
            )));
        }
    }
    serde_json::from_value(value).map_err(|_| schema_invalid())
}

/// The computer artifact published for `target`.
pub fn computer_artifact<'a>(
    manifest: &'a ReleaseManifest,
    target: &str,
) -> Result<&'a ComputerArtifact, UpdateError> {
    manifest
        .platforms
        .get(target)
        .map(|platform| &platform.computer)
        .ok_or_else(|| {
            UpdateError::UnsupportedTarget(format!("manifest has no platform entry for {target}"))
        })
}

/// A platform entry holds exactly the computer artifact: no daemon payload exists.
fn valid_platform_entry(value: &Value) -> bool {
    value
        .as_object()
        .is_some_and(|entry| entry.len() == 1 && valid_computer(entry.get("computer")))
}

fn valid_computer(value: Option<&Value>) -> bool {
    let Some(value) = value else { return false };
    identity(value).is_some()
        && value.get("binary").and_then(Value::as_str) == Some(COMPUTER_BINARY)
        && value.get("gzip").is_some_and(|gzip| {
            identity(gzip).is_some()
                && gzip.get("binary").and_then(Value::as_str) == Some(COMPUTER_GZIP)
        })
}

fn valid_photon_wasm(value: Option<&Value>) -> bool {
    value.is_some_and(|value| {
        value.get("file").and_then(Value::as_str) == Some(PHOTON_WASM) && identity(value).is_some()
    })
}

/// The `size` and `checksum` of an object, if it has a valid pair.
fn identity(value: &Value) -> Option<ArtifactIdentity> {
    let identity = ArtifactIdentity {
        size: value.get("size")?.as_u64()?,
        checksum: value.get("checksum")?.as_str()?.to_owned(),
    };
    is_valid_identity(&identity).then_some(identity)
}

#[cfg(test)]
mod tests;
