//! The shared signed-release fixture: the same bytes must be admitted or
//! refused by the Rust verifier exactly as the TypeScript verifier words it,
//! so the two cannot drift.

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use junto_desktop_bootstrap::error::Error;
use junto_desktop_bootstrap::release::{decode_signed_release, timestamp_ms};
use junto_desktop_bootstrap::trust::Trust;
use serde_json::Value;

fn fixture(path: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/fixtures/linux-release")
        .join(path)
}

fn load(path: &str) -> Value {
    let bytes = fs::read(fixture(path)).unwrap_or_else(|cause| panic!("{path}: {cause}"));
    serde_json::from_slice(&bytes).unwrap_or_else(|cause| panic!("{path}: {cause}"))
}

fn observed(value: &Value, trust: &Trust, now_ms: i64) -> Result<String, Error> {
    decode_signed_release(value)
        .and_then(|signed| trust.verify(&signed, now_ms))
        .map(|descriptor| descriptor.version)
}

#[test]
fn shared_release_fixtures() {
    let cases = load("cases.json");
    let mut trusts: BTreeMap<String, Trust> = BTreeMap::new();
    for case in cases.as_array().expect("cases") {
        let name = case["name"].as_str().expect("name");
        let file = case["file"].as_str().expect("file");
        let trust_file = case
            .get("trust")
            .and_then(Value::as_str)
            .unwrap_or("trust.json")
            .to_owned();
        let now = timestamp_ms(case["now"].as_str().expect("now")).expect("now");
        if !trusts.contains_key(&trust_file) {
            let trust = Trust::decode(&load(&trust_file))
                .unwrap_or_else(|cause| panic!("{trust_file}: {cause}"));
            trusts.insert(trust_file.clone(), trust);
        }
        let trust = &trusts[&trust_file];
        let expect = &case["expect"];
        let outcome = observed(&load(file), trust, now);
        if expect["ok"].as_bool() == Some(true) {
            let version = expect["version"].as_str().expect("version");
            assert_eq!(outcome.as_deref().ok(), Some(version), "{name}");
        } else {
            let message = expect["message"].as_str().expect("message");
            match outcome {
                Ok(version) => panic!("{name}: expected refusal {message:?}, verified {version}"),
                Err(cause) => assert_eq!(cause.message(), message, "{name}"),
            }
        }
    }
}

#[test]
fn embedded_trust_pins_the_shipped_keyring() {
    let trust = Trust::embedded().expect("embedded trust");
    assert_eq!(trust.identity().key_id, "junto-linux-2026a");
}
