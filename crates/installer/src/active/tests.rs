use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;

use super::*;

/// A fresh, empty directory under the system temp directory, removed on drop.
struct Scratch(PathBuf);

impl Scratch {
    fn new(label: &str) -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "coforge-installer-active-{label}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn install_root(&self) -> PathBuf {
        self.0.join("install")
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn state(current: &str, previous: Option<&str>) -> ActiveState {
    ActiveState {
        schema_version: 1,
        current: current.into(),
        previous: previous.map(Into::into),
    }
}

fn contract_text(name: &str) -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("contract")
        .join(name);
    fs::read_to_string(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

/// Every file in `directory`, sorted, so a test can assert what is and is not left behind.
fn names(directory: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(directory)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

#[test]
fn there_is_no_active_state_before_the_first_install() {
    let scratch = Scratch::new("missing");
    assert!(read_active(&scratch.install_root()).unwrap().is_none());
    fs::create_dir_all(scratch.install_root()).unwrap();
    assert!(read_active(&scratch.install_root()).unwrap().is_none());
}

#[test]
fn a_written_state_reads_back_and_is_the_product_golden_byte_for_byte_in_compact_form() {
    let scratch = Scratch::new("round-trip");
    let install_root = scratch.install_root();
    let golden: ActiveState = serde_json::from_str(&contract_text("active.v1.json")).unwrap();

    write_active_state(&install_root, &golden).unwrap();

    assert_eq!(read_active(&install_root).unwrap(), Some(golden.clone()));
    // What JSON.stringify(state) + "\n" gives the Computer: compact, in the schema's field order.
    let text = fs::read_to_string(install_root.join("active.json")).unwrap();
    assert_eq!(
        text,
        format!(
            "{{\"schema_version\":1,\"current\":\"{}\",\"previous\":\"{}\"}}\n",
            golden.current,
            golden.previous.as_deref().unwrap()
        )
    );
    assert_eq!(
        serde_json::from_str::<Value>(&text).unwrap(),
        serde_json::from_str::<Value>(&contract_text("active.v1.json")).unwrap()
    );
}

#[test]
fn no_previous_version_is_written_as_null_and_read_as_none() {
    let scratch = Scratch::new("null-previous");
    let install_root = scratch.install_root();

    write_active_state(&install_root, &state("0.1.0", None)).unwrap();

    assert_eq!(
        fs::read_to_string(install_root.join("active.json")).unwrap(),
        "{\"schema_version\":1,\"current\":\"0.1.0\",\"previous\":null}\n"
    );
    assert_eq!(
        read_active(&install_root).unwrap(),
        Some(state("0.1.0", None))
    );
}

#[test]
fn a_later_version_may_add_fields() {
    let scratch = Scratch::new("extra-field");
    fs::create_dir_all(scratch.install_root()).unwrap();
    fs::write(
        scratch.install_root().join("active.json"),
        r#"{"schema_version":1,"current":"0.2.0","previous":null,"x_later":{"a":1}}"#,
    )
    .unwrap();
    assert_eq!(
        read_active(&scratch.install_root()).unwrap(),
        Some(state("0.2.0", None))
    );
}

#[test]
fn an_unusable_active_json_is_an_invalid_active_version() {
    let scratch = Scratch::new("invalid");
    let install_root = scratch.install_root();
    fs::create_dir_all(&install_root).unwrap();
    let cases = [
        ("empty", ""),
        ("truncated", r#"{"schema_version":1,"current":"0.2.0","#),
        ("not an object", "[]"),
        ("null", "null"),
        (
            "a later schema",
            r#"{"schema_version":2,"current":"0.2.0","previous":null}"#,
        ),
        ("no current", r#"{"schema_version":1,"previous":null}"#),
        (
            "current is a number",
            r#"{"schema_version":1,"current":2,"previous":null}"#,
        ),
        (
            "empty current",
            r#"{"schema_version":1,"current":"","previous":null}"#,
        ),
        (
            "traversing current",
            r#"{"schema_version":1,"current":"../x","previous":null}"#,
        ),
        (
            "current with a separator",
            r#"{"schema_version":1,"current":"0.2.0/bin","previous":null}"#,
        ),
        (
            "flag-like current",
            r#"{"schema_version":1,"current":"-rf","previous":null}"#,
        ),
    ];
    for (label, contents) in cases {
        fs::write(install_root.join("active.json"), contents).unwrap();
        let error = read_active(&install_root).unwrap_err();
        assert!(matches!(error, ActiveError::Invalid), "{label}: {error:?}");
        assert_eq!(error.code(), Some("UPDATE_FEED_INVALID"), "{label}");
        assert_eq!(error.to_string(), "active version is invalid", "{label}");
    }

    fs::write(install_root.join("active.json"), [0xff, 0xfe, 0x00]).unwrap();
    assert!(matches!(
        read_active(&install_root),
        Err(ActiveError::Invalid)
    ));
}

/// As the Computer: only `current` must be usable to read the state. The Computer treats a
/// `previous` string that is not a valid version as "nothing to roll back to" (`rollback`,
/// `#prepareRollback`); a non-string one, which its writer never produces, reads the same way here.
/// Either way it neither stops a forward upgrade nor is carried into the next `active.json`.
#[test]
fn an_unusable_previous_reads_as_no_previous_version() {
    let scratch = Scratch::new("unusable-previous");
    let install_root = scratch.install_root();
    fs::create_dir_all(&install_root).unwrap();
    for previous in [
        r#""""#,
        r#""..""#,
        r#""../x""#,
        r#""-rf""#,
        "1",
        "true",
        "{}",
        "[]",
    ] {
        fs::write(
            install_root.join("active.json"),
            format!(r#"{{"schema_version":1,"current":"0.2.0","previous":{previous}}}"#),
        )
        .unwrap();
        assert_eq!(
            read_active(&install_root).unwrap(),
            Some(state("0.2.0", None)),
            "{previous}"
        );
    }
    fs::write(
        install_root.join("active.json"),
        r#"{"schema_version":1,"current":"0.2.0"}"#,
    )
    .unwrap();
    assert_eq!(
        read_active(&install_root).unwrap(),
        Some(state("0.2.0", None))
    );
}

#[test]
fn a_state_that_could_not_be_read_back_is_never_written() {
    let scratch = Scratch::new("refuse");
    let install_root = scratch.install_root();
    for invalid in [
        state("../escape", None),
        state("", None),
        state("0.2.0", Some("a/b")),
        ActiveState {
            schema_version: 2,
            ..state("0.2.0", None)
        },
    ] {
        let error = write_active_state(&install_root, &invalid).unwrap_err();
        assert_eq!(error.code(), Some("UPDATE_FEED_INVALID"), "{invalid:?}");
    }
    assert!(!install_root.join("active.json").exists());
}

#[test]
fn an_active_json_that_cannot_be_read_is_an_io_failure_not_an_invalid_version() {
    let scratch = Scratch::new("unreadable");
    let install_root = scratch.install_root();
    fs::create_dir_all(install_root.join("active.json")).unwrap();
    let error = read_active(&install_root).unwrap_err();
    assert!(matches!(error, ActiveError::Io(_)), "{error:?}");
    // Only the Computer's `UpdateError` codes reach a receipt; a file-system failure has none.
    assert_eq!(error.code(), None);
}

#[test]
fn writing_replaces_the_previous_state_and_leaves_nothing_else_behind() {
    let scratch = Scratch::new("replace");
    let install_root = scratch.install_root();
    write_active_state(&install_root, &state("0.1.0", None)).unwrap();
    write_active_state(&install_root, &state("0.2.0", Some("0.1.0"))).unwrap();
    assert_eq!(names(&install_root), ["active.json"]);
    assert_eq!(
        read_active(&install_root).unwrap(),
        Some(state("0.2.0", Some("0.1.0")))
    );
}

#[cfg(unix)]
#[test]
fn the_state_file_is_owner_only_in_an_owner_only_directory() {
    use std::os::unix::fs::PermissionsExt;
    let scratch = Scratch::new("modes");
    let install_root = scratch.install_root();
    write_active_state(&install_root, &state("0.2.0", None)).unwrap();
    let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode(&install_root.join("active.json")), 0o600);
    assert_eq!(mode(&install_root), 0o700);
}

/// Installed version directories, each holding a `file` whose contents name the version, so a
/// test can tell which one a link resolves to by reading through it.
fn install_versions(install_root: &Path, file: &str, versions: &[&str]) {
    for version in versions {
        let directory = install_root.join("versions").join(version);
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join(file), version).unwrap();
    }
}

#[cfg(unix)]
mod posix {
    use std::os::unix::fs::{PermissionsExt, symlink};

    use super::*;

    const TARGET: &str = "linux-x64";

    fn mode(path: &Path) -> u32 {
        fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    struct Layout {
        scratch: Scratch,
        install_root: PathBuf,
        binary_directory: PathBuf,
    }

    fn layout(label: &str, versions: &[&str]) -> Layout {
        let scratch = Scratch::new(label);
        let install_root = scratch.install_root();
        install_versions(&install_root, "coforge-computer", versions);
        // Two levels that do not exist yet, as on a fresh machine (`~/.local/bin`).
        let binary_directory = scratch.0.join("home").join(".local").join("bin");
        Layout {
            scratch,
            install_root,
            binary_directory,
        }
    }

    impl Layout {
        fn activate(&self, next: &ActiveState) -> Result<(), ActiveError> {
            activate(&self.install_root, &self.binary_directory, TARGET, next)
        }

        fn shim(&self) -> PathBuf {
            self.binary_directory.join("coforge-computer")
        }
    }

    #[test]
    fn active_and_the_shim_point_at_the_version_exactly_as_the_computer_links_them() {
        let layout = layout("links", &["0.2.0"]);
        let next = state("0.2.0", Some("0.1.0"));

        layout.activate(&next).unwrap();

        // Relative, so the installation can be moved as a whole.
        assert_eq!(
            fs::read_link(layout.install_root.join("active")).unwrap(),
            Path::new("versions/0.2.0")
        );
        // Absolute, through `active`, so a later switch never rewrites the shim.
        assert_eq!(
            fs::read_link(layout.shim()).unwrap(),
            layout.install_root.join("active").join("coforge-computer")
        );
        assert_eq!(fs::read_to_string(layout.shim()).unwrap(), "0.2.0");
        assert_eq!(read_active(&layout.install_root).unwrap(), Some(next));
    }

    /// What the process umask leaves of `requested` on a directory created now, found by creating
    /// one with every bit requested (std offers no way to read the umask without changing it).
    fn after_umask(scratch: &Scratch, requested: u32) -> u32 {
        use std::os::unix::fs::DirBuilderExt;
        let probe = scratch.0.join("umask-probe");
        fs::DirBuilder::new().mode(0o777).create(&probe).unwrap();
        let allowed = mode(&probe);
        fs::remove_dir(&probe).unwrap();
        requested & allowed
    }

    #[test]
    fn the_shim_directory_is_world_traversable_and_the_state_file_is_private() {
        let layout = layout("modes", &["0.2.0"]);

        layout.activate(&state("0.2.0", None)).unwrap();

        // 0755, not 0700: `~/.local/bin` is shared with other tools, and a recursive create must
        // not leave `~/.local` owner-only for all of them. The umask still applies, as it does to
        // the Computer's mkdir.
        let expected = after_umask(&layout.scratch, 0o755);
        assert_eq!(mode(&layout.binary_directory), expected);
        assert_eq!(mode(layout.binary_directory.parent().unwrap()), expected);
        assert_eq!(mode(&layout.install_root.join("active.json")), 0o600);
    }

    #[test]
    fn switching_versions_replaces_both_links_and_leaves_no_temporary_behind() {
        let layout = layout("switch", &["0.1.0", "0.2.0"]);

        layout.activate(&state("0.1.0", None)).unwrap();
        layout.activate(&state("0.2.0", Some("0.1.0"))).unwrap();

        assert_eq!(fs::read_to_string(layout.shim()).unwrap(), "0.2.0");
        assert_eq!(
            fs::read_link(layout.install_root.join("active")).unwrap(),
            Path::new("versions/0.2.0")
        );

        // Rollback: the same call in the other direction.
        layout.activate(&state("0.1.0", Some("0.2.0"))).unwrap();

        assert_eq!(fs::read_to_string(layout.shim()).unwrap(), "0.1.0");
        assert_eq!(
            names(&layout.install_root),
            ["active", "active.json", "versions"]
        );
        assert_eq!(names(&layout.binary_directory), ["coforge-computer"]);
        assert_eq!(
            read_active(&layout.install_root).unwrap(),
            Some(state("0.1.0", Some("0.2.0")))
        );
    }

    #[test]
    fn a_shim_that_an_earlier_kind_of_install_left_as_a_file_is_replaced() {
        let layout = layout("old-shim", &["0.2.0"]);
        fs::create_dir_all(&layout.binary_directory).unwrap();
        fs::write(layout.shim(), "an old executable").unwrap();

        layout.activate(&state("0.2.0", None)).unwrap();

        assert!(
            fs::symlink_metadata(layout.shim())
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert_eq!(fs::read_to_string(layout.shim()).unwrap(), "0.2.0");
    }

    #[test]
    fn a_shim_directory_that_exists_keeps_its_mode() {
        let layout = layout("existing-bin", &["0.2.0"]);
        fs::create_dir_all(&layout.binary_directory).unwrap();
        fs::set_permissions(&layout.binary_directory, fs::Permissions::from_mode(0o750)).unwrap();

        layout.activate(&state("0.2.0", None)).unwrap();

        assert_eq!(mode(&layout.binary_directory), 0o750);
    }

    #[test]
    fn a_state_that_names_no_valid_version_changes_nothing() {
        let layout = layout("invalid", &["0.2.0"]);

        let error = layout.activate(&state("../0.2.0", None)).unwrap_err();

        assert_eq!(error.code(), Some("UPDATE_FEED_INVALID"));
        assert_eq!(names(&layout.install_root), ["versions"]);
        assert!(!layout.binary_directory.exists());
    }

    #[test]
    fn a_link_that_cannot_be_switched_is_reported_and_leaves_no_temporary_link() {
        let layout = layout("blocked", &["0.2.0"]);
        // A real directory where the link belongs: a symlink cannot be renamed over it.
        fs::create_dir_all(layout.install_root.join("active").join("keep")).unwrap();

        let error = layout.activate(&state("0.2.0", None)).unwrap_err();

        assert!(matches!(error, ActiveError::Io(_)), "{error:?}");
        assert_eq!(error.code(), None);
        assert_eq!(
            names(&layout.install_root),
            ["active", "active.json", "versions"]
        );
        assert!(layout.install_root.join("active/keep").is_dir());
    }

    /// The Computer's order: `active.json`, then `active`, then the shim. A shim that cannot be
    /// replaced therefore fails after `active` has switched, and the shim (which points through
    /// `active`) is the only thing left behind.
    #[test]
    fn a_shim_that_cannot_be_switched_fails_after_active_has_switched() {
        let layout = layout("blocked-shim", &["0.1.0", "0.2.0"]);
        layout.activate(&state("0.1.0", None)).unwrap();
        fs::remove_file(layout.shim()).unwrap();
        // A real, non-empty directory where the shim belongs: a symlink cannot be renamed over it.
        fs::create_dir_all(layout.shim().join("keep")).unwrap();

        let error = layout.activate(&state("0.2.0", Some("0.1.0"))).unwrap_err();

        assert!(matches!(error, ActiveError::Io(_)), "{error:?}");
        assert_eq!(
            fs::read_link(layout.install_root.join("active")).unwrap(),
            Path::new("versions/0.2.0")
        );
        assert_eq!(
            read_active(&layout.install_root).unwrap(),
            Some(state("0.2.0", Some("0.1.0")))
        );
        assert!(layout.shim().join("keep").is_dir());
        assert_eq!(names(&layout.binary_directory), ["coforge-computer"]);
    }

    #[test]
    fn the_shim_is_reachable_when_the_install_root_is_itself_a_link() {
        // ~/.coforge may be a symlink to another disk; the absolute shim target still resolves.
        let layout = layout("linked-root", &["0.2.0"]);
        let alias = layout.scratch.0.join("alias");
        symlink(&layout.install_root, &alias).unwrap();

        activate(
            &alias,
            &layout.binary_directory,
            TARGET,
            &state("0.2.0", None),
        )
        .unwrap();

        assert_eq!(fs::read_to_string(layout.shim()).unwrap(), "0.2.0");
    }
}

/// The Windows shim on any host: the file is the product's launcher for that install root.
#[test]
fn the_windows_shim_is_the_launcher_the_product_writes() {
    let scratch = Scratch::new("cmd-shim");
    let golden: crate::contract::WindowsLaunchers =
        serde_json::from_str(&contract_text("launchers.windows.json")).unwrap();
    let binary_directory = scratch.0.join("bin");
    fs::create_dir_all(&binary_directory).unwrap();

    // Twice: the second write replaces the first.
    for _ in 0..2 {
        write_windows_launcher(Path::new(&golden.shim.install_root), &binary_directory).unwrap();
    }

    assert_eq!(names(&binary_directory), [golden.shim.file.as_str()]);
    assert_eq!(
        fs::read_to_string(binary_directory.join(&golden.shim.file)).unwrap(),
        golden.shim.contents
    );
}

#[test]
fn a_trailing_separator_on_the_install_root_does_not_double_up_in_the_shim() {
    let scratch = Scratch::new("cmd-trailing");
    let binary_directory = scratch.0.join("bin");
    fs::create_dir_all(&binary_directory).unwrap();

    write_windows_launcher(Path::new(r"C:\Users\example\install\"), &binary_directory).unwrap();

    assert_eq!(
        fs::read_to_string(binary_directory.join("coforge-computer.cmd")).unwrap(),
        crate::contract::windows_computer_launcher(r"C:\Users\example\install")
    );
}

#[test]
fn a_failed_creation_removes_what_it_left_but_never_what_was_already_there() {
    let scratch = Scratch::new("left-behind");
    let left = scratch.0.join("left");
    let taken = scratch.0.join("taken");
    for directory in [&left, &taken] {
        fs::create_dir_all(directory.join("inside")).unwrap();
    }

    remove_what_creation_left(&left, &io::Error::other("the junction could not be made"));
    remove_what_creation_left(&taken, &io::Error::from(io::ErrorKind::AlreadyExists));

    assert!(!left.exists());
    assert!(taken.join("inside").is_dir());
}

/// These run only on the Windows CI entries.
#[cfg(windows)]
mod windows {
    use super::*;

    const TARGET: &str = "windows-x64";
    const EXECUTABLE: &str = "coforge-computer.exe";

    fn is_link(path: &Path) -> bool {
        fs::symlink_metadata(path).unwrap().file_type().is_symlink()
    }

    #[test]
    fn active_is_a_junction_to_the_version_and_the_cmd_shim_is_the_launcher() {
        let scratch = Scratch::new("junction");
        let install_root = scratch.install_root();
        let binary_directory = scratch.0.join("bin");
        install_versions(&install_root, EXECUTABLE, &["0.2.0"]);
        let next = state("0.2.0", Some("0.1.0"));

        activate(&install_root, &binary_directory, TARGET, &next).unwrap();

        let active = install_root.join("active");
        assert!(is_link(&active));
        assert_eq!(
            fs::read_to_string(active.join(EXECUTABLE)).unwrap(),
            "0.2.0"
        );
        assert_eq!(
            fs::read_to_string(binary_directory.join("coforge-computer.cmd")).unwrap(),
            crate::contract::windows_computer_launcher(install_root.to_str().unwrap())
        );
        assert_eq!(read_active(&install_root).unwrap(), Some(next));
    }

    #[test]
    fn switching_versions_replaces_the_junction_and_keeps_the_old_version() {
        let scratch = Scratch::new("junction-switch");
        let install_root = scratch.install_root();
        let binary_directory = scratch.0.join("bin");
        install_versions(&install_root, EXECUTABLE, &["0.1.0", "0.2.0"]);

        activate(
            &install_root,
            &binary_directory,
            TARGET,
            &state("0.1.0", None),
        )
        .unwrap();
        activate(
            &install_root,
            &binary_directory,
            TARGET,
            &state("0.2.0", Some("0.1.0")),
        )
        .unwrap();

        let active = install_root.join("active");
        assert!(is_link(&active));
        assert_eq!(
            fs::read_to_string(active.join(EXECUTABLE)).unwrap(),
            "0.2.0"
        );
        // Removing the old junction removed the link, not the version it pointed at.
        assert_eq!(
            fs::read_to_string(install_root.join("versions/0.1.0").join(EXECUTABLE)).unwrap(),
            "0.1.0"
        );
        assert_eq!(names(&install_root), ["active", "active.json", "versions"]);
        assert_eq!(names(&binary_directory), ["coforge-computer.cmd"]);
    }

    /// A real directory named `active` (never written by the Computer, but possible after manual
    /// repair) is removed and replaced by the junction; the versions are untouched.
    #[test]
    fn a_real_active_directory_is_replaced_by_the_junction() {
        let scratch = Scratch::new("junction-over-directory");
        let install_root = scratch.install_root();
        let binary_directory = scratch.0.join("bin");
        install_versions(&install_root, EXECUTABLE, &["0.1.0", "0.2.0"]);
        fs::create_dir_all(install_root.join("active").join("stale")).unwrap();
        fs::write(install_root.join("active").join(EXECUTABLE), "stale").unwrap();

        activate(
            &install_root,
            &binary_directory,
            TARGET,
            &state("0.2.0", None),
        )
        .unwrap();

        let active = install_root.join("active");
        assert!(is_link(&active));
        assert_eq!(
            fs::read_to_string(active.join(EXECUTABLE)).unwrap(),
            "0.2.0"
        );
        for version in ["0.1.0", "0.2.0"] {
            assert_eq!(
                fs::read_to_string(install_root.join("versions").join(version).join(EXECUTABLE))
                    .unwrap(),
                version
            );
        }
        assert_eq!(names(&install_root), ["active", "active.json", "versions"]);
    }
}

#[test]
fn emits_active_state() {
    // What the installer really writes, not a hand-built string: the product reads this file.
    let scratch = Scratch::new("emit");
    let install_root = scratch.install_root();
    write_active_state(&install_root, &state("0.2.0", Some("0.1.0"))).unwrap();

    let written = fs::read(install_root.join("active.json")).unwrap();
    let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("contract/rust");
    fs::create_dir_all(&directory).unwrap();
    fs::write(directory.join("active.v1.json"), written).unwrap();
}
