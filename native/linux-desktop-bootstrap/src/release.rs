//! The signed alpha desktop descriptor, frozen: `junto/linux-desktop-release/v1`.
//!
//! Consumers: the release publisher and this bootstrap. Paths are derived from
//! the version, never supplied URLs. Signatures bind every descriptor field, so
//! decoding here is exact: an unknown, missing or differently typed field is a
//! refusal, not a default.

use serde::Serialize;
use serde_json::{Map, Value};

use crate::error::{Error, Result, error};

pub const RELEASE_SCHEMA: &str = "junto/linux-desktop-release/v1";
pub const MAX_ARCHIVE_BYTES: u64 = 300_000_000;
pub const MAX_EXPANDED_BYTES: u64 = 4_000_000_000;
pub const INSTALL_RESERVE_BYTES: u64 = 1_073_741_824;
pub const MAX_METADATA_BYTES: u64 = 65_536;
pub const CLOCK_SKEW_MS: i64 = 5 * 60 * 1_000;
pub const SIGNATURE_DOMAIN: &str = "Junto Linux desktop alpha release v1\n";
pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub os: &'static str,
    pub arch: &'static str,
    pub distribution: &'static str,
    pub distribution_version: &'static str,
    pub libc: &'static str,
    pub libc_version: &'static str,
}

impl Target {
    pub const PINNED: Target = Target {
        os: "linux",
        arch: "x64",
        distribution: "ubuntu",
        distribution_version: "24.04",
        libc: "glibc",
        libc_version: "2.39",
    };
}

/// Serialized field order is the signed wire order.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Archive {
    pub file: String,
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SigningTrust {
    pub algorithm: String,
    pub key_id: String,
    pub keyring_revision: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Descriptor {
    pub schema: String,
    pub product: String,
    pub channel: String,
    pub version: String,
    pub source_revision: String,
    pub created_at: String,
    pub target: Target,
    pub archive: Archive,
    pub trust: SigningTrust,
}

#[derive(Debug, Clone)]
pub struct SignedRelease {
    pub descriptor: Descriptor,
    pub signature: String,
}

fn exact<'a>(value: &'a Value, keys: &[&str], label: &str) -> Result<&'a Map<String, Value>> {
    let Some(object) = value.as_object() else {
        return error(format!("invalid {label}"));
    };
    if object.len() != keys.len() || keys.iter().any(|key| !object.contains_key(*key)) {
        return error(format!("unexpected {label} fields"));
    }
    Ok(object)
}

fn integer(value: Option<&Value>, minimum: u64, maximum: u64, label: &str) -> Result<u64> {
    match value.and_then(Value::as_u64) {
        Some(number) if number >= minimum && number <= maximum => Ok(number),
        _ => error(format!("invalid {label} bytes")),
    }
}

fn sha256(value: Option<&Value>, label: &str) -> Result<String> {
    match value.and_then(Value::as_str) {
        Some(text)
            if text.len() == 64
                && text
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)) =>
        {
            Ok(text.to_owned())
        }
        _ => error(format!("invalid {label} SHA256")),
    }
}

/// `X.Y.Z`, each part a canonical non-negative integer of at most nine digits.
pub fn version_parts(version: &str) -> Result<[u64; 3]> {
    let mut parts = [0_u64; 3];
    let mut count = 0;
    for part in version.split('.') {
        if count == 3 {
            return error("invalid Linux desktop version; expected X.Y.Z");
        }
        if part.is_empty() || part.len() > 9 || !part.bytes().all(|byte| byte.is_ascii_digit()) {
            return error("invalid Linux desktop version; expected X.Y.Z");
        }
        if part.len() > 1 && part.starts_with('0') {
            return error("invalid Linux desktop version; expected X.Y.Z");
        }
        parts[count] = part
            .parse::<u64>()
            .map_err(|_| Error::new("invalid Linux desktop version; expected X.Y.Z"))?;
        count += 1;
    }
    if count != 3 {
        return error("invalid Linux desktop version; expected X.Y.Z");
    }
    Ok(parts)
}

pub fn compare_versions(left: &str, right: &str) -> Result<std::cmp::Ordering> {
    let a = version_parts(left)?;
    let b = version_parts(right)?;
    Ok(a.cmp(&b))
}

pub fn archive_name(version: &str) -> Result<String> {
    version_parts(version)?;
    Ok(format!("junto-runtime-{version}-linux-x64.tar.gz"))
}

