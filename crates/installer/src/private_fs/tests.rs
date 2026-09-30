//! Tests of the primitives themselves, on real files. The callers' tests cover what each of them
//! does with the result; these pin what only this module can promise.

use std::fs;
use std::io;
use std::path::Path;

use super::*;
use crate::test_support::Scratch;
#[cfg(unix)]
use crate::test_support::{in_child, in_two_incarnations};

#[test]
fn a_new_file_is_never_created_over_an_existing_one() {
    let scratch = Scratch::new("private-fs-existing");
    let existing = scratch.path().join("keep");
    fs::write(&existing, b"original").unwrap();
    let directory = scratch.path().join("keep-directory");
    fs::create_dir(&directory).unwrap();

    let created = create_file(&existing, b"new", 0o600).unwrap_err();
    let pending = PendingFile::create(existing.clone(), FileMode::Umask(0o600))
        .err()
        .expect("a pending file must not reuse a name that exists");
    let exclusive = create_private_directory(&directory).unwrap_err();

    assert_eq!(created.kind(), io::ErrorKind::AlreadyExists);
    assert_eq!(pending.kind(), io::ErrorKind::AlreadyExists);
    assert_eq!(exclusive.kind(), io::ErrorKind::AlreadyExists);
    assert_eq!(fs::read(&existing).unwrap(), b"original");
}

/// The umask is process-wide, so the assertions run in a child started under `umask 077`.
#[cfg(unix)]
#[test]
fn an_exact_mode_ignores_the_umask_and_a_requested_mode_does_not() {
    use std::os::unix::fs::PermissionsExt;

    let name = "private_fs::tests::an_exact_mode_ignores_the_umask_and_a_requested_mode_does_not";
    if !in_child(name, "umask 077") {
        return;
    }

    let scratch = Scratch::new("private-fs-umask");
    let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
    // Every mode below asks for group and other access, which `umask 077` withholds.
    let everyone = 0o666;

    let created = scratch.path().join("created");
    create_file(&created, b"contents", everyone).unwrap();
    assert_eq!(mode(&created), everyone);

    let temporary = scratch.path().join("pending.tmp");
    let pending = PendingFile::create(temporary.clone(), FileMode::Exact(everyone)).unwrap();
    assert_eq!(
        mode(&temporary),
        0o600,
        "requested at creation, through the umask"
    );
    let committed = scratch.path().join("committed");
    pending.commit(&committed).unwrap();
    assert_eq!(mode(&committed), everyone);

    let replaced = scratch.path().join("replaced");
    replace_file(&replaced, b"contents", FileMode::Exact(everyone)).unwrap();
    assert_eq!(mode(&replaced), everyone);

    let filtered = scratch.path().join("filtered");
    replace_file(&filtered, b"contents", FileMode::Umask(everyone)).unwrap();
    assert_eq!(mode(&filtered), 0o600);
}

#[test]
fn a_replacement_that_cannot_be_renamed_into_place_leaves_the_destination_and_nothing_behind() {
    let scratch = Scratch::new("private-fs-rename");
    let destination = scratch.path().join("destination");
    // A file cannot replace a directory that has something in it.
    fs::create_dir_all(destination.join("inside")).unwrap();
    let pending =
        PendingFile::create(scratch.path().join("pending.tmp"), FileMode::Exact(0o600)).unwrap();

    let replaced = replace_file(&destination, b"contents", FileMode::Umask(0o600));
    let committed = pending.commit(&destination);

    assert!(replaced.is_err());
    assert!(committed.is_err());
    assert_eq!(scratch.entries(), ["destination"]);
    assert!(destination.join("inside").is_dir());
}

/// A file-size limit makes a write fail; ignoring `SIGXFSZ` turns its signal into the error.
#[cfg(unix)]
#[test]
fn a_replacement_that_cannot_be_written_leaves_the_destination_and_nothing_behind() {
    let name = "private_fs::tests::a_replacement_that_cannot_be_written_leaves_the_destination_and_nothing_behind";
    if !in_child(name, "ulimit -f 1 && trap '' XFSZ") {
        return;
    }

    let scratch = Scratch::new("private-fs-write");
    let destination = scratch.path().join("keep");
    fs::write(&destination, b"original").unwrap();

    let error =
        replace_file(&destination, &vec![0u8; 64 * 1024], FileMode::Umask(0o600)).unwrap_err();

    assert_eq!(error.kind(), io::ErrorKind::FileTooLarge);
    assert_eq!(fs::read(&destination).unwrap(), b"original");
    assert_eq!(scratch.entries(), ["keep"]);
}

