//! The version store: the immutable `versions/<v>` directories under the install root.
//!
//! A version is installed by staging it in `.staging/<v>-<unique>` (the payload is downloaded
//! straight into that directory, then the launchers, the `version` marker, and
//! `installation.json` are written beside it) and renaming the whole directory to
//! `versions/<v>`, so a version directory is either absent or complete. It is never rewritten:
//! installing a version that is already there verifies it and stops. `verify_installed` is the
//! offline check every later step (activation, rollback) relies on.
//!
//! Everything that changes the install root takes the [`MachineMutationLock`] as a witness: it
//! cannot be called without the lock, which is also what makes it safe for
//! [`VersionStore::begin_staging`] to delete what an earlier, killed run left in `.staging/`.
//!
//! This is the Computer's `#installVersion` and `#assertInstalled`
//! (packages/computer/src/updater.ts), file for file. A target starting with `windows-` names the
//! executable `coforge-computer.exe` and the launchers `coforge.cmd` and `gh.cmd`.

use std::fmt::Display;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;

use crate::contract::{
    ArtifactIdentity, INSTALLED_IDENTITY_SCHEMA_VERSION, InstalledIdentity, agent_cli_launcher,
    github_cli_launcher, to_file_json,
};
use crate::digest::{is_valid_identity, measure_bytes, measure_file};
use crate::lock::MachineMutationLock;
use crate::update_error::UpdateError;
use crate::version::is_valid_release_version;

const PHOTON_WASM: &str = "photon_rs_bg.wasm";

/// What is under `versions/<v>`.
#[derive(Debug, PartialEq, Eq)]
pub enum Presence {
    Absent,
    /// The directory is there and passes the offline check.
    Verified,
}

/// What [`Staging::install`] did.
#[derive(Debug, PartialEq, Eq)]
pub enum Installation {
    Installed,
    /// The version directory already existed and verified; the staged copy was discarded.
    AlreadyInstalled,
}

/// The versions installed under one install root, for one release target.
#[derive(Debug, Clone)]
pub struct VersionStore {
    install_root: PathBuf,
    target: String,
    windows: bool,
}

impl VersionStore {
    pub fn new(install_root: impl Into<PathBuf>, target: &str) -> Self {
        Self {
            install_root: install_root.into(),
            target: target.to_owned(),
            windows: target.starts_with("windows-"),
        }
    }

    /// The release target (`linux-x64`, `windows-arm64`, ...) whose files this store holds.
    pub fn target(&self) -> &str {
        &self.target
    }

    pub fn version_directory(&self, version: &str) -> PathBuf {
        self.install_root.join("versions").join(version)
    }

