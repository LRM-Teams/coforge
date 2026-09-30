//! The machine mutation lock: held for a whole install, upgrade, or repair.
//!
//! The Computer takes the same lock (`acquireProcessLock` in packages/daemon, on bun:sqlite), and
//! so did every Computer released before this installer, so the two must exclude each other on
//! the same file. That is why it is an SQLite RESERVED lock and not a plain file lock: SQLite's
//! own locking is what both sides speak (crates/installer/contract/lock.json). The database is a
//! permanent lock object; nothing ever replaces or removes it.

use std::fmt;
use std::fs;
use std::io;
use std::path::Path;

use rusqlite::{Connection, ErrorCode};

/// The lock file, relative to the install root.
pub const LOCK_FILE: &str = "machine-mutation-lock.sqlite";

/// What a holder runs, in order, on its own connection to the lock database.
pub const LOCK_STATEMENTS: [&str; 2] = ["PRAGMA busy_timeout = 0", "BEGIN IMMEDIATE"];

/// The error code reported when another process holds the lock. It is one of the SDK's upgrade
/// error codes (crates/installer/contract/upgrade-error-codes.json), so a receipt may carry it as
/// its `errorCode`.
pub const BUSY_ERROR_CODE: &str = "UPDATE_BUSY";

#[derive(Debug)]
pub enum LockError {
    /// Another process holds the lock.
    Busy,
    /// The install root or the lock file could not be prepared.
    Io(io::Error),
    /// The lock file is not a usable database.
    Sqlite(rusqlite::Error),
}

impl LockError {
    /// The receipt `errorCode` for this failure: [`BUSY_ERROR_CODE`] for contention. A lock that
    /// could not be prepared or is not a usable database has none, because a receipt carries
    /// only the SDK's upgrade error codes and none of them describes it.
    pub fn code(&self) -> Option<&'static str> {
        match self {
            Self::Busy => Some(BUSY_ERROR_CODE),
            Self::Io(_) | Self::Sqlite(_) => None,
        }
    }
}

impl fmt::Display for LockError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Busy => formatter.write_str("another install, upgrade, or rollback is running"),
            Self::Io(error) => write!(
                formatter,
                "the machine mutation lock could not be prepared: {error}"
            ),
            Self::Sqlite(error) => {
                write!(formatter, "the machine mutation lock is unusable: {error}")
            }
        }
    }
}

/// Holds the lock until dropped.
#[derive(Debug)]
#[must_use = "the lock is released as soon as this is dropped, so `acquire(..)?;` holds nothing"]
pub struct MachineMutationLock {
    _connection: Connection,
}

impl MachineMutationLock {
    /// Takes the lock in `install_root`, creating the directory (owner-only) and the lock file
    /// (0600) when missing. Never waits: a held lock is `LockError::Busy` at once.
    pub fn acquire(install_root: &Path) -> Result<Self, LockError> {
        create_private_directory(install_root).map_err(LockError::Io)?;
        let path = install_root.join(LOCK_FILE);
        let connection = Connection::open(&path).map_err(LockError::Sqlite)?;
        restrict_to_owner(&path).map_err(LockError::Io)?;
        for statement in LOCK_STATEMENTS {
            // `PRAGMA busy_timeout` answers with a row, so every statement is stepped through a
            // query rather than `execute`, which refuses statements that return rows.
            let mut prepared = connection.prepare(statement).map_err(classify)?;
            let mut rows = prepared.query([]).map_err(classify)?;
            while rows.next().map_err(classify)?.is_some() {}
        }
        Ok(Self {
            _connection: connection,
        })
    }
}

/// SQLite reports contention as `SQLITE_BUSY` (or `SQLITE_LOCKED`); with `busy_timeout = 0` it
/// does so immediately instead of waiting.
fn classify(error: rusqlite::Error) -> LockError {
    match error.sqlite_error_code() {
        Some(ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked) => LockError::Busy,
        _ => LockError::Sqlite(error),
    }
}

#[cfg(unix)]
fn create_private_directory(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path)
}

#[cfg(not(unix))]
fn create_private_directory(path: &Path) -> io::Result<()> {
    fs::create_dir_all(path)
}

#[cfg(unix)]
fn restrict_to_owner(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn restrict_to_owner(_path: &Path) -> io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests;
