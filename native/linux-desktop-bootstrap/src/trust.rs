//! The embedded release trust: a keyring, a pinned digest of that keyring, a
//! pinned key id and fingerprint, and one Ed25519 signature over the domain
//! string plus the canonical descriptor.
//!
//! The pins are compiled in. Nothing on the command line, in the environment or
//! beside the downloaded archive can replace them.

use ed25519_dalek::{Signature, VerifyingKey};
use serde::Serialize;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::error::{Error, Result, error};
use crate::release::{
    CLOCK_SKEW_MS, Descriptor, MAX_SAFE_INTEGER, SIGNATURE_DOMAIN, SignedRelease,
    canonical_descriptor, key_id_ok, timestamp_ms,
};

const EMBEDDED_KEYRING: &str = include_str!("../../../build/linux/release-keyring.json");
const EMBEDDED_POLICY: &str = include_str!("../../../build/linux/release-trust-policy.json");
const MAX_PUBLIC_KEY_PEM_BYTES: usize = 8_192;
const MAX_KEYS: usize = 128;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Key {
    key_id: String,
    algorithm: &'static str,
    public_key_pem: String,
    fingerprint_sha256: String,
    status: &'static str,
    valid_from: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    signing_ends_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    revoked_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    superseded_by: Option<String>,
    #[serde(skip)]
    key: [u8; 32],
}

#[derive(Debug, Clone, Serialize)]
struct Keyring {
    schema: &'static str,
    revision: u64,
    keys: Vec<Key>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Policy {
    schema: &'static str,
    state: &'static str,
    trusted_keyring_revision: u64,
    trusted_keyring_sha256: String,
    trusted_key_id: String,
    trusted_key_fingerprint_sha256: String,
}

#[derive(Debug, Clone)]
pub struct Trust {
    keyring: Keyring,
    policy: Policy,
}

pub struct Identity {
    pub keyring_revision: u64,
    pub keyring_sha256: String,
    pub key_id: String,
    pub key_fingerprint_sha256: String,
}

fn exact<'a>(value: &'a Value, keys: &[&str], label: &str) -> Result<&'a Map<String, Value>> {
    let Some(object) = value.as_object() else {
        return error(format!("invalid {label} fields"));
    };
    if object.len() != keys.len() || keys.iter().any(|key| !object.contains_key(*key)) {
        return error(format!("invalid {label} fields"));
    }
    Ok(object)
}

fn hex_sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn digest(value: Option<&Value>) -> Result<String> {
    match value.and_then(Value::as_str) {
        Some(text)
            if text.len() == 64
                && text
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)) =>
        {
            Ok(text.to_owned())
        }
        _ => error("invalid release trust SHA256"),
    }
}

fn timestamp(value: Option<&Value>) -> Result<String> {
    match value
        .and_then(Value::as_str)
        .filter(|text| timestamp_ms(text).is_some())
    {
        Some(text) => Ok(text.to_owned()),
        None => error("invalid release key timestamp"),
    }
}

fn revision(value: Option<&Value>) -> Result<u64> {
    match value.and_then(Value::as_u64) {
        Some(number) if (1..=MAX_SAFE_INTEGER).contains(&number) => Ok(number),
        _ => error("invalid release keyring revision"),
    }
}

fn key_id(value: Option<&Value>) -> Result<String> {
    match value.and_then(Value::as_str).filter(|text| key_id_ok(text)) {
        Some(text) => Ok(text.to_owned()),
        None => error("invalid release key id"),
    }
}

/// One PEM body: the canonical SPKI for Ed25519, `302a300506032b6570032100` and
/// the 32-byte key. The fingerprint is the SHA-256 of the whole DER.
fn parse_public_key(pem: &str) -> Result<([u8; 32], String)> {
    const BEGIN: &str = "-----BEGIN PUBLIC KEY-----";
    const END: &str = "-----END PUBLIC KEY-----";
    let trimmed = pem.trim();
    let Some(body) = trimmed
        .strip_prefix(BEGIN)
        .and_then(|rest| rest.strip_suffix(END))
    else {
        return error("invalid release public key");
    };
    let encoded: String = body
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect();
    use base64::Engine as _;
    let der = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| Error::new("invalid release public key"))?;
    const PREFIX: [u8; 12] = [
        0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
    ];
    if der.len() != 44 || der[..12] != PREFIX {
        return error("invalid release public key");
    }
    let mut key = [0_u8; 32];
    key.copy_from_slice(&der[12..]);
    Ok((key, hex_sha256(&der)))
}