    /// Whether `versions/<v>` exists. A directory that exists is verified, and one that fails
    /// verification is an error: an immutable version directory is never repaired in place.
    pub fn presence(&self, version: &str) -> Result<Presence, UpdateError> {
        assert_version(version)?;
        match fs::metadata(self.version_directory(version)) {
            Ok(_) => self.verify_installed(version).map(|()| Presence::Verified),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Presence::Absent),
            Err(_) => Err(UpdateError::IntegrityFailed(
                "an immutable version directory already exists but is incomplete".into(),
            )),
        }
    }

    /// Refuses a lock that does not cover this store's install root. Everything that changes the
    /// root takes the lock as a witness that nothing else is changing it, and a lock on some other
    /// root proves nothing about this one. It is a mistake in the caller, not a failure of the
    /// feed or of the files, and no SDK error code describes it, so it carries none.
    pub fn require_lock(&self, lock: &MachineMutationLock) -> Result<(), UpdateError> {
        if lock.covers(&self.install_root) {
            Ok(())
        } else {
            Err(UpdateError::Local(format!(
                "the machine mutation lock covers {}, not the install root {}",
                lock.install_root().display(),
                self.install_root.display()
            )))
        }
    }

    /// Starts staging `version`: a fresh, owner-only directory under `.staging/`, removed again
    /// unless [`Staging::install`] moves it into place.
    ///
    /// First it deletes every entry of `.staging/` that this process did not create. Nothing
    /// else removes them: a run that is killed, or aborts on a panic, leaves its download (the
    /// size of the Computer, about 140 MB) behind. Holding the lock means no other process is
    /// staging, so whatever another process made is stale.
    pub fn begin_staging<'lock>(
        &self,
        lock: &'lock MachineMutationLock,
        version: &str,
    ) -> Result<Staging<'lock>, UpdateError> {
        self.require_lock(lock)?;
        assert_version(version)?;
        let staging_root = self.install_root.join(".staging");
        create_private_directories(&staging_root).map_err(local(format_args!(
            "cannot create {}",
            staging_root.display()
        )))?;
        sweep_stale_staging(&staging_root);
        let directory = staging_root.join(format!("{version}-{}", unique_suffix()));
        create_private_directory(&directory)
            .map_err(local(format_args!("cannot create {}", directory.display())))?;
        Ok(Staging {
            _lock: lock,
            store: self.clone(),
            version: version.to_owned(),
            directory,
        })
    }

    /// The offline integrity check of an installed version: every file `installation.json` names
    /// (schemas 2, 3, and 4) is present and has the recorded size and checksum, and the marker,
    /// version, and identity agree.
    pub fn verify_installed(&self, version: &str) -> Result<(), UpdateError> {
        assert_version(version)?;
        self.check(&self.version_directory(version), version)
            .map_err(|fault| {
                UpdateError::IntegrityFailed(
                    match fault {
                        Fault::Mismatch(message) => message,
                        Fault::Unreadable => "installed version metadata or payload is invalid",
                    }
                    .into(),
                )
            })
    }

    fn computer_name(&self) -> &'static str {
        if self.windows {
            "coforge-computer.exe"
        } else {
            "coforge-computer"
        }
    }

    fn agent_cli_name(&self) -> &'static str {
        if self.windows {
            "coforge.cmd"
        } else {
            "coforge"
        }
    }

    fn github_cli_name(&self) -> &'static str {
        if self.windows { "gh.cmd" } else { "gh" }
    }

    fn check(&self, directory: &Path, version: &str) -> Result<(), Fault> {
        let computer = directory.join(self.computer_name());
        fs::metadata(&computer)?;
        let marker = fs::read_to_string(directory.join("version"))?;
        let raw: Value =
            serde_json::from_str(&fs::read_to_string(directory.join("installation.json"))?)?;
        // Schema 2 predates the GitHub launcher and any payload beyond the executable: those
        // versions are kept only as offline rollback targets.
        let has_daemon = raw
            .as_object()
            .is_some_and(|object| object.contains_key("daemon"));
        let identity: InstalledIdentity = serde_json::from_value(raw)?;

        if matches!(identity.schema_version, 3 | 4)
            && !file_matches(
                &directory.join(self.github_cli_name()),
                identity.github_cli.as_ref(),
            )?
        {
            return Err(Fault::Mismatch(
                "installed GitHub CLI launcher failed its offline integrity check",
            ));
        }
        if !file_matches(
            &directory.join(self.agent_cli_name()),
            Some(&identity.agent_cli),
        )? {
            return Err(Fault::Mismatch(
                "installed Agent CLI failed its offline integrity check",
            ));
        }
        if identity.schema_version == 4
            && !file_matches(&directory.join(PHOTON_WASM), identity.photon_wasm.as_ref())?
        {
            return Err(Fault::Mismatch(
                "installed image library failed its offline integrity check",
            ));
        }
        if marker.trim() != version
            || !matches!(identity.schema_version, 2..=4)
            || identity.version != version
            || has_daemon
            || !file_matches(&computer, Some(&identity.computer))?
        {
            return Err(Fault::Mismatch(
                "installed version failed its offline integrity check",
            ));
        }
        Ok(())
    }
}

