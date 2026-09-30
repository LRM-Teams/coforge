use std::fs;

use super::*;
use crate::test_support::Scratch;

#[test]
fn a_known_input_has_its_published_sha256() {
    // FIPS 180-4 test vector for "abc".
    assert_eq!(
        measure_bytes(b"abc"),
        ArtifactIdentity {
            size: 3,
            checksum: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad".into(),
        }
    );
}

#[test]
fn the_empty_input_has_the_empty_digest() {
    assert_eq!(
        measure_bytes(b"").checksum,
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
}

#[test]
fn a_file_measures_the_same_as_its_bytes() {
    let scratch = Scratch::new("digest-file");
    let bytes = b"coforge".repeat(100_000);
    let path = scratch.path().join("payload");
    fs::write(&path, &bytes).unwrap();

    assert_eq!(measure_file(&path).unwrap(), measure_bytes(&bytes));
}

#[test]
fn a_missing_file_is_an_error() {
    let scratch = Scratch::new("digest-missing");
    assert!(measure_file(&scratch.path().join("absent")).is_err());
}

fn identity(size: u64, checksum: &str) -> ArtifactIdentity {
    ArtifactIdentity {
        size,
        checksum: checksum.into(),
    }
}

#[test]
fn an_identity_needs_a_lowercase_sha256_and_a_size_the_product_can_represent() {
    let good = "0123456789abcdef".repeat(4);
    assert!(is_valid_identity(&identity(0, &good)));
    // The product reads sizes as JavaScript numbers: 2^53 - 1 is the last safe integer.
    assert!(is_valid_identity(&identity(9_007_199_254_740_991, &good)));
    assert!(!is_valid_identity(&identity(9_007_199_254_740_992, &good)));
    assert!(!is_valid_identity(&identity(1, &good.to_uppercase())));
    assert!(!is_valid_identity(&identity(1, &good[1..])));
    assert!(!is_valid_identity(&identity(1, &format!("{good}0"))));
    assert!(!is_valid_identity(&identity(
        1,
        &format!("{}g", &good[1..])
    )));
    assert!(!is_valid_identity(&identity(1, "")));
    // A trailing newline is not part of a checksum.
    assert!(!is_valid_identity(&identity(
        1,
        &format!("{}\n", &good[1..])
    )));
}
