//! Where an installation lives on this machine, resolved exactly as the Computer resolves it
//! (packages/computer/src/paths.ts; crates/installer/contract/paths.json).
//!
//! The home directory is `std::env::home_dir`, which since Rust 1.85 follows the same rule as the
//! Computer's `os.homedir()`: `HOME` on Unix (else the account's passwd entry), `USERPROFILE` on
//! Windows (else the profile directory).

use std::path::PathBuf;

mod node_path;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Linux,
    Darwin,
    Windows,
}

impl Platform {
    pub fn current() -> Self {
        if cfg!(windows) {
            Self::Windows
        } else if cfg!(target_os = "macos") {
            Self::Darwin
        } else {
            Self::Linux
        }
    }

    /// The platform's name in the contract, which is Node's `process.platform`.
    pub fn contract_name(self) -> &'static str {
        match self {
            Self::Linux => "linux",
            Self::Darwin => "darwin",
            Self::Windows => "win32",
        }
    }

    pub fn from_contract_name(name: &str) -> Option<Self> {
        match name {
            "linux" => Some(Self::Linux),
            "darwin" => Some(Self::Darwin),
            "win32" => Some(Self::Windows),
            _ => None,
        }
    }

    /// `path.posix.join` or `path.win32.join`, the function the Computer uses on this platform.
    fn join(self, parts: &[&str]) -> String {
        match self {
            Self::Windows => node_path::win32_join(parts),
            Self::Linux | Self::Darwin => node_path::posix_join(parts),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstallPaths {
    /// `versions/`, `active`, `active.json`, the lock, and receipts.
    pub install_root: PathBuf,
    /// The supervisor's state directory.
    pub state_directory: PathBuf,
    /// Where the `coforge-computer` shim goes: the one path that must be on the user's PATH.
    pub binary_directory: PathBuf,
}

impl InstallPaths {
    /// This machine's paths, or `None` when no home directory can be determined.
    pub fn current() -> Option<Self> {
        let home = std::env::home_dir()?;
        let xdg_bin_home = std::env::var("XDG_BIN_HOME").ok();
        Some(Self::resolve(
            Platform::current(),
            &home.to_string_lossy(),
            xdg_bin_home.as_deref(),
        ))
    }

    /// The paths under `home` on `platform`. Linux and macOS honour an absolute `XDG_BIN_HOME`
    /// for the shim, which is usually already on PATH; Windows has no such convention.
    pub fn resolve(platform: Platform, home: &str, xdg_bin_home: Option<&str>) -> Self {
        let join = |parts: &[&str]| {
            let mut all = vec![home];
            all.extend_from_slice(parts);
            PathBuf::from(platform.join(&all))
        };
        let binary_directory = match (platform, xdg_bin_home) {
            (Platform::Windows, _) => join(&[".coforge", "computer", "bin"]),
            (_, Some(configured)) if configured.starts_with('/') => PathBuf::from(configured),
            _ => join(&[".local", "bin"]),
        };
        Self {
            install_root: join(&[".coforge", "computer", "install"]),
            state_directory: join(&[".coforge", "daemon"]),
            binary_directory,
        }
    }
}

#[cfg(test)]
mod tests;
