//! Makes a release version present in the version store: resolve what to install, download and
//! verify it, stage it, and move it into `versions/`.
//!
//! This is the Computer's `#prepare` without its bookkeeping (packages/computer/src/updater.ts):
//! it neither verifies the version that is running nor touches `active.json`, which belong to
//! the install transaction. The one difference in order is deliberate: a version whose directory
//! already exists is verified and used as it is, before anything is fetched beyond the pointer,
//! because the updater discards what it downloads in that case anyway.

use crate::feed::Feed;
use crate::lock::MachineMutationLock;
use crate::manifest::computer_artifact;
use crate::store::{Installation, Presence, VersionStore};
use crate::update_error::UpdateError;

#[derive(Debug, PartialEq, Eq)]
pub struct Prepared {
    pub version: String,
    pub installation: Installation,
}

/// Resolves `selection` (`latest` or a version) on `feed` and installs it into `store` for the
/// store's release target. `lock` must be the machine mutation lock on the store's install root
/// (anything else is refused before the feed is asked): the witness that no other install,
/// upgrade, or repair is changing it.
pub fn prepare_version(
    lock: &MachineMutationLock,
    feed: &Feed,
    store: &VersionStore,
    selection: &str,
) -> Result<Prepared, UpdateError> {
    store.require_lock(lock)?;
    let version = feed.resolve_version(selection)?;
    if store.presence(&version)? == Presence::Verified {
        return Ok(Prepared {
            version,
            installation: Installation::AlreadyInstalled,
        });
    }
    let manifest = feed.manifest(&version)?;
    let computer = computer_artifact(&manifest, store.target())?;

    let staging = store.begin_staging(lock, &version)?;
    let computer =
        feed.download_computer(&version, store.target(), computer, &staging.computer_path())?;
    let photon_wasm =
        feed.download_photon_wasm(&version, &manifest.photon_wasm, &staging.photon_wasm_path())?;
    let installation = staging.install(computer, photon_wasm)?;
    Ok(Prepared {
        version,
        installation,
    })
}

#[cfg(test)]
mod tests;