fn decode_key(value: &Value) -> Result<Key> {
    let Some(object) = value.as_object() else {
        return error("invalid release key");
    };
    let optionals: Vec<&str> = ["signingEndsAt", "revokedAt", "supersededBy"]
        .into_iter()
        .filter(|field| object.contains_key(*field))
        .collect();
    let mut keys = vec![
        "keyId",
        "algorithm",
        "publicKeyPem",
        "fingerprintSha256",
        "status",
        "validFrom",
    ];
    keys.extend(optionals.iter().copied());
    let key = exact(value, &keys, "release key")?;
    let public_key_pem = match key.get("publicKeyPem").and_then(Value::as_str) {
        Some(text) if text.len() <= MAX_PUBLIC_KEY_PEM_BYTES => text.to_owned(),
        _ => return error("invalid release public key"),
    };
    let (key_bytes, computed_fingerprint) = parse_public_key(&public_key_pem)?;
    if key.get("algorithm").and_then(Value::as_str) != Some("ed25519") {
        return error("invalid release public key");
    }
    let fingerprint_sha256 = digest(key.get("fingerprintSha256"))?;
    if fingerprint_sha256 != computed_fingerprint {
        return error("release key fingerprint mismatch");
    }
    let status = match key.get("status").and_then(Value::as_str) {
        Some("active") => "active",
        Some("retired") => "retired",
        Some("revoked") => "revoked",
        _ => return error("invalid release key status"),
    };
    let valid_from = timestamp(key.get("validFrom"))?;
    let signing_ends_at = optionals
        .contains(&"signingEndsAt")
        .then(|| timestamp(key.get("signingEndsAt")))
        .transpose()?;
    let revoked_at = optionals
        .contains(&"revokedAt")
        .then(|| timestamp(key.get("revokedAt")))
        .transpose()?;
    let superseded_by = optionals
        .contains(&"supersededBy")
        .then(|| key_id(key.get("supersededBy")))
        .transpose()?;
    let valid_from_ms = timestamp_ms(&valid_from).unwrap_or(0);
    if (status == "retired" && signing_ends_at.is_none())
        || (status == "revoked" && revoked_at.is_none())
        || signing_ends_at
            .as_deref()
            .and_then(timestamp_ms)
            .is_some_and(|end| end <= valid_from_ms)
        || revoked_at
            .as_deref()
            .and_then(timestamp_ms)
            .is_some_and(|revoked| revoked <= valid_from_ms)
    {
        return error("incoherent release key lifecycle");
    }
    Ok(Key {
        key_id: key_id(key.get("keyId"))?,
        algorithm: "ed25519",
        public_key_pem,
        fingerprint_sha256,
        status,
        valid_from,
        signing_ends_at,
        revoked_at,
        superseded_by,
        key: key_bytes,
    })
}

fn decode_keyring(value: &Value) -> Result<Keyring> {
    let keyring = exact(value, &["schema", "revision", "keys"], "release keyring")?;
    if keyring.get("schema").and_then(Value::as_str) != Some("junto/linux-release-keyring/v1") {
        return error("unsupported release keyring");
    }
    let Some(entries) = keyring.get("keys").and_then(Value::as_array) else {
        return error("unsupported release keyring");
    };
    if entries.is_empty() || entries.len() > MAX_KEYS {
        return error("unsupported release keyring");
    }
    let keys = entries.iter().map(decode_key).collect::<Result<Vec<_>>>()?;
    let mut ids = std::collections::BTreeSet::new();
    if keys.iter().any(|key| !ids.insert(key.key_id.as_str())) {
        return error("invalid release key rotation");
    }
    if keys.iter().any(|key| {
        key.superseded_by
            .as_deref()
            .is_some_and(|next| next == key.key_id || !ids.contains(next))
    }) {
        return error("invalid release key rotation");
    }
    Ok(Keyring {
        schema: "junto/linux-release-keyring/v1",
        revision: revision(keyring.get("revision"))?,
        keys,
    })
}

fn keyring_sha256(keyring: &Keyring) -> Result<String> {
    let mut text =
        serde_json::to_string_pretty(keyring).map_err(|cause| Error::new(cause.to_string()))?;
    text.push('\n');
    Ok(hex_sha256(text.as_bytes()))
}

fn decode_policy(value: &Value) -> Result<Policy> {
    let policy = exact(
        value,
        &[
            "schema",
            "state",
            "trustedKeyringRevision",
            "trustedKeyringSha256",
            "trustedKeyId",
            "trustedKeyFingerprintSha256",
        ],
        "release trust policy",
    )?;
    if policy.get("schema").and_then(Value::as_str) != Some("junto/linux-release-trust-policy/v1")
        || policy.get("state").and_then(Value::as_str) != Some("configured")
    {
        return error("Linux desktop release trust is not configured");
    }
    Ok(Policy {
        schema: "junto/linux-release-trust-policy/v1",
        state: "configured",
        trusted_keyring_revision: revision(policy.get("trustedKeyringRevision"))?,
        trusted_keyring_sha256: digest(policy.get("trustedKeyringSha256"))?,
        trusted_key_id: key_id(policy.get("trustedKeyId"))?,
        trusted_key_fingerprint_sha256: digest(policy.get("trustedKeyFingerprintSha256"))?,
    })
}