/// A version being assembled in a private directory. The payload files go at
/// [`Staging::computer_path`] and [`Staging::photon_wasm_path`]; [`Staging::install`] completes
/// the directory and moves it into `versions/`. Dropping it removes the directory.
#[derive(Debug)]
pub struct Staging<'lock> {
    /// The lock is held for as long as the staging directory can be used.
    _lock: &'lock MachineMutationLock,
    store: VersionStore,
    version: String,
    directory: PathBuf,
}

impl Staging<'_> {
    pub fn computer_path(&self) -> PathBuf {
        self.directory.join(self.store.computer_name())
    }

    pub fn photon_wasm_path(&self) -> PathBuf {
        self.directory.join(PHOTON_WASM)
    }

    /// Writes the launchers, the marker, and `installation.json` for the two payload files, whose
    /// measured identities the caller passes, then renames the directory to `versions/<v>`.
    /// A version that is already installed and verifies is left as it is.
    pub fn install(
        self,
        computer: ArtifactIdentity,
        photon_wasm: ArtifactIdentity,
    ) -> Result<Installation, UpdateError> {
        if self.store.presence(&self.version)? == Presence::Verified {
            return Ok(Installation::AlreadyInstalled);
        }
        let store = &self.store;
        let agent_cli = agent_cli_launcher(store.windows);
        let github_cli = github_cli_launcher(store.windows);
        let identity = InstalledIdentity {
            schema_version: INSTALLED_IDENTITY_SCHEMA_VERSION,
            version: self.version.clone(),
            computer,
            agent_cli: measure_bytes(agent_cli.as_bytes()),
            github_cli: Some(measure_bytes(github_cli.as_bytes())),
            photon_wasm: Some(photon_wasm),
        };
        let write = |name: &str, contents: &str, mode: u32| {
            write_private_file(&self.directory.join(name), contents.as_bytes(), mode)
                .map_err(local(format_args!("cannot write {name}")))
        };
        write(store.agent_cli_name(), agent_cli, 0o700)?;
        write(store.github_cli_name(), github_cli, 0o700)?;
        write("version", &format!("{}\n", self.version), 0o600)?;
        write("installation.json", &to_file_json(&identity), 0o600)?;
        // The payload was written by the transfer, which knows nothing of these modes.
        set_mode(&self.computer_path(), 0o700).map_err(local("cannot restrict the executable"))?;
        set_mode(&self.photon_wasm_path(), 0o600)
            .map_err(local("cannot restrict the image library"))?;

        let versions = store.install_root.join("versions");
        create_private_directories(&versions)
            .map_err(local(format_args!("cannot create {}", versions.display())))?;
        let destination = store.version_directory(&self.version);
        fs::rename(&self.directory, &destination).map_err(local(format_args!(
            "cannot install {}",
            destination.display()
        )))?;
        sync_directory(&versions);
        Ok(Installation::Installed)
    }
}

impl Drop for Staging<'_> {
    fn drop(&mut self) {
        // After a successful install the directory has been renamed away and this does nothing.
        let _ = fs::remove_dir_all(&self.directory);
    }
}

