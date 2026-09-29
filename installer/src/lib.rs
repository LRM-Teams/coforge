//! The CoForge installer (`coforge-installer`): the separately released native binary that
//! owns every change to a CoForge Computer installation.
//!
//! So far it carries only the verified-download plumbing that later commands build on; the
//! install transaction itself is not here yet.

pub mod fetch;
