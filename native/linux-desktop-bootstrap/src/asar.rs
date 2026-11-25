//! The packaged runtime identity inside `resources/app.asar`, read as fixed
//! members of a bounded ASAR: the version, the source revision and the build
//! identity must match the signed release and each other.

use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom};
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;

use rustix::fs::OFlags;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::error::{Error, Result, error};

const MAX_HEADER_BYTES: u64 = 16 * 1024 * 1024;
const MAX_MAIN_BYTES: u64 = 128 * 1024 * 1024;
const MAX_PACKAGE_BYTES: u64 = 1024 * 1024;
const MAX_PROVENANCE_BYTES: u64 = 65_536;
const PROVENANCE_PATH: &str = "out/package-runtime-provenance.json";
const MAIN_PATH: &str = "out/main/index.js";
const MARKER_OPEN: &[u8] = b"/* JUNTO_RUNTIME_BUILD_IDENTITY:";
const MARKER_CLOSE: &[u8] = b" */";

fn record<'a>(value: &'a Value, label: &str) -> Result<&'a Map<String, Value>> {
    value
        .as_object()
        .ok_or_else(|| Error::new(format!("Invalid packaged {label}")))
}

fn uuid_ok(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    let groups = [(0, 8), (9, 4), (14, 4), (19, 4), (24, 12)];
    if bytes[8] != b'-' || bytes[13] != b'-' || bytes[18] != b'-' || bytes[23] != b'-' {
        return false;
    }
    let lower = |byte: u8| byte.to_ascii_lowercase();
    if !groups.iter().all(|(start, length)| {
        bytes[*start..*start + *length]
            .iter()
            .all(|byte| lower(*byte).is_ascii_hexdigit())
    }) {
        return false;
    }
    matches!(lower(bytes[14]), b'1'..=b'8') && matches!(lower(bytes[19]), b'8' | b'9' | b'a' | b'b')
}

