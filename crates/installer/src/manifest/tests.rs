use std::fs;
use std::path::PathBuf;

use serde_json::{Value, json};

use super::*;

/// The Computer's own golden manifest: version 0.2.0, targets darwin-arm64 and windows-x64.
fn golden() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("contract/manifest.v2.json");
    serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
}

fn parse(value: &Value) -> Result<ReleaseManifest, UpdateError> {
    parse_release_manifest(value.to_string().as_bytes(), "0.2.0")
}

type Edit = fn(&mut Value);

fn rejected(edit: impl FnOnce(&mut Value)) -> String {
    let mut value = golden();
    edit(&mut value);
    match parse(&value) {
        Err(UpdateError::FeedInvalid(message)) => message,
        other => panic!("expected UPDATE_FEED_INVALID, got {other:?} for {value:#}"),
    }
}

#[test]
fn the_products_golden_manifest_is_accepted() {
    let manifest = parse(&golden()).unwrap();

    assert_eq!(manifest.version, "0.2.0");
    assert_eq!(manifest.photon_wasm.file, "photon_rs_bg.wasm");
    let windows = computer_artifact(&manifest, "windows-x64").unwrap();
    // The manifest names the executable without `.exe`; the target decides the on-disk name.
    assert_eq!(windows.binary, "coforge-computer");
    assert_eq!(windows.gzip.binary, "coforge-computer.gz");
}

#[test]
fn a_manifest_that_is_not_json_is_rejected() {
    let error = parse_release_manifest(b"{ nope", "0.2.0").unwrap_err();
    assert_eq!(
        error,
        UpdateError::FeedInvalid("manifest is not valid JSON".into())
    );
}

#[test]
fn a_manifest_of_another_schema_or_shape_is_rejected() {
    for (name, edit) in [
        (
            "schema 1",
            (|m: &mut Value| m["schema_version"] = json!(1)) as Edit,
        ),
        ("schema 3", |m| m["schema_version"] = json!(3)),
        ("schema as text", |m| m["schema_version"] = json!("2")),
        ("no version", |m| {
            m.as_object_mut().unwrap().remove("version");
        }),
        ("numeric version", |m| m["version"] = json!(2)),
        ("no commit", |m| {
            m.as_object_mut().unwrap().remove("commit");
        }),
        ("no build date", |m| {
            m.as_object_mut().unwrap().remove("buildDate");
        }),
        ("no platforms", |m| {
            m.as_object_mut().unwrap().remove("platforms");
        }),
        ("null platforms", |m| m["platforms"] = Value::Null),
        ("platforms as a list", |m| m["platforms"] = json!([])),
        ("no image library", |m| {
            m.as_object_mut().unwrap().remove("photonWasm");
        }),
        ("installer protocol as text", |m| {
            m["installer_protocol"] = json!("1")
        }),
    ] {
        assert_eq!(rejected(edit), "manifest schema is invalid", "{name}");
    }
}

#[test]
fn the_image_library_entry_is_pinned() {
    for (name, edit) in [
        (
            "another file name",
            (|m: &mut Value| m["photonWasm"]["file"] = json!("evil.wasm")) as Edit,
        ),
        ("a path", |m| {
            m["photonWasm"]["file"] = json!("../photon_rs_bg.wasm")
        }),
        ("no checksum", |m| {
            m["photonWasm"].as_object_mut().unwrap().remove("checksum");
        }),
        ("uppercase checksum", |m| {
            m["photonWasm"]["checksum"] = json!("C".repeat(64))
        }),
        ("short checksum", |m| {
            m["photonWasm"]["checksum"] = json!("abc")
        }),
        ("negative size", |m| m["photonWasm"]["size"] = json!(-1)),
        ("fractional size", |m| m["photonWasm"]["size"] = json!(1.5)),
        ("size beyond 2^53", |m| {
            m["photonWasm"]["size"] = json!(9_007_199_254_740_992u64)
        }),
    ] {
        assert_eq!(rejected(edit), "manifest schema is invalid", "{name}");
    }
}

#[test]
fn a_manifest_served_under_the_wrong_version_is_rejected() {
    let message = rejected(|m| m["version"] = json!("0.1.9"));
    assert_eq!(
        message,
        "manifest version 0.1.9 does not match requested version 0.2.0"
    );
}

#[test]
fn every_platform_entry_is_validated_not_only_the_one_installed() {
    for platform in ["darwin-arm64", "windows-x64"] {
        let message = rejected(|m| m["platforms"][platform]["daemon"] = json!({}));
        assert_eq!(
            message,
            format!("manifest platform entry for {platform} is invalid"),
            "an extra key beside `computer` in {platform}"
        );
    }
}

#[test]
fn a_platform_entry_has_exactly_the_computer_artifact_with_pinned_names() {
    let base = "darwin-arm64";
    for (name, edit) in [
        (
            "no computer",
            (|m: &mut Value| m["platforms"]["darwin-arm64"] = json!({})) as Edit,
        ),
        ("computer is not an object", |m| {
            m["platforms"]["darwin-arm64"]["computer"] = json!("x")
        }),
        ("entry is not an object", |m| {
            m["platforms"]["darwin-arm64"] = json!(null)
        }),
        ("executable name with .exe", |m| {
            m["platforms"]["darwin-arm64"]["computer"]["binary"] = json!("coforge-computer.exe")
        }),
        ("executable name is a path", |m| {
            m["platforms"]["darwin-arm64"]["computer"]["binary"] = json!("../coforge-computer")
        }),
        ("gzip name", |m| {
            m["platforms"]["darwin-arm64"]["computer"]["gzip"]["binary"] = json!("other.gz")
        }),
        ("no gzip", |m| {
            m["platforms"]["darwin-arm64"]["computer"]
                .as_object_mut()
                .unwrap()
                .remove("gzip");
        }),
        ("bad executable checksum", |m| {
            m["platforms"]["darwin-arm64"]["computer"]["checksum"] = json!("g".repeat(64))
        }),
        ("bad gzip checksum", |m| {
            m["platforms"]["darwin-arm64"]["computer"]["gzip"]["checksum"] = json!("A".repeat(64))
        }),
        ("bad gzip size", |m| {
            m["platforms"]["darwin-arm64"]["computer"]["gzip"]["size"] = json!(-5)
        }),
    ] {
        assert_eq!(
            rejected(edit),
            format!("manifest platform entry for {base} is invalid"),
            "{name}"
        );
    }
}

#[test]
fn fields_a_later_release_adds_are_ignored() {
    let mut value = golden();
    value["x_field_from_a_later_version"] = json!(true);
    value["photonWasm"]["x_later"] = json!(1);
    value["platforms"]["darwin-arm64"]["computer"]["x_later"] = json!(1);

    parse(&value).unwrap();
}

#[test]
fn a_target_the_manifest_lacks_is_unsupported() {
    let manifest = parse(&golden()).unwrap();

    let error = computer_artifact(&manifest, "linux-x64").unwrap_err();

    assert_eq!(
        error,
        UpdateError::UnsupportedTarget("manifest has no platform entry for linux-x64".into())
    );
}
