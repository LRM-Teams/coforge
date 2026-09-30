//! The active version: which installed version is selected, and how it is exposed.
//!
//! `<install root>/active.json` names the current and the previous version. Two links follow it:
//! `<install root>/active` points at `versions/<current>`, and the `coforge-computer` shim on the
//! user's PATH points through `active`, so switching versions never rewrites the shim. This is
//! the Computer's `#activate` / `#readJson("active.json")` / `#writeJsonAtomic`
//! (packages/computer/src/updater.ts) and writes the same bytes and links.
//!
//! Activation trusts its caller: the version's installed bytes must already have been verified
//! (another module's job), and its directory must exist.

use std::ffi::OsString;
use std::fmt;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Deserialize;

use crate::contract::{
    ACTIVE_STATE_SCHEMA_VERSION, ActiveState, to_file_json, windows_computer_launcher,
};
use crate::version::is_valid_release_version;

/// The state file, relative to the install root.
pub const ACTIVE_FILE: &str = "active.json";

/// The link, relative to the install root, that points at `versions/<current>`.
const ACTIVE_LINK: &str = "active";

/// The executable name inside a version directory and the PATH shim's name on POSIX.
#[cfg(unix)]
const COMPUTER_EXECUTABLE: &str = "coforge-computer";

/// The PATH shim's file name on Windows, where a symlink needs privileges the user may lack.
const WINDOWS_SHIM_FILE: &str = "coforge-computer.cmd";

/// The error code for an `active.json` (or a state to write) that names no valid version.
pub const INVALID_ACTIVE_ERROR_CODE: &str = "UPDATE_FEED_INVALID";

#[derive(Debug)]
pub enum ActiveError {
    /// `active.json` is not JSON, not the `active.json` schema, or names a version that is not a
    /// safe release version (which would otherwise become part of a path).
    Invalid,
    /// A file or link could not be read or replaced.
    Io(io::Error),
}

impl ActiveError {
    /// The Computer's `UpdateError` code, the only kind a receipt carries. A file-system failure
    /// has none, as in the Computer.
    pub fn code(&self) -> Option<&'static str> {
        match self {
            Self::Invalid => Some(INVALID_ACTIVE_ERROR_CODE),
            Self::Io(_) => None,
        }
    }
}

impl fmt::Display for ActiveError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Invalid => formatter.write_str("active version is invalid"),
            Self::Io(error) => write!(
                formatter,
                "the active version could not be read or switched: {error}"
            ),
        }
    }
}

impl From<io::Error> for ActiveError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

/// `active.json` as read: `previous` is whatever JSON was written there.
#[derive(Deserialize)]
struct StoredActiveState {
    schema_version: u32,
    current: String,
    #[serde(default)]
    previous: serde_json::Value,
}

/// The state in `<install_root>/active.json`: `None` before the first install. A file that is
/// not the schema, or whose `current` is not a valid version, is `ActiveError::Invalid`; one that
/// cannot be read is `Io`. A `previous` that is not a valid version string reads as `None`, as
/// the Computer's rollback treats an invalid one ("nothing to roll back to"); it must not stop a
/// forward upgrade either. Its writer only ever stores a version string or `null`.
pub fn read_active(install_root: &Path) -> Result<Option<ActiveState>, ActiveError> {
    let bytes = match fs::read(install_root.join(ACTIVE_FILE)) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let stored: StoredActiveState =
        serde_json::from_slice(&bytes).map_err(|_| ActiveError::Invalid)?;
    if stored.schema_version != ACTIVE_STATE_SCHEMA_VERSION
        || !is_valid_release_version(&stored.current)
    {
        return Err(ActiveError::Invalid);
    }
    let previous = match stored.previous {
        serde_json::Value::String(previous) if is_valid_release_version(&previous) => {
            Some(previous)
        }
        _ => None,
    };
    Ok(Some(ActiveState {
        schema_version: stored.schema_version,
        current: stored.current,
        previous,
    }))
}

/// Replaces `<install_root>/active.json` atomically (a temporary file beside it, renamed over
/// it), creating the install root owner-only when missing. A state that names an invalid
/// `current` or `previous` is refused here, before anything is written: both become paths.
pub fn write_active_state(install_root: &Path, state: &ActiveState) -> Result<(), ActiveError> {
    validate(state)?;
    create_directory(install_root, 0o700)?;
    write_file_atomically(
        &install_root.join(ACTIVE_FILE),
        to_file_json(state).as_bytes(),
        0o600,
    )?;
    Ok(())
}

/// Makes `state.current` the active version: writes `active.json`, then points `active` and the
/// PATH shim at it, in that order, as the Computer does. The shim directory is created 0755 when
/// missing. `target` is the release target (`windows-x64`, `linux-arm64`, ...); a `windows-*`
/// target gets a junction and a `.cmd` shim, any other a symlink and a symlink shim.
///
/// If a link cannot be switched, `active.json` already names the new version, as it does after a
/// crash between the steps; running `activate` again finishes the switch.
///
/// The POSIX links are each replaced by a rename, so a reader never sees one missing. Windows
/// cannot rename over a junction: there `active` is briefly absent between removing the old
/// junction and renaming the new one into place.
pub fn activate(
    install_root: &Path,
    binary_directory: &Path,
    target: &str,
    state: &ActiveState,
) -> Result<(), ActiveError> {
    write_active_state(install_root, state)?;
    // 0755, not the owner-only mode used below `~/.coforge`: the shim directory is a shared
    // conventional location (`~/.local/bin`) that other tools install into, and a recursive
    // create would otherwise leave `~/.local` itself owner-only for every one of them.
    create_directory(binary_directory, 0o755)?;
    if target.starts_with("windows-") {
        write_windows_launcher(install_root, binary_directory)?;
        switch_junction(install_root, &state.current)?;
    } else {
        switch_posix_links(install_root, binary_directory, &state.current)?;
    }
    Ok(())
}

