use std::fs;
use std::path::PathBuf;

use super::*;
use crate::contract::ReleaseVersions;

#[test]
fn agrees_with_the_computer_on_every_contract_case() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("contract/release-versions.json");
    let versions: ReleaseVersions =
        serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
    for case in versions.cases {
        assert_eq!(
            is_valid_release_version(&case.value),
            case.valid,
            "{:?}",
            case.value
        );
    }
}
