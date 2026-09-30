use std::fs;
use std::path::{Path, PathBuf};

use super::*;
use crate::contract::Paths;

fn contract() -> Paths {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("contract/paths.json");
    serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
}

/// The path as the exact string the Computer writes and reads. `PathBuf` equality compares by
/// component and hides doubled, trailing, and mixed separators, which is what these tests are
/// about, so nothing here compares paths as paths.
fn text(path: &Path) -> &str {
    path.to_str().expect("the contract's paths are UTF-8")
}

#[test]
fn resolves_every_contract_case_byte_for_byte_as_the_computer_does() {
    let cases = contract().cases;
    assert!(!cases.is_empty());
    for case in cases {
        let platform = Platform::from_contract_name(&case.platform)
            .unwrap_or_else(|| panic!("unknown platform {}", case.platform));
        let resolved = InstallPaths::resolve(
            platform,
            &case.home,
            case.environment.get("XDG_BIN_HOME").map(String::as_str),
        );
        assert_eq!(
            text(&resolved.install_root),
            case.install_root,
            "install_root of {case:?}"
        );
        assert_eq!(
            text(&resolved.state_directory),
            case.state_directory,
            "state_directory of {case:?}"
        );
        assert_eq!(
            text(&resolved.binary_directory),
            case.binary_directory,
            "binary_directory of {case:?}"
        );
    }
}

#[test]
fn the_contract_covers_the_homes_that_join_rewrites() {
    let cases = contract().cases;
    for (platform, home) in [
        ("linux", "/"),
        ("linux", "/home//example/"),
        ("linux", "/home/./example"),
        ("linux", "/home/example/../example"),
        ("linux", ""),
        ("darwin", "/Users/example/"),
        ("win32", "C:/Users/example"),
        ("win32", "C:\\Users\\example\\"),
        ("win32", "C:\\Users\\\\example"),
        ("win32", "\\\\server\\share\\example"),
        ("win32", "C:\\"),
        ("win32", ""),
    ] {
        assert!(
            cases
                .iter()
                .any(|case| case.platform == platform && case.home == home),
            "no {platform} case with home {home:?}"
        );
    }
}

#[test]
fn a_trailing_separator_on_the_home_directory_is_not_doubled() {
    let resolved = InstallPaths::resolve(Platform::Linux, "/home/example/", None);
    assert_eq!(
        text(&resolved.install_root),
        "/home/example/.coforge/computer/install"
    );
}

#[test]
fn an_absolute_xdg_bin_home_is_used_exactly_as_written() {
    let resolved = InstallPaths::resolve(Platform::Linux, "/home/example", Some("/opt//bin/"));
    assert_eq!(text(&resolved.binary_directory), "/opt//bin/");
}

#[test]
fn the_current_platform_has_a_contract_name() {
    let platform = Platform::current();
    assert_eq!(
        Platform::from_contract_name(platform.contract_name()),
        Some(platform)
    );
}