pub fn release_path(version: &str) -> Result<String> {
    version_parts(version)?;
    Ok(format!("/linux/x64/{version}/release.json"))
}

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let shifted_month = (month + 9) % 12;
    let day_of_year = (153 * shifted_month + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

fn is_leap(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap(year) => 29,
        2 => 28,
        _ => 0,
    }
}

/// The one accepted timestamp shape, as `new Date(value).toISOString() === value`
/// accepts it: UTC, milliseconds, a real calendar day.
pub fn timestamp_ms(text: &str) -> Option<i64> {
    let bytes = text.as_bytes();
    if bytes.len() != 24
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b'T'
        || bytes[13] != b':'
        || bytes[16] != b':'
        || bytes[19] != b'.'
        || bytes[23] != b'Z'
    {
        return None;
    }
    let digits = |range: std::ops::Range<usize>| -> Option<i64> {
        let mut value = 0_i64;
        for byte in &bytes[range] {
            if !byte.is_ascii_digit() {
                return None;
            }
            value = value * 10 + i64::from(byte - b'0');
        }
        Some(value)
    };
    let year = digits(0..4)?;
    let month = digits(5..7)?;
    let day = digits(8..10)?;
    let hour = digits(11..13)?;
    let minute = digits(14..16)?;
    let second = digits(17..19)?;
    let millis = digits(20..23)?;
    if !(1..=12).contains(&month)
        || day < 1
        || day > days_in_month(year, month)
        || hour > 23
        || minute > 59
        || second > 59
    {
        return None;
    }
    Some(
        (days_from_civil(year, month, day) * 86_400 + hour * 3_600 + minute * 60 + second) * 1_000
            + millis,
    )
}

fn stable_string(object: &Map<String, Value>, key: &str, message: &str) -> Result<String> {
    match object.get(key).and_then(Value::as_str) {
        Some(value) => Ok(value.to_owned()),
        None => error(message),
    }
}

pub fn decode_descriptor(value: &Value) -> Result<Descriptor> {
    let descriptor = exact(
        value,
        &[
            "schema",
            "product",
            "channel",
            "version",
            "sourceRevision",
            "createdAt",
            "target",
            "archive",
            "trust",
        ],
        "Linux desktop descriptor",
    )?;
    if descriptor.get("schema").and_then(Value::as_str) != Some(RELEASE_SCHEMA)
        || descriptor.get("product").and_then(Value::as_str) != Some("Junto")
        || descriptor.get("channel").and_then(Value::as_str) != Some("alpha")
    {
        return error("unsupported Linux desktop release identity");
    }
    let version = stable_string(
        descriptor,
        "version",
        "invalid Linux desktop version; expected X.Y.Z",
    )?;
    version_parts(&version)?;
    let source_revision = stable_string(
        descriptor,
        "sourceRevision",
        "invalid Linux desktop source revision",
    )?;
    if source_revision.len() != 40
        || !source_revision
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return error("invalid Linux desktop source revision");
    }
    let created_at = descriptor
        .get("createdAt")
        .ok_or_else(|| Error::new("invalid release creation timestamp"))?;
    let created_at = created_at
        .as_str()
        .filter(|text| timestamp_ms(text).is_some())
        .ok_or_else(|| Error::new("invalid release creation timestamp"))?
        .to_owned();

    let target = exact(
        descriptor.get("target").unwrap_or(&Value::Null),
        &[
            "os",
            "arch",
            "distribution",
            "distributionVersion",
            "libc",
            "libcVersion",
        ],
        "Linux desktop target",
    )?;
    let pinned = Target::PINNED;
    let expected = [
        ("os", pinned.os),
        ("arch", pinned.arch),
        ("distribution", pinned.distribution),
        ("distributionVersion", pinned.distribution_version),
        ("libc", pinned.libc),
        ("libcVersion", pinned.libc_version),
    ];
    for (key, expected) in expected {
        if target.get(key).and_then(Value::as_str) != Some(expected) {
            return error("unsupported Linux desktop target");
        }
    }

    let archive = exact(
        descriptor.get("archive").unwrap_or(&Value::Null),
        &["file", "path", "bytes", "sha256"],
        "Linux desktop archive",
    )?;
    let file = archive_name(&version)?;
    let archive_path = format!("/linux/x64/{file}");
    if archive.get("file").and_then(Value::as_str) != Some(file.as_str())
        || archive.get("path").and_then(Value::as_str) != Some(archive_path.as_str())
    {
        return error("Linux desktop archive path does not match version");
    }
    let archive_bytes = integer(archive.get("bytes"), 1, MAX_ARCHIVE_BYTES, "archive")?;
    let archive_sha256 = sha256(archive.get("sha256"), "archive")?;

    let trust = exact(
        descriptor.get("trust").unwrap_or(&Value::Null),
        &["algorithm", "keyId", "keyringRevision"],
        "Linux desktop trust",
    )?;
    let key_id = match trust.get("keyId").and_then(Value::as_str) {
        Some(value) if key_id_ok(value) => value.to_owned(),
        _ => return error("invalid Linux desktop signing key"),
    };
    if trust.get("algorithm").and_then(Value::as_str) != Some("ed25519") {
        return error("invalid Linux desktop signing key");
    }
    let keyring_revision = integer(
        trust.get("keyringRevision"),
        1,
        MAX_SAFE_INTEGER,
        "keyring revision",
    )?;

    Ok(Descriptor {
        schema: RELEASE_SCHEMA.to_owned(),
        product: "Junto".to_owned(),
        channel: "alpha".to_owned(),
        version,
        source_revision,
        created_at,
        target: pinned,
        archive: Archive {
            file,
            path: archive_path,
            bytes: archive_bytes,
            sha256: archive_sha256,
        },
        trust: SigningTrust {
            algorithm: "ed25519".to_owned(),
            key_id,
            keyring_revision,
        },
    })
}

