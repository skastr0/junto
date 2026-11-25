//! Local byte verification for release inputs: bounded, no-follow reads that
//! refuse a file which changes while it is read, then the signed descriptor and
//! the exact archive it names.

use std::fs::{File, Metadata, OpenOptions};
use std::io::{Read, Seek, SeekFrom};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::Path;

use rustix::fs::OFlags;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::error::{Error, Result, error};
use crate::release::{
    Archive, Descriptor, MAX_ARCHIVE_BYTES, MAX_METADATA_BYTES, archive_name, decode_signed_release,
};
use crate::trust::Trust;

const READ_CHUNK: usize = 128 * 1024;

fn open_regular(path: &Path, label: &str) -> Result<(File, Metadata)> {
    let initial = std::fs::symlink_metadata(path).map_err(|cause| match cause.kind() {
        std::io::ErrorKind::NotFound => {
            Error::new(format!("{label} must be a nonempty regular file"))
        }
        _ => Error::new(format!("{label} could not be read: {cause}")),
    })?;
    if !initial.is_file() || initial.file_type().is_symlink() || initial.len() < 1 {
        return error(format!("{label} must be a nonempty regular file"));
    }
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(OFlags::NOFOLLOW.bits() as i32)
        .open(path)
        .map_err(|cause| Error::new(format!("{label} could not be read: {cause}")))?;
    let before = file
        .metadata()
        .map_err(|cause| Error::new(format!("{label} could not be read: {cause}")))?;
    if !before.is_file()
        || before.dev() != initial.dev()
        || before.ino() != initial.ino()
        || before.len() < 1
    {
        return error(format!("{label} changed before it could be read"));
    }
    Ok((file, before))
}

fn unchanged(before: &Metadata, after: &Metadata) -> bool {
    before.len() == after.len()
        && before.mtime() == after.mtime()
        && before.mtime_nsec() == after.mtime_nsec()
        && before.ctime() == after.ctime()
        && before.ctime_nsec() == after.ctime_nsec()
}

fn read_exact_bounded(file: &mut File, size: u64, label: &str) -> Result<Vec<u8>> {
    let size_usize =
        usize::try_from(size).map_err(|_| Error::new(format!("{label} exceeds its size limit")))?;
    let mut bytes = vec![0_u8; size_usize];
    let mut offset = 0;
    while offset < size_usize {
        let read = file
            .read(&mut bytes[offset..])
            .map_err(|cause| Error::new(format!("{label} could not be read: {cause}")))?;
        if read == 0 {
            return error(format!("{label} changed while it was being read"));
        }
        offset += read;
    }
    Ok(bytes)
}

fn read_json(path: &Path, label: &str, maximum: u64) -> Result<(Value, u64, String)> {
    let (mut file, before) = open_regular(path, label)?;
    if before.len() > maximum {
        return error(format!("{label} exceeds its size limit"));
    }
    let bytes = read_exact_bounded(&mut file, before.len(), label)?;
    let after = file
        .metadata()
        .map_err(|cause| Error::new(format!("{label} could not be read: {cause}")))?;
    if !unchanged(&before, &after) {
        return error(format!("{label} changed while it was being read"));
    }
    let sha256: String = Sha256::digest(&bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    match String::from_utf8(bytes) {
        Ok(text) => match serde_json::from_str::<Value>(&text) {
            Ok(value) => Ok((value, before.len(), sha256)),
            Err(_) => error(format!("{label} is not valid UTF-8 JSON")),
        },
        Err(_) => error(format!("{label} is not valid UTF-8 JSON")),
    }
}

pub fn read_release_json(path: &Path) -> Result<Value> {
    read_json(path, "release metadata", MAX_METADATA_BYTES).map(|(value, _, _)| value)
}

/// The archive's bytes and digest, from a bounded streaming read.
pub fn fingerprint_file(path: &Path) -> Result<Archive> {
    let label = "release input";
    let (mut file, before) = open_regular(path, label)?;
    if before.len() > MAX_ARCHIVE_BYTES {
        return error(format!("{label} exceeds its size limit"));
    }
    let mut digest = Sha256::new();
    let mut buffer = vec![0_u8; READ_CHUNK];
    let mut observed = 0_u64;
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|cause| Error::new(format!("{label} could not be read: {cause}")))?;
        if read == 0 {
            break;
        }
        observed += read as u64;
        if observed > before.len() {
            return error(format!("{label} changed while it was being hashed"));
        }
        digest.update(&buffer[..read]);
    }
    let after = file
        .metadata()
        .map_err(|cause| Error::new(format!("{label} could not be read: {cause}")))?;
    if observed != before.len() || !unchanged(&before, &after) {
        return error(format!("{label} changed while it was being hashed"));
    }
    Ok(Archive {
        file: String::new(),
        path: String::new(),
        bytes: observed,
        sha256: digest
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
    })
}

fn basename(path: &Path) -> Option<&str> {
    path.file_name().and_then(|name| name.to_str())
}

#[derive(Debug)]
pub struct Verified {
    pub descriptor: Descriptor,
    pub archive: Archive,
}

/// The signed descriptor first, then the archive bytes it names. Nothing in the
/// archive is read, extracted or executed before this returns.
pub fn verify_release_files(
    release_path: &Path,
    archive_path: &Path,
    trust: &Trust,
    now_ms: i64,
) -> Result<Verified> {
    let value = read_release_json(release_path)?;
    let signed = decode_signed_release(&value)?;
    let descriptor = trust.verify(&signed, now_ms)?;
    let expected = archive_name(&descriptor.version)?;
    if basename(archive_path) != Some(expected.as_str()) {
        return error("release archive must use the canonical basename");
    }
    let archive = fingerprint_file(archive_path)?;
    if archive.bytes != descriptor.archive.bytes || archive.sha256 != descriptor.archive.sha256 {
        return error("local release bytes differ from the signed descriptor");
    }
    Ok(Verified {
        descriptor,
        archive,
    })
}

pub fn seal_file(file: &mut File) -> Result<()> {
    file.sync_all()
        .map_err(|cause| Error::new(cause.to_string()))?;
    let _ = file.seek(SeekFrom::Start(0));
    Ok(())
}