#[test]
fn a_pending_file_exists_only_until_it_is_committed_or_dropped() {
    let scratch = Scratch::new("private-fs-pending");
    let temporary = scratch.path().join("pending.tmp");

    let dropped = PendingFile::create(temporary.clone(), FileMode::Umask(0o600)).unwrap();
    dropped.file().write_all(b"partial").unwrap();
    assert_eq!(scratch.entries(), ["pending.tmp"]);
    drop(dropped);
    assert_eq!(scratch.entries(), Vec::<String>::new());

    let committed = PendingFile::create(temporary, FileMode::Umask(0o600)).unwrap();
    committed.file().write_all(b"whole").unwrap();
    committed
        .commit(&scratch.path().join("destination"))
        .unwrap();
    assert_eq!(scratch.entries(), ["destination"]);
    assert_eq!(
        fs::read(scratch.path().join("destination")).unwrap(),
        b"whole"
    );
}

/// A container gives every run the same pid, so a name a killed run left behind must not be one
/// a later run makes: what tells them apart is the clock. The second incarnation is a new process
/// image with the same pid and, like the first, its first name (the same count).
#[cfg(unix)]
#[test]
fn a_temporary_sibling_differs_between_two_processes_that_had_one_pid() {
    let name =
        "private_fs::tests::a_temporary_sibling_differs_between_two_processes_that_had_one_pid";
    let Some([first, second]) = in_two_incarnations(name, || {
        temporary_sibling(Path::new("/install/active.json"))
            .display()
            .to_string()
    }) else {
        return;
    };

    assert_ne!(first, second);
}

#[cfg(unix)]
#[test]
fn a_partial_sibling_differs_between_two_processes_that_had_one_pid() {
    let name =
        "private_fs::tests::a_partial_sibling_differs_between_two_processes_that_had_one_pid";
    let Some([first, second]) = in_two_incarnations(name, || {
        partial_sibling(Path::new("/install/coforge-computer"))
            .unwrap()
            .display()
            .to_string()
    }) else {
        return;
    };

    assert_ne!(first, second);
}

/// What is on disk is what an operator and the next run see: where a temporary name is, what it
/// ends in, and that a second one from this process is a later one.
#[test]
fn a_temporary_sibling_is_beside_its_destination_and_counted() {
    let count = |path: &Path| -> u64 {
        assert_eq!(path.parent(), Some(Path::new("/install")));
        let name = path.file_name().unwrap().to_str().unwrap();
        let middle = name
            .strip_prefix("active.json.")
            .and_then(|rest| rest.strip_suffix(".tmp"))
            .unwrap_or_else(|| panic!("unexpected name {name}"));
        let fields: Vec<&str> = middle.split('-').collect();
        assert_eq!(fields.len(), 3, "{name}");
        assert_eq!(fields[0], process::id().to_string(), "{name}");
        fields[2].parse().unwrap()
    };

    let first = count(&temporary_sibling(Path::new("/install/active.json")));
    let second = count(&temporary_sibling(Path::new("/install/active.json")));

    assert!(second > first, "{first} then {second}");
}

#[test]
fn a_partial_sibling_is_hidden_beside_its_destination() {
    let beside = partial_sibling(Path::new("/install/coforge-computer")).unwrap();
    let bare = partial_sibling(Path::new("coforge-computer")).unwrap();

    assert_eq!(beside.parent(), Some(Path::new("/install")));
    assert_eq!(bare.parent(), Some(Path::new(".")));
    for path in [&beside, &bare] {
        let name = path.file_name().unwrap().to_str().unwrap();
        let middle = name
            .strip_prefix(".coforge-computer.")
            .and_then(|rest| rest.strip_suffix(".partial"))
            .unwrap_or_else(|| panic!("unexpected name {name}"));
        let (pid, _) = middle.split_once('.').unwrap();
        assert_eq!(pid, process::id().to_string(), "{name}");
    }
    assert_eq!(partial_sibling(Path::new("/")), None);
}
