//! SHA-256 identities: the byte size and lowercase hex digest the release manifest and
//! `installation.json` record for a file.

use std::fs::File;
use std::io::{self, Read};
use std::path::Path;

use sha2::{Digest, Sha256};

use crate::contract::ArtifactIdentity;

/// Lowercase hex of `bytes`.
pub fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(DIGITS[(byte >> 4) as usize] as char);
        out.push(DIGITS[(byte & 0x0f) as usize] as char);
    }
    out
}

/// The largest size the Computer can read back exactly: it holds sizes as JavaScript numbers.
const MAX_SAFE_SIZE: u64 = (1 << 53) - 1;

/// Whether `identity` could describe a file, as the Computer's `validIdentity` decides: a size it
/// can represent and a checksum of exactly 64 lowercase hex digits.
pub fn is_valid_identity(identity: &ArtifactIdentity) -> bool {
    identity.size <= MAX_SAFE_SIZE
        && identity.checksum.len() == 64
        && identity
            .checksum
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

pub fn measure_bytes(bytes: &[u8]) -> ArtifactIdentity {
    ArtifactIdentity {
        size: bytes.len() as u64,
        checksum: hex(&Sha256::digest(bytes)),
    }
}

/// Measures a file without reading it into memory.
pub fn measure_file(path: &Path) -> io::Result<ArtifactIdentity> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    let mut size = 0u64;
    loop {
        let read = match file.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => read,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        };
        hasher.update(&buffer[..read]);
        size += read as u64;
    }
    Ok(ArtifactIdentity {
        size,
        checksum: hex(&hasher.finalize()),
    })
}

#[cfg(test)]
mod tests;
