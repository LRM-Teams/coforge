use std::collections::BTreeSet;
use std::io::{BufRead, BufReader};
use std::os::raw::c_int;
use std::path::PathBuf;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use rusqlite::ffi;

use super::*;
use crate::contract::{MachineMutationLock as LockContract, UpgradeErrorCodes};

/// A fresh, empty install root under the system temp directory, removed on drop.
struct Scratch(PathBuf);

impl Scratch {
    fn new(label: &str) -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "coforge-installer-lock-{label}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn contract() -> LockContract {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("contract/lock.json");
    serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
}

#[test]
fn takes_the_lock_exactly_as_the_contract_says() {
    let contract = contract();
    assert_eq!(contract.directory, "install_root");
    assert_eq!(contract.engine, "sqlite");
    assert_eq!(LOCK_FILE, contract.file);
    assert_eq!(LOCK_STATEMENTS.as_slice(), contract.statements.as_slice());
    assert_eq!(BUSY_ERROR_CODE, contract.busy_error_code);
}

/// The SQLite primary result code a `contention_codes` name stands for. A name this does not know
/// panics: `classify` has to be taught it before the contract can list it.
fn result_code_named(name: &str) -> c_int {
    match name {
        "SQLITE_BUSY" => ffi::SQLITE_BUSY,
        "SQLITE_LOCKED" => ffi::SQLITE_LOCKED,
        other => panic!("lock.json lists {other}, which `classify` does not know"),
    }
}

#[test]
fn exactly_the_contracts_contention_codes_mean_another_holder() {
    let listed: BTreeSet<c_int> = contract()
        .contention_codes
        .iter()
        .map(|name| result_code_named(name))
        .collect();
    assert!(!listed.is_empty());
    // Every primary result code (SQLITE_ERROR = 1 through SQLITE_WARNING = 28), plus the two
    // that step results use.
    for code in (1..=28).chain([ffi::SQLITE_ROW, ffi::SQLITE_DONE]) {
        let error = rusqlite::Error::SqliteFailure(ffi::Error::new(code), None);
        assert_eq!(
            matches!(classify(error), LockError::Busy),
            listed.contains(&code),
            "result code {code}"
        );
    }
}

/// A receipt's `errorCode` is one of the SDK's upgrade error codes and nothing else, so a lock
/// failure that has none carries no code at all.
#[test]
fn only_contention_carries_a_receipt_error_code() {
    let sdk_codes: UpgradeErrorCodes = serde_json::from_str(
        &fs::read_to_string(
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("contract/upgrade-error-codes.json"),
        )
        .unwrap(),
    )
    .unwrap();

    let busy = LockError::Busy.code().expect("contention has a code");
    assert!(
        sdk_codes.codes.values().any(|code| code == busy),
        "{busy} is not one of the SDK's upgrade error codes"
    );
    assert_eq!(LockError::Io(io::Error::other("no space")).code(), None);
    assert_eq!(
        LockError::Sqlite(rusqlite::Error::InvalidQuery).code(),
        None
    );
}

#[test]
fn a_second_holder_is_refused_until_the_first_releases() {
    let root = Scratch::new("second");
    let first = MachineMutationLock::acquire(&root.0).unwrap();

    let refused = MachineMutationLock::acquire(&root.0).unwrap_err();
    assert!(matches!(refused, LockError::Busy), "{refused:?}");
    assert_eq!(refused.code(), Some("UPDATE_BUSY"));

    drop(first);
    drop(MachineMutationLock::acquire(&root.0).unwrap());
}

#[test]
fn creates_the_install_root_and_an_owner_only_lock_file() {
    let root = Scratch::new("create");
    let install_root = root.0.join("nested").join("install");

    let _lock = MachineMutationLock::acquire(&install_root).unwrap();

    let file = install_root.join(LOCK_FILE);
    assert!(file.is_file());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let contract_mode = u32::from_str_radix(&contract().mode, 8).unwrap();
        assert_eq!(
            fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            contract_mode
        );
        assert_eq!(
            fs::metadata(&install_root).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }
}

#[test]
fn a_lock_knows_the_install_root_it_covers_however_that_is_spelled() {
    let root = Scratch::new("covers");
    let other = Scratch::new("covers-other");
    let lock = MachineMutationLock::acquire(&root.0).unwrap();

    assert!(lock.covers(&root.0));
    assert!(lock.covers(&root.0.join(".")));
    assert!(!lock.covers(&other.0));
    // A root that does not exist is not the one that was locked.
    assert!(!lock.covers(&root.0.join("absent")));
    assert_eq!(
        lock.install_root(),
        fs::canonicalize(&root.0).unwrap().as_path()
    );
    #[cfg(unix)]
    {
        let link = other.0.join("link");
        std::os::unix::fs::symlink(&root.0, &link).unwrap();
        assert!(
            lock.covers(&link),
            "a symlink to the locked root is the locked root"
        );
    }
}

/// The Computer's own lock: `acquireProcessLock` from packages/daemon, run by Bun. The installer
/// and every Computer before it must exclude each other on the same file, so these tests drive
/// the product's real function rather than a copy of its statements.
fn bun() -> Command {
    let bun = std::env::var_os("BUN").unwrap_or_else(|| "bun".into());
    let mut command = Command::new(bun);
    command.current_dir(env!("CARGO_MANIFEST_DIR"));
    command
}

fn process_lock_module() -> String {
    // Not canonicalized: on Windows that yields a `\\?\` path, which is not an import specifier.
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join("packages/daemon/src/platform/process-lock.ts");
    assert!(path.is_file(), "{} is missing", path.display());
    path.to_string_lossy().replace('\\', "/")
}