fn hex64(value: Option<&Value>) -> bool {
    value.and_then(Value::as_str).is_some_and(|text| {
        text.len() == 64
            && text
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

struct Asar {
    file: File,
    archive_bytes: u64,
    data_start: u64,
    header: Value,
}

impl Asar {
    fn open(path: &Path) -> Result<Asar> {
        let mut file = OpenOptions::new()
            .read(true)
            .custom_flags(OFlags::NOFOLLOW.bits() as i32)
            .open(path)
            .map_err(|_| Error::new("Packaged update ASAR is not a regular archive"))?;
        let stat = file
            .metadata()
            .map_err(|_| Error::new("Packaged update ASAR is not a regular archive"))?;
        if !stat.is_file() || stat.len() < 16 {
            return error("Packaged update ASAR is not a regular archive");
        }
        let archive_bytes = stat.len();
        let mut prefix = [0_u8; 8];
        file.read_exact(&mut prefix)
            .map_err(|_| Error::new("Packaged update ASAR header is malformed"))?;
        if u32::from_le_bytes(prefix[0..4].try_into().unwrap_or([0; 4])) != 4 {
            return error("Packaged update ASAR header is malformed");
        }
        let header_bytes = u64::from(u32::from_le_bytes(
            prefix[4..8].try_into().unwrap_or([0; 4]),
        ));
        if !(8..=MAX_HEADER_BYTES).contains(&header_bytes)
            || header_bytes > archive_bytes.saturating_sub(8)
        {
            return error("Packaged update ASAR header exceeds bounds");
        }
        // The header is a Pickle: its own 4-byte payload size, then a length-
        // prefixed JSON string, padded to four bytes.
        let mut header = vec![
            0_u8;
            usize::try_from(header_bytes).map_err(|_| Error::new(
                "Packaged update ASAR header exceeds bounds"
            ))?
        ];
        file.read_exact(&mut header)
            .map_err(|_| Error::new("Packaged update ASAR header is malformed"))?;
        if header.len() < 8 {
            return error("Packaged update ASAR header is malformed");
        }
        let json_len = u64::from(u32::from_le_bytes(
            header[4..8].try_into().unwrap_or([0; 4]),
        ));
        if json_len < 2 || json_len + 8 > header_bytes {
            return error("Packaged update ASAR header is malformed");
        }
        let json_len = usize::try_from(json_len)
            .map_err(|_| Error::new("Packaged update ASAR header is malformed"))?;
        let header: Value = serde_json::from_slice(&header[8..8 + json_len])
            .map_err(|_| Error::new("Packaged update ASAR header is malformed"))?;
        Ok(Asar {
            file,
            archive_bytes,
            data_start: 8 + header_bytes,
            header,
        })
    }

    fn entry(&self, path: &str, label: &str) -> Result<&Map<String, Value>> {
        let mut current = self
            .header
            .get("files")
            .and_then(Value::as_object)
            .ok_or_else(|| Error::new("Packaged update ASAR header is malformed"))?;
        let mut pieces = path.split('/').peekable();
        while let Some(piece) = pieces.next() {
            let bounded = || {
                Error::new(format!(
                    "Packaged update identity {label} is not a bounded packed file"
                ))
            };
            let next = current
                .get(piece)
                .and_then(Value::as_object)
                .ok_or_else(bounded)?;
            if next.contains_key("link")
                || next.get("unpacked").and_then(Value::as_bool) == Some(true)
            {
                return Err(bounded());
            }
            if pieces.peek().is_none() {
                return Ok(next);
            }
            // A directory entry carries its children under `files`.
            current = next
                .get("files")
                .and_then(Value::as_object)
                .ok_or_else(bounded)?;
        }
        error("Packaged update ASAR header is malformed")
    }

    fn directory(&self, path: &str) -> Result<()> {
        let entry = self.entry(path, "directory")?;
        match entry.get("files") {
            Some(Value::Object(_)) => Ok(()),
            _ => error("Packaged update identity directory is a link or not a directory"),
        }
    }

    fn read(&mut self, path: &str, maximum: u64) -> Result<Vec<u8>> {
        let entry = self.entry(path, "member")?.clone();
        if entry.contains_key("files")
            || entry.contains_key("link")
            || entry.get("unpacked").and_then(Value::as_bool) == Some(true)
        {
            return error("Packaged update identity member is not a bounded packed file");
        }
        let size = entry.get("size").and_then(Value::as_u64);
        let offset = match entry.get("offset").and_then(Value::as_str) {
            Some(text) if !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit()) => {
                text.parse::<u64>().ok()
            }
            _ => None,
        };
        let (Some(size), Some(offset)) = (size, offset) else {
            return error("Packaged update identity member is not a bounded packed file");
        };
        if size < 1 || size > maximum {
            return error("Packaged update identity member is not a bounded packed file");
        }
        if offset
            .checked_add(size)
            .is_none_or(|end| end > self.archive_bytes - (self.data_start - 8) - 8)
        {
            return error("Packaged update identity member is outside the archive");
        }
        let mut bytes = vec![
            0_u8;
            usize::try_from(size).map_err(|_| Error::new(
                "Packaged update identity member is outside the archive"
            ))?
        ];
        self.file
            .seek(SeekFrom::Start(self.data_start + offset))
            .map_err(|_| Error::new("Packaged update identity member is outside the archive"))?;
        self.file
            .read_exact(&mut bytes)
            .map_err(|_| Error::new("Packaged update identity member size mismatch"))?;
        Ok(bytes)
    }
}

fn markers(main: &[u8]) -> Result<Vec<&[u8]>> {
    let mut found = Vec::new();
    let mut index = 0;
    while let Some(position) = find(&main[index..], MARKER_OPEN) {
        let start = index + position + MARKER_OPEN.len();
        let Some(end) = find(&main[start..], MARKER_CLOSE) else {
            break;
        };
        found.push(&main[start..start + end]);
        index = start + end + MARKER_CLOSE.len();
    }
    Ok(found)
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

/// Inspect fixed packed members only; never trust the header's declared shape.
pub fn admit(asar_path: &Path, version: &str, source_revision: &str) -> Result<()> {
    let mut asar = Asar::open(asar_path)?;
    asar.directory("out")?;
    asar.directory("out/main")?;
    let package = serde_json::from_slice::<Value>(&asar.read("package.json", MAX_PACKAGE_BYTES)?)
        .map_err(|_| Error::new("Invalid packaged package metadata"))?;
    let package = record(&package, "package metadata")?;
    let provenance =
        serde_json::from_slice::<Value>(&asar.read(PROVENANCE_PATH, MAX_PROVENANCE_BYTES)?)
            .map_err(|_| Error::new("Invalid packaged runtime provenance"))?;
    let receipt = record(&provenance, "runtime provenance")?;
    let build = record(
        receipt.get("buildIdentity").unwrap_or(&Value::Null),
        "build identity",
    )?;
    let payload = record(
        receipt.get("payload").unwrap_or(&Value::Null),
        "runtime payload identity",
    )?;
    let build_keys: Vec<&String> = build.keys().collect();
    if package.get("version").and_then(Value::as_str) != Some(version)
        || receipt.get("schema").and_then(Value::as_str)
            != Some("junto/package-runtime-provenance/v2")
        || receipt.get("product").and_then(Value::as_str) != Some("Junto")
        || receipt.get("runtime").and_then(Value::as_str) != Some("electron-main")
        || receipt.get("appVersion").and_then(Value::as_str) != Some(version)
        || receipt.get("sourceCommit").and_then(Value::as_str) != Some(source_revision)
        || build.get("schema").and_then(Value::as_str) != Some("junto/runtime-build-identity/v1")
        || build.get("runtime").and_then(Value::as_str) != Some("electron-main")
        || build.get("sourceCommit").and_then(Value::as_str) != Some(source_revision)
        || build
            .get("cohortNonce")
            .and_then(Value::as_str)
            .is_none_or(|nonce| !uuid_ok(nonce))
        || build_keys.len() != 4
        || payload.get("packagedPath").and_then(Value::as_str) != Some(MAIN_PATH)
        || !hex64(payload.get("sha256"))
    {
        return error(
            "Packaged update version or source identity does not match the signed release",
        );
    }
    let main = asar.read(MAIN_PATH, MAX_MAIN_BYTES)?;
    let main_sha256: String = Sha256::digest(&main)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    if payload.get("bytes").and_then(Value::as_u64) != Some(main.len() as u64)
        || payload.get("sha256").and_then(Value::as_str) != Some(&main_sha256)
    {
        return error("Packaged update main payload does not match its build receipt");
    }
    let found = markers(&main)?;
    if found.len() != 1 || found[0].len() > 4_096 {
        return error("Packaged update main payload must contain one bounded build identity");
    }
    use base64::Engine as _;
    let embedded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(found[0])
        .map_err(|_| Error::new("Invalid packaged embedded build identity"))?;
    let embedded: Value = serde_json::from_slice(&embedded)
        .map_err(|_| Error::new("Invalid packaged embedded build identity"))?;
    let embedded = record(&embedded, "embedded build identity")?;
    if embedded.len() != 4
        || build
            .iter()
            .any(|(key, value)| embedded.get(key) != Some(value))
    {
        return error("Packaged update main build identity does not match its receipt");
    }
    Ok(())
}
