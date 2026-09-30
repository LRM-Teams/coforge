//! The CoForge installer (`coforge-installer`): the separately released native binary that
//! owns every change to a CoForge Computer installation.
//!
//! So far it carries the verified-download plumbing, the machine mutation lock, installation
//! paths, the release version rule, the active version switch, the contract types shared with the
//! product, and everything that puts a release version into `versions/` (feed client, manifest
//! rules, version store); the install transaction around them is not here yet.

pub mod active;
pub mod contract;
pub mod digest;
pub mod feed;
pub mod fetch;
mod idle_timeout;
pub mod lock;
pub mod manifest;
pub mod paths;
pub mod prepare;
pub mod store;
pub mod update_error;
pub mod version;

#[cfg(test)]
mod test_support;