impl Trust {
    pub fn decode(value: &Value) -> Result<Trust> {
        let trust = exact(value, &["keyring", "policy"], "Linux desktop release trust")?;
        let keyring = decode_keyring(trust.get("keyring").unwrap_or(&Value::Null))?;
        let policy = decode_policy(trust.get("policy").unwrap_or(&Value::Null))?;
        if keyring.revision != policy.trusted_keyring_revision
            || keyring_sha256(&keyring)? != policy.trusted_keyring_sha256
        {
            return error("release keyring does not match independently pinned trust");
        }
        let selected = keyring
            .keys
            .iter()
            .find(|key| key.key_id == policy.trusted_key_id);
        match selected {
            Some(key) if key.fingerprint_sha256 == policy.trusted_key_fingerprint_sha256 => {}
            _ => return error("release key does not match independently pinned trust"),
        }
        Ok(Trust { keyring, policy })
    }

    pub fn embedded() -> Result<Trust> {
        let keyring: Value = serde_json::from_str(EMBEDDED_KEYRING)
            .map_err(|cause| Error::new(cause.to_string()))?;
        let policy: Value =
            serde_json::from_str(EMBEDDED_POLICY).map_err(|cause| Error::new(cause.to_string()))?;
        Trust::decode(&serde_json::json!({ "keyring": keyring, "policy": policy }))
    }

    pub fn identity(&self) -> Identity {
        Identity {
            keyring_revision: self.keyring.revision,
            keyring_sha256: self.policy.trusted_keyring_sha256.clone(),
            key_id: self.policy.trusted_key_id.clone(),
            key_fingerprint_sha256: self.policy.trusted_key_fingerprint_sha256.clone(),
        }
    }

    /// The only admission: pinned trust, an authorized key, the signed canonical
    /// bytes, and a creation time that is neither in the future nor outside the
    /// key's signing window.
    pub fn verify(&self, signed: &SignedRelease, now_ms: i64) -> Result<Descriptor> {
        let descriptor = &signed.descriptor;
        if descriptor.trust.key_id != self.policy.trusted_key_id
            || descriptor.trust.keyring_revision != self.keyring.revision
        {
            return error("Linux desktop descriptor does not match pinned signing trust");
        }
        let Some(key) = self
            .keyring
            .keys
            .iter()
            .find(|key| key.key_id == descriptor.trust.key_id)
        else {
            return error("Linux desktop descriptor does not match pinned signing trust");
        };
        if key.status == "revoked" || key.revoked_at.is_some() {
            return error("Linux desktop signing key is revoked");
        }
        let created = timestamp_ms(&descriptor.created_at)
            .ok_or_else(|| Error::new("invalid release creation timestamp"))?;
        let valid_from = timestamp_ms(&key.valid_from).unwrap_or(0);
        if created < valid_from
            || key
                .signing_ends_at
                .as_deref()
                .and_then(timestamp_ms)
                .is_some_and(|end| created > end)
        {
            return error("Linux desktop release was signed outside the key authorization window");
        }
        use base64::Engine as _;
        let signature_bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(&signed.signature)
            .map_err(|_| Error::new("invalid canonical Ed25519 signature"))?;
        let signature = Signature::from_slice(&signature_bytes)
            .map_err(|_| Error::new("invalid canonical Ed25519 signature"))?;
        let verifying = VerifyingKey::from_bytes(&key.key)
            .map_err(|_| Error::new("invalid release public key"))?;
        let mut message = String::from(SIGNATURE_DOMAIN);
        message.push_str(&canonical_descriptor(descriptor)?);
        if verifying
            .verify_strict(message.as_bytes(), &signature)
            .is_err()
        {
            return error("Linux desktop release signature verification failed");
        }
        if created > now_ms + CLOCK_SKEW_MS {
            return error("Linux desktop release creation is in the future");
        }
        Ok(descriptor.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_trust_loads_and_pins_itself() {
        let trust = Trust::embedded().expect("embedded trust");
        let identity = trust.identity();
        assert_eq!(identity.keyring_revision, 1);
        assert_eq!(identity.key_id, "junto-linux-2026a");
        assert_eq!(
            identity.keyring_sha256,
            "d57438aa4b63ad5c0d1f1f58975fe1de18324f32d4776c53357dd4419c2f330c"
        );
        assert_eq!(
            identity.key_fingerprint_sha256,
            "3111af1bb9934cec983f0a871f302a4a74e51314d0496135433ca3dc2f9ac4a9"
        );
    }
}