fn validate(state: &ActiveState) -> Result<(), ActiveError> {
    let valid = state.schema_version == ACTIVE_STATE_SCHEMA_VERSION
        && is_valid_release_version(&state.current)
        && state
            .previous
            .as_deref()
            .is_none_or(is_valid_release_version);
    if valid {
        Ok(())
    } else {
        Err(ActiveError::Invalid)
    }
}

/// `active` -> `versions/<current>` (relative, so the installation can move as a whole), and the
/// shim -> `<install root>/active/coforge-computer` (absolute: it lives in another directory).
#[cfg(unix)]
fn switch_posix_links(
    install_root: &Path,
    binary_directory: &Path,
    current: &str,
) -> io::Result<()> {
    let active = install_root.join(ACTIVE_LINK);
    replace_symlink(&Path::new("versions").join(current), &active)?;
    replace_symlink(
        &active.join(COMPUTER_EXECUTABLE),
        &binary_directory.join(COMPUTER_EXECUTABLE),
    )
}

#[cfg(not(unix))]
fn switch_posix_links(_: &Path, _: &Path, _: &str) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "symlink activation is for POSIX targets",
    ))
}

/// Points `link` at `target` by creating a symlink beside it and renaming it into place, which
/// replaces an existing symlink in one step.
#[cfg(unix)]
fn replace_symlink(target: &Path, link: &Path) -> io::Result<()> {
    let temporary = temporary_sibling(link);
    std::os::unix::fs::symlink(target, &temporary)?;
    fs::rename(&temporary, link).inspect_err(|_| {
        let _ = fs::remove_file(&temporary);
    })
}

/// Windows' PATH shim, `coforge-computer.cmd`: it reads `active.json` on every run, so switching
/// versions never rewrites it, but an installation moved to another root needs it rewritten.
fn write_windows_launcher(install_root: &Path, binary_directory: &Path) -> io::Result<()> {
    let root = install_root.to_str().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "the install root is not valid Unicode, so a .cmd shim cannot name it",
        )
    })?;
    let launcher = windows_computer_launcher(root.trim_end_matches(['\\', '/']));
    write_file_atomically(
        &binary_directory.join(WINDOWS_SHIM_FILE),
        launcher.as_bytes(),
        0o700,
    )
}

/// Makes `active` a junction to `<install root>\versions\<current>`. A junction needs no
/// elevation (a symlink does) and, unlike a symlink, must name an absolute path. The new junction
/// is created under a temporary name first, so a failure to create it leaves the old one alone.
fn switch_junction(install_root: &Path, current: &str) -> io::Result<()> {
    let active = install_root.join(ACTIVE_LINK);
    let temporary = temporary_sibling(&active);
    // The crate creates the directory, then makes it a junction; the second step can fail.
    create_junction(&install_root.join("versions").join(current), &temporary).inspect_err(
        |_| {
            let _ = remove_existing(&temporary);
        },
    )?;
    remove_existing(&active)
        .and_then(|()| fs::rename(&temporary, &active))
        .inspect_err(|_| {
            let _ = remove_existing(&temporary);
        })
}

#[cfg(windows)]
fn create_junction(target: &Path, junction: &Path) -> io::Result<()> {
    ::junction::create(target, junction)
}

#[cfg(not(windows))]
fn create_junction(_: &Path, _: &Path) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "junctions exist only on Windows",
    ))
}

/// Removes whatever is at `path` without following it: a link (symlink or junction) is removed
/// and its target kept; a real directory or file is removed; nothing there is fine.
fn remove_existing(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => fs::remove_dir(path),
        Ok(metadata) if metadata.is_dir() => fs::remove_dir_all(path),
        Ok(_) => fs::remove_file(path),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

/// Creates `path` and any missing parents. `mode` applies to what is created (through the
/// umask) and never to a directory that already exists.
#[cfg(unix)]
fn create_directory(path: &Path, mode: u32) -> io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    fs::DirBuilder::new()
        .recursive(true)
        .mode(mode)
        .create(path)
}

#[cfg(not(unix))]
fn create_directory(path: &Path, _mode: u32) -> io::Result<()> {
    fs::create_dir_all(path)
}

/// Writes `contents` to a new file beside `destination`, then renames it over `destination`.
fn write_file_atomically(destination: &Path, contents: &[u8], mode: u32) -> io::Result<()> {
    let temporary = temporary_sibling(destination);
    let written = create_new_file(&temporary, mode).and_then(|mut file| {
        file.write_all(contents)?;
        // Without this a crash after the rename can leave an empty file under the final name.
        file.sync_all()
    });
    written
        .and_then(|()| fs::rename(&temporary, destination))
        .inspect_err(|_| {
            let _ = fs::remove_file(&temporary);
        })
}

#[cfg(unix)]
fn create_new_file(path: &Path, mode: u32) -> io::Result<fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(mode)
        .open(path)
}

#[cfg(not(unix))]
fn create_new_file(path: &Path, _mode: u32) -> io::Result<fs::File> {
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
}

/// A name for a scratch file or link in `path`'s directory: `<name>.<unique>.tmp`.
fn temporary_sibling(path: &Path) -> PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_nanos());
    let mut name: OsString = path.file_name().unwrap_or_default().to_owned();
    name.push(format!(
        ".{}-{nanos}-{}.tmp",
        process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    path.with_file_name(name)
}

#[cfg(test)]
mod tests;