/// How long any wait on a Bun child may last: for it to report, or to exit. Bun starts in well
/// under a second; this is only the point at which a stuck child is declared hung, so that it
/// fails one test instead of stalling the whole run.
const BUN_DEADLINE: Duration = Duration::from_secs(30);

/// A Bun child that every wait is bounded on. Once `BUN_DEADLINE` passes, the child is killed and
/// the test fails saying what it was waiting for. It is killed when dropped too, so a failed
/// assertion cannot leave Bun holding the lock.
struct BunChild {
    child: Child,
    stdout_lines: Receiver<String>,
}

impl BunChild {
    fn spawn(script: &str, install_root: &Path) -> Self {
        let mut child = bun()
            .args(["--eval", script])
            .env("LOCK_PATH", install_root.join(LOCK_FILE))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("bun must be on PATH (or set BUN): the lock is shared with the Computer");
        let stdout = child.stdout.take().unwrap();
        let (sender, stdout_lines) = mpsc::channel();
        // A blocking read cannot be given a deadline, so it happens here and the test waits on
        // the channel. The thread ends when Bun's stdout closes: it exits, or is killed.
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { return };
                if sender.send(line).is_err() {
                    return;
                }
            }
        });
        Self {
            child,
            stdout_lines,
        }
    }

    /// The next line Bun prints.
    fn next_line(&mut self, waiting_for: &str) -> String {
        match self.stdout_lines.recv_timeout(BUN_DEADLINE) {
            Ok(line) => line,
            Err(RecvTimeoutError::Timeout) => self.hung(format!(
                "Bun printed nothing for {BUN_DEADLINE:?} while the test waited for {waiting_for}"
            )),
            Err(RecvTimeoutError::Disconnected) => self.hung(format!(
                "Bun closed stdout while the test waited for {waiting_for}"
            )),
        }
    }

    /// Closes Bun's stdin, which tells it to release the lock and exit, and waits for it to.
    fn finish(&mut self, waiting_for: &str) -> ExitStatus {
        drop(self.child.stdin.take());
        let deadline = Instant::now() + BUN_DEADLINE;
        // The completion awaited is the child's own exit status; the pause only spaces the polls.
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                return status;
            }
            if Instant::now() >= deadline {
                self.hung(format!(
                    "Bun still running {BUN_DEADLINE:?} after its stdin closed, while the test waited for {waiting_for}"
                ));
            }
            thread::sleep(Duration::from_millis(10));
        }
    }

    fn hung(&mut self, message: String) -> ! {
        self.kill();
        panic!("{message}");
    }

    fn kill(&mut self) {
        // Already exited is fine: the goal is that no child is left.
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for BunChild {
    fn drop(&mut self) {
        self.kill();
    }
}

/// Runs Bun holding the Computer's lock on `install_root` until `finish` closes its stdin.
/// Returns once Bun reports that it holds it.
fn computer_holds(install_root: &Path) -> BunChild {
    let script = format!(
        r#"import {{ acquireProcessLock }} from "{module}";
const lock = acquireProcessLock(Bun.env.LOCK_PATH);
console.log("held");
for await (const _ of Bun.stdin.stream()) {{}}
lock.release();"#,
        module = process_lock_module()
    );
    let mut child = BunChild::spawn(&script, install_root);
    let line = child.next_line("the Computer to take the lock");
    assert_eq!(line, "held", "Bun did not take the lock");
    child
}

/// What the Computer's lock does on `install_root` right now: "acquired", or "busy" when
/// `isLockContention` recognises the refusal.
fn computer_tries(install_root: &Path) -> String {
    let script = format!(
        r#"import {{ acquireProcessLock, isLockContention }} from "{module}";
try {{ acquireProcessLock(Bun.env.LOCK_PATH).release(); console.log("acquired"); }}
catch (error) {{ console.log(isLockContention(error) ? "busy" : `error: ${{error}}`); }}"#,
        module = process_lock_module()
    );
    let mut child = BunChild::spawn(&script, install_root);
    let outcome = child.next_line("the Computer's attempt on the lock");
    let status = child.finish("the Computer's attempt to end");
    assert!(status.success(), "Bun exited with {status}");
    outcome
}

#[test]
fn the_computer_is_refused_while_the_installer_holds_the_lock() {
    let root = Scratch::new("installer-holds");
    let lock = MachineMutationLock::acquire(&root.0).unwrap();

    assert_eq!(computer_tries(&root.0), "busy");

    drop(lock);
    assert_eq!(computer_tries(&root.0), "acquired");
}

#[test]
fn the_installer_is_refused_while_the_computer_holds_the_lock() {
    let root = Scratch::new("computer-holds");
    let mut computer = computer_holds(&root.0);

    let refused = MachineMutationLock::acquire(&root.0).unwrap_err();
    assert!(matches!(refused, LockError::Busy), "{refused:?}");

    let status = computer.finish("the Computer to release the lock");
    assert!(status.success(), "Bun exited with {status}");
    drop(MachineMutationLock::acquire(&root.0).unwrap());
}

#[test]
fn a_lock_file_that_is_not_a_database_is_an_error_not_contention() {
    let root = Scratch::new("corrupt");
    fs::write(
        root.0.join(LOCK_FILE),
        b"this is not an SQLite database, it is a text file",
    )
    .unwrap();

    let error = MachineMutationLock::acquire(&root.0).unwrap_err();
    assert!(!matches!(error, LockError::Busy), "{error:?}");
    assert_eq!(error.code(), None);
}
