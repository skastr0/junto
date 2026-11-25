//! The release archive: snapshot and authenticate first, then admit every
//! member before a single byte reaches the install tree.
//!
//! Only regular files and directories are permitted, only under the canonical
//! root, with explicit parents, bounded sizes and no links, specials, traversal
//! or duplicate paths.

use std::collections::BTreeMap;
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use flate2::read::GzDecoder;
use rustix::fs::OFlags;
use sha2::{Digest, Sha256};
use tar::EntryType;

use crate::error::{Error, Result, error};
use crate::release::{Archive, MAX_ARCHIVE_BYTES, MAX_EXPANDED_BYTES};

const MAX_FILE_BYTES: u64 = 1_000_000_000;
const MAX_MEMBERS: usize = 100_000;
const MAX_PATH_BYTES: usize = 1_024;
const MAX_DEPTH: usize = 64;
const COPY_CHUNK: usize = 128 * 1024;
const UMASK: u32 = 0o022;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    File,
    Directory,
}

#[derive(Debug, Clone, Copy)]
struct Member {
    kind: Kind,
    mode: u32,
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Snapshot and authenticate before a single archive member can reach disk.
pub fn snapshot(archive_path: &Path, snapshot_path: &Path, expected: &Archive) -> Result<()> {
    if expected.bytes == 0 || expected.bytes > MAX_ARCHIVE_BYTES {
        return error("Linux desktop archive size is outside the supported bound");
    }
    let mut source = OpenOptions::new()
        .read(true)
        .custom_flags(OFlags::NOFOLLOW.bits() as i32)
        .open(archive_path)
        .map_err(|cause| Error::new(format!("Linux desktop archive could not be read: {cause}")))?;
    let before = source
        .metadata()
        .map_err(|cause| Error::new(cause.to_string()))?;
    if !before.is_file() || before.nlink() != 1 || before.len() != expected.bytes {
        return error("Linux desktop archive is not a regular file of the signed size");
    }
    let mut destination = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(OFlags::NOFOLLOW.bits() as i32)
        .open(snapshot_path)
        .map_err(|cause| {
            Error::new(format!(
                "Linux desktop archive snapshot could not be written: {cause}"
            ))
        })?;
    let mut digest = Sha256::new();
    let mut buffer = vec![0_u8; COPY_CHUNK];
    let mut bytes = 0_u64;
    loop {
        let read = source
            .read(&mut buffer)
            .map_err(|cause| Error::new(cause.to_string()))?;
        if read == 0 {
            break;
        }
        bytes += read as u64;
        if bytes > expected.bytes {
            return error("Linux desktop archive grew while being authenticated");
        }
        digest.update(&buffer[..read]);
        destination.write_all(&buffer[..read]).map_err(|cause| {
            Error::new(format!(
                "Linux desktop archive snapshot write made no progress: {cause}"
            ))
        })?;
    }
    if bytes != expected.bytes || hex(&digest.finalize()) != expected.sha256 {
        return error("Linux desktop archive checksum does not match the signed release");
    }
    destination
        .sync_all()
        .map_err(|cause| Error::new(cause.to_string()))?;
    Ok(())
}

fn member_name(path: &Path, kind: Kind) -> Result<String> {
    let text = path
        .to_str()
        .ok_or_else(|| Error::new("Linux desktop archive contains an unsafe or duplicate path"))?;
    let mut name = text;
    if let Some(stripped) = name.strip_prefix("./") {
        name = stripped;
    }
    if kind == Kind::Directory && name.ends_with('/') {
        name = &name[..name.len() - 1];
    }
    Ok(name.to_owned())
}

fn inspect(snapshot_path: &Path, root: &str) -> Result<BTreeMap<String, Member>> {
    let file = File::open(snapshot_path).map_err(|cause| Error::new(cause.to_string()))?;
    let mut archive = tar::Archive::new(GzDecoder::new(file));
    let mut members: BTreeMap<String, Member> = BTreeMap::new();
    let mut expanded_bytes = 0_u64;
    for entry in archive
        .entries()
        .map_err(|cause| Error::new(cause.to_string()))?
    {
        let entry = entry.map_err(|cause| Error::new(cause.to_string()))?;
        let kind = match entry.header().entry_type() {
            EntryType::Regular => Kind::File,
            EntryType::Directory => Kind::Directory,
            _ => return error("Linux desktop archive permits regular files and directories only"),
        };
        if entry
            .link_name()
            .map_err(|cause| Error::new(cause.to_string()))?
            .is_some()
        {
            return error("Linux desktop archive contains an unsafe mode or link");
        }
        let name = member_name(
            &entry
                .path()
                .map_err(|cause| Error::new(cause.to_string()))?,
            kind,
        )?;
        let pieces: Vec<&str> = name.split('/').collect();
        if name.len() > MAX_PATH_BYTES
            || pieces.len() > MAX_DEPTH
            || name
                .bytes()
                .any(|byte| byte == b'\\' || byte < 0x20 || byte == 0x7f)
            || pieces
                .iter()
                .any(|piece| piece.is_empty() || *piece == "." || *piece == "..")
            || pieces.first() != Some(&root)
            || members.contains_key(&name)
        {
            return error("Linux desktop archive contains an unsafe or duplicate path");
        }
        let mode = entry
            .header()
            .mode()
            .map_err(|cause| Error::new(cause.to_string()))?;
        let size = entry.size();
        if (mode & 0o7022) != 0 || (mode & 0o400) == 0 {
            return error("Linux desktop archive contains an unsafe mode or link");
        }
        if size > MAX_FILE_BYTES || (kind == Kind::Directory && size != 0) {
            return error("Linux desktop archive contains an invalid member size");
        }
        if kind == Kind::Directory && (mode & 0o100) == 0 {
            return error("Linux desktop archive directory is not traversable");
        }
        if name == root && kind != Kind::Directory {
            return error("Linux desktop archive root is not a directory");
        }
        expanded_bytes += size;
        if members.len() >= MAX_MEMBERS || expanded_bytes > MAX_EXPANDED_BYTES {
            return error("Linux desktop archive exceeds member limits");
        }
        members.insert(
            name,
            Member {
                kind,
                mode: mode & 0o777,
            },
        );
    }
    if members.get(root).map(|member| member.kind) != Some(Kind::Directory) {
        return error("Linux desktop archive is missing its expected root directory");
    }
    for name in members.keys() {
        let pieces: Vec<&str> = name.split('/').collect();
        for index in 1..pieces.len() {
            let parent = pieces[..index].join("/");
            if members.get(&parent).map(|member| member.kind) != Some(Kind::Directory) {
                return error("Linux desktop archive is missing an explicit parent directory");
            }
        }
    }
    match members.get(&format!("{root}/junto")) {
        Some(member) if member.kind == Kind::File && (member.mode & 0o111) != 0 => {}
        _ => return error("Linux desktop archive is missing its executable junto"),
    }
    Ok(members)
}

fn ensure_directory(path: &Path) -> Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => Ok(()),
        Ok(_) => error("Linux desktop archive contains an unsafe mode or link"),
        Err(cause) => error(format!(
            "Linux desktop archive could not be extracted: {cause}"
        )),
    }
}