/// Why an installed version failed its check: a named mismatch, or a file that could not be read
/// or parsed (which the Computer reports with one generic message).
enum Fault {
    Mismatch(&'static str),
    Unreadable,
}

impl From<io::Error> for Fault {
    fn from(_: io::Error) -> Self {
        Self::Unreadable
    }
}

impl From<serde_json::Error> for Fault {
    fn from(_: serde_json::Error) -> Self {
        Self::Unreadable
    }
}

/// A version is a directory name here, so it must be one safe path segment.
fn assert_version(version: &str) -> Result<(), UpdateError> {
    if is_valid_release_version(version) {
        Ok(())
    } else {
        Err(UpdateError::FeedInvalid(format!(
            "version is invalid: {version:?}"
        )))
    }
}

/// Whether the file has exactly the recorded size and checksum; false when no valid identity was
/// recorded. An unreadable file is an error, not a mismatch.
fn file_matches(path: &Path, recorded: Option<&ArtifactIdentity>) -> io::Result<bool> {
    let Some(recorded) = recorded.filter(|identity| is_valid_identity(identity)) else {
        return Ok(false);
    };
    if fs::metadata(path)?.len() != recorded.size {
        return Ok(false);
    }
    Ok(&measure_file(path)? == recorded)
}

fn local(context: impl Display) -> impl FnOnce(io::Error) -> UpdateError {
    move |error| UpdateError::Local(format!("{context}: {error}"))
}

/// Deletes the entries of `.staging/` that were not made by this process, whatever they are. Best
/// effort: an entry that cannot be removed only costs disk space, so it is not an error.
fn sweep_stale_staging(staging_root: &Path) {
    let Ok(entries) = fs::read_dir(staging_root) else {
        return;
    };
    for entry in entries.flatten() {
        if made_by_this_process(&entry.file_name().to_string_lossy()) {
            continue;
        }
        let path = entry.path();
        let _ = match entry.file_type() {
            Ok(kind) if kind.is_dir() => fs::remove_dir_all(&path),
            _ => fs::remove_file(&path),
        };
    }
}

/// Whether a staging directory name, `<version>-<pid>-<nanos>-<counter>` (a version may contain
/// dashes itself), was made by this process: it may be in use by a [`Staging`] still alive.
/// The pid alone would not do: process IDs repeat, and in a container every run tends to get the
/// same one, so a killed run's directory would look like this run's and never be swept. The
/// nanoseconds are this process's [`process_token`], read once.
fn made_by_this_process(name: &str) -> bool {
    let mut fields = name.rsplitn(4, '-');
    let (_counter, nanos, pid, version) =
        (fields.next(), fields.next(), fields.next(), fields.next());
    version.is_some_and(|version| !version.is_empty())
        && matches!((pid, nanos), (Some(pid), Some(nanos))
            if format!("{pid}-{nanos}") == process_token())
}

/// `<pid>-<nanoseconds since the epoch at first use>`: it names this process among every process
/// that has had, or will have, its pid.
fn process_token() -> &'static str {
    static TOKEN: OnceLock<String> = OnceLock::new();
    TOKEN.get_or_init(|| {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or_default();
        format!("{}-{nanos}", std::process::id())
    })
}

fn unique_suffix() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    format!(
        "{}-{}",
        process_token(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    )
}

#[cfg(unix)]
fn create_private_directories(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path)
}

#[cfg(not(unix))]
fn create_private_directories(path: &Path) -> io::Result<()> {
    fs::create_dir_all(path)
}

/// Creates one directory that must not exist yet.
#[cfg(unix)]
fn create_private_directory(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    fs::DirBuilder::new().mode(0o700).create(path)
}

#[cfg(not(unix))]
fn create_private_directory(path: &Path) -> io::Result<()> {
    fs::create_dir(path)
}

/// Creates a file that must not exist yet, with exactly `mode` (not filtered by the umask), and
/// flushes it to disk.
fn write_private_file(path: &Path, contents: &[u8], mode: u32) -> io::Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(mode);
    }
    let mut file: File = options.open(path)?;
    set_file_mode(&file, mode)?;
    file.write_all(contents)?;
    file.sync_all()
}

#[cfg(unix)]
fn set_file_mode(file: &File, mode: u32) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    file.set_permissions(fs::Permissions::from_mode(mode))
}

#[cfg(not(unix))]
fn set_file_mode(_file: &File, _mode: u32) -> io::Result<()> {
    Ok(())
}

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(mode))
}

#[cfg(not(unix))]
fn set_mode(path: &Path, _mode: u32) -> io::Result<()> {
    fs::metadata(path).map(|_| ())
}

/// Persists a rename. Best effort: some filesystems refuse to fsync a directory.
#[cfg(unix)]
fn sync_directory(path: &Path) {
    let _ = File::open(path).and_then(|directory| directory.sync_all());
}

#[cfg(not(unix))]
fn sync_directory(_path: &Path) {}

#[cfg(test)]
mod tests;
