//! Private files and directories under the install root, and atomic replacement.
//!
//! What the installer writes to disk takes a few shapes, and each is implemented here once:
//!
//! - a directory (recursively, or exactly one) whose mode is chosen at creation;
//! - a new file, written straight to its final path, with an exact mode ([`create_file`]);
//! - a file that replaces another atomically: written under a temporary name beside its
//!   destination, then renamed over it ([`replace_file`], or [`PendingFile`] when the bytes are
//!   streamed);
//! - the unique names of those temporaries.
//!
//! Modes are Unix modes; where the platform has none they are ignored.

use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// Creates `path` and any missing parents. `mode` applies to what is created (through the
/// umask) and never to a directory that already exists.
#[cfg(unix)]
pub(crate) fn create_directories(path: &Path, mode: u32) -> io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    fs::DirBuilder::new()
        .recursive(true)
        .mode(mode)
        .create(path)
}

#[cfg(not(unix))]
pub(crate) fn create_directories(path: &Path, _mode: u32) -> io::Result<()> {
    fs::create_dir_all(path)
}

/// [`create_directories`] with an owner-only mode: `0700`.
pub(crate) fn create_private_directories(path: &Path) -> io::Result<()> {
    create_directories(path, 0o700)
}

/// Creates one owner-only (`0700`) directory that must not exist yet. Its parent must.
#[cfg(unix)]
pub(crate) fn create_private_directory(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    fs::DirBuilder::new().mode(0o700).create(path)
}

#[cfg(not(unix))]
pub(crate) fn create_private_directory(path: &Path) -> io::Result<()> {
    fs::create_dir(path)
}

/// Sets the mode of an existing file or directory. Where modes do not exist it only checks that
/// `path` does.
#[cfg(unix)]
pub(crate) fn set_mode(path: &Path, mode: u32) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(mode))
}

#[cfg(not(unix))]
pub(crate) fn set_mode(path: &Path, _mode: u32) -> io::Result<()> {
    fs::metadata(path).map(|_| ())
}

/// Persists a rename. Best effort: some filesystems refuse to fsync a directory.
#[cfg(unix)]
pub(crate) fn sync_directory(path: &Path) {
    let _ = File::open(path).and_then(|directory| directory.sync_all());
}

#[cfg(not(unix))]
pub(crate) fn sync_directory(_path: &Path) {}

/// Creates a file that must not exist yet, with exactly `mode` (not filtered by the umask), and
/// flushes it to disk. It is written in place, not atomically: a caller that can leave a partial
/// file behind (a staging directory) is expected to remove it.
pub(crate) fn create_file(path: &Path, contents: &[u8], mode: u32) -> io::Result<()> {
    let mut file = open_new_file(path, mode)?;
    set_file_mode(&file, mode)?;
    file.write_all(contents)?;
    file.sync_all()
}

/// How a new file's mode is set.
pub(crate) enum FileMode {
    /// Requested when the file is created, so the umask can clear bits (as the Computer's
    /// `writeFile(path, data, { mode })` does).
    Umask(u32),
    /// Requested when the file is created and then set explicitly, so the umask cannot clear
    /// bits.
    Exact(u32),
}

/// Writes `contents` to a new file beside `destination`, then renames it over `destination`.
/// Anything that fails leaves `destination` as it was and no temporary file behind.
pub(crate) fn replace_file(destination: &Path, contents: &[u8], mode: FileMode) -> io::Result<()> {
    let pending = PendingFile::create(temporary_sibling(destination), mode)?;
    let mut file = pending.file();
    file.write_all(contents)?;
    pending.commit(destination)
}

/// A file being written under a temporary name, to replace a destination once it is complete.
/// [`PendingFile::commit`] flushes it, closes it, renames it over the destination, and persists
/// the rename. Dropped uncommitted, or after a commit that failed before the rename, it removes
/// the temporary file.
pub(crate) struct PendingFile {
    /// Emptied once the rename has happened: the temporary name no longer exists.
    path: PathBuf,
    /// Closed before the rename or removal: Windows refuses both on an open handle.
    file: Option<File>,
    /// The mode to set explicitly at commit, for [`FileMode::Exact`].
    exact_mode: Option<u32>,
}

impl PendingFile {
    /// Creates `path`, which must not exist, so it is the writer's alone.
    pub(crate) fn create(path: PathBuf, mode: FileMode) -> io::Result<Self> {
        let (requested, exact_mode) = match mode {
            FileMode::Umask(mode) => (mode, None),
            FileMode::Exact(mode) => (mode, Some(mode)),
        };
        let file = open_new_file(&path, requested)?;
        Ok(Self {
            path,
            file: Some(file),
            exact_mode,
        })
    }

    pub(crate) fn file(&self) -> &File {
        self.file
            .as_ref()
            .expect("the temporary file is open until commit or drop")
    }

    pub(crate) fn commit(mut self, destination: &Path) -> io::Result<()> {
        let file = self.file.take().expect("commit runs once");
        if let Some(mode) = self.exact_mode {
            set_file_mode(&file, mode)?;
        }
        // Without this a crash after the rename can leave an empty file under the final name.
        file.sync_all()?;
        drop(file);
        fs::rename(&self.path, destination)?;
        self.path = PathBuf::new();
        // Persist the rename itself.
        if let Some(parent) = destination
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            sync_directory(parent);
        }
        Ok(())
    }
}

impl Drop for PendingFile {
    fn drop(&mut self) {
        drop(self.file.take());
        if !self.path.as_os_str().is_empty() {
            let _ = fs::remove_file(&self.path);
        }
    }
}

/// Opens `path` for writing as a new file (`create_new`: it must not exist), requesting `mode`.
fn open_new_file(path: &Path, mode: u32) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(mode);
    }
    #[cfg(not(unix))]
    let _ = mode;
    options.open(path)
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

/// A name for a scratch file or link in `path`'s directory:
/// `<name>.<pid>-<nanoseconds>-<count>.tmp`.
pub(crate) fn temporary_sibling(path: &Path) -> PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let mut name: OsString = path.file_name().unwrap_or_default().to_owned();
    name.push(format!(
        ".{}-{}-{}.tmp",
        process::id(),
        nanoseconds_since_epoch(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    path.with_file_name(name)
}

/// A name for the file a download is written to before it is verified, in `path`'s directory (`.`
/// for a bare name): `.<name>.<pid>.<nanoseconds>.partial`. `None` when `path` names no file.
pub(crate) fn partial_sibling(path: &Path) -> Option<PathBuf> {
    let directory = match path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent.to_path_buf(),
        _ => PathBuf::from("."),
    };
    let name = path.file_name()?.to_string_lossy().into_owned();
    Some(directory.join(format!(
        ".{name}.{}.{}.partial",
        process::id(),
        nanoseconds_since_epoch()
    )))
}

fn nanoseconds_since_epoch() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_nanos())
}

#[cfg(test)]
mod tests;
