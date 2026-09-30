//! Why preparing a version failed. The variants are the failure classes the Computer's
//! `UpdateError` (packages/computer/src/updater.ts) reports, with the same code strings
//! (installer/contract/upgrade-error-codes.json), because a receipt carries the code.

use std::fmt;

#[derive(Debug, PartialEq, Eq)]
pub enum UpdateError {
    /// The release feed or a version string is unusable: unreachable, a bad status, or a pointer,
    /// manifest, or version that does not follow the feed's rules.
    FeedInvalid(String),
    /// Bytes on the feed or on disk do not match the identity recorded for them.
    IntegrityFailed(String),
    /// The manifest has no artifact for this machine's release target.
    UnsupportedTarget(String),
    /// A local file operation failed. The product raises the raw error and reports no code.
    Local(String),
}

impl UpdateError {
    /// The product's error code, or `None` for a failure it reports without one.
    pub fn code(&self) -> Option<&'static str> {
        match self {
            Self::FeedInvalid(_) => Some("UPDATE_FEED_INVALID"),
            Self::IntegrityFailed(_) => Some("UPDATE_INTEGRITY_FAILED"),
            Self::UnsupportedTarget(_) => Some("UPDATE_UNSUPPORTED_TARGET"),
            Self::Local(_) => None,
        }
    }

    pub fn message(&self) -> &str {
        match self {
            Self::FeedInvalid(message)
            | Self::IntegrityFailed(message)
            | Self::UnsupportedTarget(message)
            | Self::Local(message) => message,
        }
    }
}

impl fmt::Display for UpdateError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.message())
    }
}

impl std::error::Error for UpdateError {}

#[cfg(test)]
mod tests;