fn extract_members(snapshot_path: &Path, extracted: &Path, root: &str) -> Result<()> {
    std::fs::create_dir(extracted).map_err(|cause| Error::new(cause.to_string()))?;
    std::fs::set_permissions(extracted, std::fs::Permissions::from_mode(0o700))
        .map_err(|cause| Error::new(cause.to_string()))?;
    let file = File::open(snapshot_path).map_err(|cause| Error::new(cause.to_string()))?;
    let mut archive = tar::Archive::new(GzDecoder::new(file));
    let mut directories: Vec<(PathBuf, u32)> = Vec::new();
    for entry in archive
        .entries()
        .map_err(|cause| Error::new(cause.to_string()))?
    {
        let mut entry = entry.map_err(|cause| Error::new(cause.to_string()))?;
        let kind = match entry.header().entry_type() {
            EntryType::Regular => Kind::File,
            EntryType::Directory => Kind::Directory,
            _ => return error("Linux desktop archive permits regular files and directories only"),
        };
        let name = member_name(
            &entry
                .path()
                .map_err(|cause| Error::new(cause.to_string()))?,
            kind,
        )?;
        let mode = entry
            .header()
            .mode()
            .map_err(|cause| Error::new(cause.to_string()))?
            & 0o777
            & !UMASK;
        let relative = match name.strip_prefix(root) {
            Some("") => continue,
            Some(rest) => rest.strip_prefix('/').unwrap_or(rest),
            None => return error("Linux desktop archive contains an unsafe or duplicate path"),
        };
        let target = extracted.join(relative);
        match kind {
            Kind::Directory => {
                std::fs::create_dir(&target).map_err(|cause| {
                    Error::new(format!(
                        "Linux desktop archive could not be extracted: {cause}"
                    ))
                })?;
                directories.push((target, mode));
            }
            Kind::File => {
                let parent = target.parent().ok_or_else(|| {
                    Error::new("Linux desktop archive contains an unsafe or duplicate path")
                })?;
                ensure_directory(parent)?;
                let mut output = OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .mode(0o600)
                    .custom_flags(OFlags::NOFOLLOW.bits() as i32)
                    .open(&target)
                    .map_err(|cause| {
                        Error::new(format!(
                            "Linux desktop archive could not be extracted: {cause}"
                        ))
                    })?;
                let expected = entry.size();
                let mut written = 0_u64;
                let mut buffer = vec![0_u8; COPY_CHUNK];
                while written < expected {
                    let remaining = usize::try_from((expected - written).min(COPY_CHUNK as u64))
                        .unwrap_or(COPY_CHUNK);
                    let read = entry
                        .read(&mut buffer[..remaining])
                        .map_err(|cause| Error::new(cause.to_string()))?;
                    if read == 0 {
                        return error("Linux desktop archive is truncated");
                    }
                    output
                        .write_all(&buffer[..read])
                        .map_err(|cause| Error::new(cause.to_string()))?;
                    written += read as u64;
                }
                output
                    .sync_all()
                    .map_err(|cause| Error::new(cause.to_string()))?;
                std::fs::set_permissions(&target, std::fs::Permissions::from_mode(mode))
                    .map_err(|cause| Error::new(cause.to_string()))?;
            }
        }
    }
    // Directory modes may not be applied before their children exist.
    for (path, mode) in directories.into_iter().rev() {
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode))
            .map_err(|cause| Error::new(cause.to_string()))?;
    }
    Ok(())
}

/// The caller owns an empty private attempt directory; no subprocess is used.
pub fn extract(
    archive_path: &Path,
    attempt_root: &Path,
    expected: &Archive,
    version: &str,
) -> Result<PathBuf> {
    let snapshot_path = attempt_root.join("archive.tar.gz");
    snapshot(archive_path, &snapshot_path, expected)?;
    let root = format!("junto-runtime-{version}-linux-x64");
    inspect(&snapshot_path, &root)?;
    let extracted = attempt_root.join("extracted");
    extract_members(&snapshot_path, &extracted, &root)?;
    Ok(extracted)
}
