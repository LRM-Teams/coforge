//! The CoForge installer (`coforge-installer`): the separately released native binary that
//! owns every change to a CoForge Computer installation.
//!
//! So far it carries the verified-download plumbing, the machine mutation lock, installation
//! paths, the release version rule, and the contract types shared with the product; the install
//! transaction itself is not here yet.

pub mod contract;
pub mod fetch;
pub mod lock;
pub mod paths;
pub mod version;