pub fn key_id_ok(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.is_empty() || bytes.len() > 128 {
        return false;
    }
    let first = bytes[0];
    first.is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

/// Stable field order and a final newline are part of the signed wire contract.
pub fn canonical_descriptor(descriptor: &Descriptor) -> Result<String> {
    let mut text =
        serde_json::to_string_pretty(descriptor).map_err(|cause| Error::new(cause.to_string()))?;
    text.push('\n');
    Ok(text)
}

pub fn signature_ok(signature: &str) -> bool {
    let bytes = signature.as_bytes();
    if bytes.len() != 86 {
        return false;
    }
    let (body, last) = bytes.split_at(85);
    body.iter()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        && matches!(last, [b'A' | b'Q' | b'g' | b'w'])
}

pub fn decode_signed_release(value: &Value) -> Result<SignedRelease> {
    let envelope = exact(
        value,
        &["descriptor", "signature"],
        "Linux desktop signed release",
    )?;
    let signature = match envelope.get("signature").and_then(Value::as_str) {
        Some(signature) if signature_ok(signature) => signature.to_owned(),
        _ => return error("invalid canonical Ed25519 signature"),
    };
    let descriptor = decode_descriptor(envelope.get("descriptor").unwrap_or(&Value::Null))?;
    let envelope = SignedRelease {
        descriptor,
        signature,
    };
    let compact = serde_json::to_string(&serde_json::json!({
        "descriptor": &envelope.descriptor,
        "signature": &envelope.signature,
    }))
    .map_err(|cause| Error::new(cause.to_string()))?;
    if compact.len() as u64 > MAX_METADATA_BYTES {
        return error("Linux desktop release metadata is too large");
    }
    Ok(envelope)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_are_canonical() {
        assert_eq!(
            compare_versions("0.2.1", "0.2.2").unwrap(),
            std::cmp::Ordering::Less
        );
        assert_eq!(
            compare_versions("1.0.0", "1.0.0").unwrap(),
            std::cmp::Ordering::Equal
        );
        for bad in ["1.0", "1.0.0.0", "01.0.0", "1.0.x", "", "1.0.1234567890"] {
            assert!(version_parts(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn timestamps_are_exact() {
        assert_eq!(timestamp_ms("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(
            timestamp_ms("2026-01-01T00:00:00.000Z"),
            Some(1_767_225_600_000)
        );
        assert_eq!(
            timestamp_ms("2024-02-29T12:00:00.001Z"),
            Some(1_709_208_000_001)
        );
        for bad in [
            "2024-02-30T00:00:00.000Z",
            "2026-01-01T00:00:00Z",
            "2026-01-01T00:00:00.000+00:00",
            "2026-13-01T00:00:00.000Z",
        ] {
            assert_eq!(timestamp_ms(bad), None, "{bad}");
        }
    }
}
