use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use super::*;
use crate::contract::UpgradeErrorCodes;

fn contract_codes() -> BTreeMap<String, String> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("contract/upgrade-error-codes.json");
    let codes: UpgradeErrorCodes =
        serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
    codes.codes
}

#[test]
fn the_codes_are_the_ones_the_product_names() {
    let contract = contract_codes();
    for (key, error) in [
        (
            "UPDATE_FEED_INVALID",
            UpdateError::FeedInvalid(String::new()),
        ),
        (
            "UPDATE_INTEGRITY_FAILED",
            UpdateError::IntegrityFailed(String::new()),
        ),
        (
            "UPDATE_UNSUPPORTED_TARGET",
            UpdateError::UnsupportedTarget(String::new()),
        ),
    ] {
        assert_eq!(error.code(), Some(contract[key].as_str()), "{key}");
    }
}

#[test]
fn a_local_failure_has_no_product_code() {
    // The product reports a plain file-system error without an `errorCode`.
    assert_eq!(UpdateError::Local("disk full".into()).code(), None);
}

#[test]
fn the_message_is_what_display_prints() {
    let error = UpdateError::IntegrityFailed("downloaded artifact failed integrity".into());
    assert_eq!(error.message(), "downloaded artifact failed integrity");
    assert_eq!(error.to_string(), error.message());
}
