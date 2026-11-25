//! The rootless, owner-local install: layout, limits, staging, the allocation
//! ledger the app's updater later reads, and the create-only activation.
//!
//! A first install is the only mode here. It refuses an existing managed
//! launcher, never replaces foreign files, and never touches product state.

use std::collections::BTreeMap;
use std::fs::{File, Metadata, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use rustix::fs::OFlags;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::archive;
use crate::asar;
use crate::error::{ActivationError, Error, Result, error};
use crate::release::{INSTALL_RESERVE_BYTES, MAX_ARCHIVE_BYTES, MAX_EXPANDED_BYTES};
use crate::verify::Verified;

pub const STORAGE_DIR: &str = ".install-storage";
const ALLOCATION_SCHEMA: &str = "junto/linux-install-allocation/v1";
const ATTEMPT_PREFIX: &str = ".stage-";
const QUARANTINE_PREFIX: &str = ".quarantine-";
const MAX_RECORD_BYTES: usize = 1_048_576;
const MAX_WALK_ENTRIES: usize = 100_000;
const LAYOUT: [&str; 6] = [
    ".local",
    ".local/opt",
    ".local/opt/junto-alpha",
    ".local/bin",
    ".local/share",
    ".local/share/applications",
];
const LAUNCHER_HEADER: &str = "# Junto managed Linux desktop launcher";

fn no_follow() -> i32 {
    OFlags::NOFOLLOW.bits() as i32
}

fn directory_flags() -> i32 {
    (OFlags::NOFOLLOW | OFlags::DIRECTORY).bits() as i32
}

pub fn require_ordinary_user() -> Result<()> {
    if rustix::process::getuid().as_raw() == 0 || rustix::process::geteuid().as_raw() == 0 {
        return error("Linux desktop installation must run as an ordinary user without elevation");
    }
    Ok(())
}

fn owned(metadata: &Metadata) -> bool {
    metadata.uid() == rustix::process::getuid().as_raw()
}

fn require_owned_directory(path: &Path) -> Result<Metadata> {
    let metadata = std::fs::symlink_metadata(path).map_err(|cause| {
        Error::new(format!(
            "Linux desktop install directory is not owner-controlled: {cause}"
        ))
    })?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || !owned(&metadata)
        || (metadata.mode() & 0o022) != 0
    {
        return error("Linux desktop install directory is not owner-controlled");
    }
    Ok(metadata)
}

fn ensure_owned_directory(path: &Path) -> Result<()> {
    match std::fs::create_dir(path) {
        Ok(()) => {}
        Err(cause) if cause.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(cause) => {
            return error(format!(
                "Linux desktop install directory could not be created: {cause}"
            ));
        }
    }
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
        .map_err(|cause| Error::new(cause.to_string()))?;
    require_owned_directory(path)?;
    Ok(())
}

fn sync_directory(path: &Path) -> Result<()> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(directory_flags())
        .open(path)
        .map_err(|cause| Error::new(cause.to_string()))?;
    file.sync_all()
        .map_err(|cause| Error::new(cause.to_string()))?;
    Ok(())
}

fn exists(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok()
}

fn real_dir(path: &Path) -> Result<PathBuf> {
    let canonical = std::fs::canonicalize(path).map_err(|cause| {
        Error::new(format!(
            "Linux desktop install directory is not owner-controlled: {cause}"
        ))
    })?;
    require_owned_directory(&canonical)?;
    Ok(canonical)
}

pub fn resolve_install_home(home: Option<&Path>) -> Result<PathBuf> {
    let home = match home {
        Some(home) => home.to_path_buf(),
        None => PathBuf::from(std::env::var_os("HOME").ok_or_else(|| {
            Error::new("Linux desktop install home must be an absolute safe path")
        })?),
    };
    let text = home.to_string_lossy();
    if !home.is_absolute() || text.bytes().any(|byte| byte < 0x20 || byte == 0x7f) {
        return error("Linux desktop install home must be an absolute safe path");
    }
    require_owned_directory(&home)?;
    real_dir(&home)
}

fn layout_paths(home: &Path) -> impl Iterator<Item = PathBuf> + '_ {
    LAYOUT.iter().map(move |relative| home.join(relative))
}

fn install_root(home: &Path) -> PathBuf {
    home.join(".local/opt/junto-alpha")
}

fn launcher_path(home: &Path) -> PathBuf {
    home.join(".local/bin/junto-desktop")
}

fn desktop_path(home: &Path) -> PathBuf {
    home.join(".local/share/applications/junto.desktop")
}

fn shell_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn launcher_body(root: &Path, generation: &str) -> String {
    format!(
        "#!/bin/sh\n{LAUNCHER_HEADER}\n# generation: {generation}\nexec {} \"$@\"\n",
        shell_literal(&root.join(generation).join("junto").to_string_lossy())
    )
}

fn desktop_body(home: &Path) -> String {
    let executable = launcher_path(home)
        .to_string_lossy()
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('`', "\\`")
        .replace('$', "\\$")
        .replace('%', "%%");
    format!(
        "[Desktop Entry]\nType=Application\nName=Junto\nComment=Junto desktop\nExec=\"{executable}\" %U\nTerminal=false\nCategories=Development;\nStartupWMClass=junto\n"
    )
}

struct OwnedFile {
    body: String,
    metadata: Metadata,
}

fn read_owned_file(path: &Path) -> Result<Option<OwnedFile>> {
    let file = match OpenOptions::new()
        .read(true)
        .custom_flags(no_follow())
        .open(path)
    {
        Ok(file) => file,
        Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(cause) => {
            return error(format!(
                "Linux desktop activation file could not be read: {cause}"
            ));
        }
    };
    let metadata = file
        .metadata()
        .map_err(|cause| Error::new(cause.to_string()))?;
    if !metadata.is_file()
        || !owned(&metadata)
        || (metadata.mode() & 0o022) != 0
        || metadata.len() > 16_384
    {
        return error("Linux desktop activation file is not an owned regular file");
    }
    let mut bytes = Vec::new();
    let mut handle = file;
    handle
        .read_to_end(&mut bytes)
        .map_err(|cause| Error::new(cause.to_string()))?;
    let body = String::from_utf8(bytes)
        .map_err(|_| Error::new("Linux desktop activation file is not an owned regular file"))?;
    Ok(Some(OwnedFile { body, metadata }))
}

fn generation_ok(name: &str) -> bool {
    let Some((version, sha)) = name.rsplit_once('-') else {
        return false;
    };
    crate::release::version_parts(version).is_ok()
        && sha.len() == 64
        && sha
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// A launcher this bootstrap may act on: its exact body names a generation under
/// this root, and it is executable. Anything else is foreign and refused.
fn managed_launcher_present(home: &Path, root: &Path) -> Result<bool> {
    let Some(file) = read_owned_file(&launcher_path(home))? else {
        return Ok(false);
    };
    let generation = file
        .body
        .lines()
        .nth(2)
        .and_then(|line| line.strip_prefix("# generation: "))
        .map(str::to_owned);
    let Some(generation) = generation else {
        return error("Refusing to replace an unrelated Linux desktop launcher");
    };
    if !generation_ok(&generation)
        || file.body != launcher_body(root, &generation)
        || (file.metadata.mode() & 0o111) == 0
    {
        return error("Refusing to replace an unrelated Linux desktop launcher");
    }
    Ok(true)
}

fn require_managed_desktop(home: &Path) -> Result<()> {
    match read_owned_file(&desktop_path(home))? {
        Some(file) if file.body != desktop_body(home) => {
            error("Refusing to replace an unrelated desktop entry")
        }
        _ => Ok(()),
    }
}

/// Create-only CLI precheck: inspect existing paths without making directories.
pub fn first_install_available(home: Option<&Path>) -> Result<PathBuf> {
    require_ordinary_user()?;
    let home = resolve_install_home(home)?;
    for path in layout_paths(&home) {
        if exists(&path) {
            require_owned_directory(&path)?;
        }
    }
    if exists(&launcher_path(&home)) {
        return error("First install refuses an existing desktop launcher");
    }
    require_managed_desktop(&home)?;
    Ok(home)
}

fn ensure_install_layout(home: &Path) -> Result<PathBuf> {
    for relative in LAYOUT {
        ensure_owned_directory(&home.join(relative))?;
    }
    Ok(install_root(home))
}

fn require_install_layout(home: &Path) -> Result<()> {
    require_owned_directory(home)?;
    for relative in LAYOUT {
        require_owned_directory(&home.join(relative))?;
    }
    Ok(())
}

fn random_bytes(length: usize) -> Vec<u8> {
    let mut bytes = vec![0_u8; length];
    if let Ok(mut source) = File::open("/dev/urandom")
        && source.read_exact(&mut bytes).is_ok()
    {
        return bytes;
    }
    // Never fall back to a predictable name; the caller refuses.
    bytes
}

fn uuid_v4() -> String {
    let mut bytes = random_bytes(16);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

fn mkdtemp(root: &Path) -> Result<PathBuf> {
    const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    for _ in 0..64 {
        let suffix: String = random_bytes(6)
            .into_iter()
            .map(|byte| ALPHABET[usize::from(byte) % ALPHABET.len()] as char)
            .collect();
        let path = root.join(format!("{ATTEMPT_PREFIX}{suffix}"));
        match std::fs::create_dir(&path) {
            Ok(()) => {
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))
                    .map_err(|cause| Error::new(cause.to_string()))?;
                return Ok(path);
            }
            Err(cause) if cause.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(cause) => {
                return error(format!(
                    "Linux desktop install attempt could not be created: {cause}"
                ));
            }
        }
    }
    error("Linux desktop install attempt could not be created")
}

#[derive(Debug, Clone, Copy, Serialize)]
struct Identity {
    dev: u64,
    ino: u64,
}

impl Identity {
    fn of(metadata: &Metadata) -> Identity {
        Identity {
            dev: metadata.dev(),
            ino: metadata.ino(),
        }
    }

    fn same(self, other: Identity) -> bool {
        self.dev == other.dev && self.ino == other.ino
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Allocation<'a> {
    schema: &'static str,
    kind: &'a str,
    basename: &'a str,
    operation_id: String,
    root: Identity,
    tree: Identity,
    uid: u32,
    phase: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    archive_sha256: Option<&'a str>,
}

fn allocations_dir(root: &Path) -> PathBuf {
    root.join(STORAGE_DIR).join("allocations")
}

fn ensure_storage_dir(root: &Path) -> Result<()> {
    ensure_owned_directory(&root.join(STORAGE_DIR))?;
    ensure_owned_directory(&allocations_dir(root))?;
    Ok(())
}

struct Lease {
    #[cfg(target_os = "linux")]
    _listener: std::os::unix::net::UnixListener,
}

fn acquire_lease(root: &Path) -> Result<Lease> {
    let metadata = require_owned_directory(root)?;
    let root_identity = Identity::of(&metadata);
    #[cfg(target_os = "linux")]
    {
        use std::os::linux::net::SocketAddrExt;
        let mut hasher = Sha256::new();
        hasher.update(format!("{}:{}", root_identity.dev, root_identity.ino));
        let name = format!(
            "junto-linux-install-{}",
            hasher
                .finalize()
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        );
        let address = std::os::unix::net::SocketAddr::from_abstract_name(name.as_bytes())
            .map_err(|_| Error::new("Linux install mutation lease unavailable"))?;
        let listener = std::os::unix::net::UnixListener::bind_addr(&address)
            .map_err(|_| Error::new("Linux install mutation lease unavailable"))?;
        Ok(Lease {
            _listener: listener,
        })
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = root_identity;
        error("Linux install mutation leases are Linux-only")
    }
}

fn write_allocation(root: &Path, record: &Allocation<'_>) -> Result<()> {
    ensure_storage_dir(root)?;
    let path = allocations_dir(root).join(format!("{}.json", record.basename));
    let mut body = serde_json::to_string(record).map_err(|cause| Error::new(cause.to_string()))?;
    body.push('\n');
    if body.len() > MAX_RECORD_BYTES {
        return error("Linux install allocation record exceeds its byte limit");
    }
    let temporary = path.with_file_name(format!("{}.{}.tmp", record.basename, record.operation_id));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(no_follow())
        .open(&temporary)
        .map_err(|cause| Error::new(cause.to_string()))?;
    file.write_all(body.as_bytes())
        .map_err(|cause| Error::new(cause.to_string()))?;
    file.set_permissions(std::fs::Permissions::from_mode(0o600))
        .map_err(|cause| Error::new(cause.to_string()))?;
    file.sync_all()
        .map_err(|cause| Error::new(cause.to_string()))?;
    std::fs::rename(&temporary, &path).map_err(|cause| Error::new(cause.to_string()))?;
    sync_directory(&allocations_dir(root))?;
    Ok(())
}

fn read_allocation(root: &Path, root_identity: Identity, name: &str) -> Option<Value> {
    let path = allocations_dir(root).join(format!("{name}.json"));
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(no_follow())
        .open(path)
        .ok()?;
    let metadata = file.metadata().ok()?;
    if !metadata.is_file()
        || !owned(&metadata)
        || (metadata.mode() & 0o022) != 0
        || metadata.len() > MAX_RECORD_BYTES as u64
    {
        return None;
    }
    let mut text = String::new();
    file.read_to_string(&mut text).ok()?;
    let record: Value = serde_json::from_str(&text).ok()?;
    let object = record.as_object()?;
    if object.get("schema").and_then(Value::as_str) != Some(ALLOCATION_SCHEMA)
        || object.get("basename").and_then(Value::as_str) != Some(name)
        || object.get("root").and_then(Value::as_object).is_none()
        || object.get("tree").and_then(Value::as_object).is_none()
        || !["generation", "attempt", "quarantine"]
            .contains(&object.get("kind").and_then(Value::as_str).unwrap_or(""))
        || !["allocated", "admitted", "retiring"]
            .contains(&object.get("phase").and_then(Value::as_str).unwrap_or(""))
    {
        return None;
    }
    let record_root = object.get("root")?;
    if record_root.get("dev").and_then(Value::as_u64) != Some(root_identity.dev)
        || record_root.get("ino").and_then(Value::as_u64) != Some(root_identity.ino)
    {
        return None;
    }
    Some(record)
}

fn remove_allocation(root: &Path, name: &str) {
    let _ = std::fs::remove_file(allocations_dir(root).join(format!("{name}.json")));
}

fn tree_size(path: &Path, expected_dev: u64, seen: &mut usize) -> Result<()> {
    let metadata =
        std::fs::symlink_metadata(path).map_err(|cause| Error::new(cause.to_string()))?;
    if metadata.dev() != expected_dev {
        return error("Linux install tree crossed a filesystem boundary");
    }
    if metadata.file_type().is_symlink() {
        return error("Linux desktop generation contains a link or special file");
    }
    *seen += 1;
    if *seen > MAX_WALK_ENTRIES {
        return error("Linux install tree exceeds member limits");
    }
    if metadata.is_dir() {
        for entry in std::fs::read_dir(path).map_err(|cause| Error::new(cause.to_string()))? {
            let entry = entry.map_err(|cause| Error::new(cause.to_string()))?;
            tree_size(&entry.path(), expected_dev, seen)?;
        }
        return Ok(());
    }
    if !metadata.is_file() || !owned(&metadata) || metadata.nlink() != 1 {
        return error("Linux desktop generation contains an unsafe file");
    }
    Ok(())
}

fn retire_tree(root: &Path, root_identity: Identity, name: &str, identity: Identity) -> Result<()> {
    let path = root.join(name);
    let metadata = require_owned_directory(&path)?;
    if !Identity::of(&metadata).same(identity) {
        return error("Linux desktop install attempt changed filesystem identity");
    }
    let mut seen = 0;
    tree_size(&path, metadata.dev(), &mut seen)?;
    let operation_id = uuid_v4();
    let quarantine = root.join(format!("{QUARANTINE_PREFIX}{operation_id}"));
    std::fs::create_dir(&quarantine).map_err(|cause| Error::new(cause.to_string()))?;
    std::fs::set_permissions(&quarantine, std::fs::Permissions::from_mode(0o700))
        .map_err(|cause| Error::new(cause.to_string()))?;
    let quarantine_identity = Identity::of(&require_owned_directory(&quarantine)?);
    let uid = require_owned_directory(&quarantine)?.uid();
    write_allocation(
        root,
        &Allocation {
            schema: ALLOCATION_SCHEMA,
            kind: "quarantine",
            basename: quarantine
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or_default(),
            operation_id: operation_id.clone(),
            root: root_identity,
            tree: quarantine_identity,
            uid,
            phase: "retiring",
            version: None,
            archive_sha256: None,
        },
    )?;
    let payload = quarantine.join("payload");
    std::fs::rename(&path, &payload).map_err(|cause| Error::new(cause.to_string()))?;
    sync_directory(root)?;
    sync_directory(&quarantine)?;
    let moved = require_owned_directory(&payload)?;
    if !Identity::of(&moved).same(identity) {
        return error("Linux install quarantine changed filesystem identity");
    }
    std::fs::remove_dir_all(&payload).map_err(|cause| Error::new(cause.to_string()))?;
    std::fs::remove_dir_all(&quarantine).map_err(|cause| Error::new(cause.to_string()))?;
    remove_allocation(root, name);
    remove_allocation(
        root,
        quarantine
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default(),
    );
    sync_directory(root)?;
    Ok(())
}

/// Retire only what this root's own ledger proves abandoned: attempts, sieved
/// quarantines, and generations that were allocated but never admitted.
fn collect(root: &Path, root_identity: Identity) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    let mut names: Vec<String> = entries
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| entry.file_name().to_str().map(str::to_owned))
        .collect();
    names.sort();
    for name in names {
        if name == STORAGE_DIR {
            continue;
        }
        let path = root.join(&name);
        let Ok(metadata) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            continue;
        }
        let Some(record) = read_allocation(root, root_identity, &name) else {
            continue;
        };
        let Some(tree) = record.get("tree").and_then(Value::as_object) else {
            continue;
        };
        if tree.get("dev").and_then(Value::as_u64) != Some(metadata.dev())
            || tree.get("ino").and_then(Value::as_u64) != Some(metadata.ino())
        {
            continue;
        }
        let kind = record
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let phase = record
            .get("phase")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let is_attempt = name.starts_with(ATTEMPT_PREFIX);
        let is_quarantine = name.starts_with(QUARANTINE_PREFIX);
        let abandoned = (is_attempt && kind == "attempt")
            || (generation_ok(&name) && kind == "generation" && phase == "allocated");
        if is_quarantine && kind == "quarantine" {
            let payload = path.join("payload");
            if exists(&payload) {
                let _ = std::fs::remove_dir_all(&payload);
            }
            let _ = std::fs::remove_dir_all(&path);
            remove_allocation(root, &name);
            continue;
        }
        if !abandoned {
            continue;
        }
        let identity = Identity::of(&metadata);
        let _ = retire_tree(root, root_identity, &name, identity);
    }
}

fn available_bytes(path: &Path) -> Option<u64> {
    rustix::fs::statvfs(path)
        .ok()
        .map(|info| info.f_bavail.saturating_mul(info.f_bsize))
}

fn assert_disk_admission(root: &Path, archive_bytes: u64) -> Result<()> {
    if archive_bytes == 0 || archive_bytes > MAX_ARCHIVE_BYTES {
        return error("Linux desktop archive size is outside the supported bound");
    }
    let required = MAX_EXPANDED_BYTES
        .saturating_add(archive_bytes)
        .saturating_add(INSTALL_RESERVE_BYTES);
    let Some(available) = available_bytes(root) else {
        return error("Linux desktop install disk space could not be observed");
    };
    if available < required {
        return error("Linux desktop install requires additional free disk space before expansion");
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct InventoryEntry {
    kind: &'static str,
    mode: u32,
    bytes: u64,
    sha256: Option<String>,
}

fn hash_file(path: &Path) -> Result<InventoryEntry> {
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(no_follow())
        .open(path)
        .map_err(|cause| {
            Error::new(format!(
                "Linux desktop generation contains an unsafe file: {cause}"
            ))
        })?;
    let before = file
        .metadata()
        .map_err(|cause| Error::new(cause.to_string()))?;
    if !before.is_file() || !owned(&before) || before.nlink() != 1 || (before.mode() & 0o7022) != 0
    {
        return error("Linux desktop generation contains an unsafe file");
    }
    let mut digest = Sha256::new();
    let mut buffer = vec![0_u8; 128 * 1024];
    let mut bytes = 0_u64;
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|cause| Error::new(cause.to_string()))?;
        if read == 0 {
            break;
        }
        bytes += read as u64;
        digest.update(&buffer[..read]);
    }
    let after = file
        .metadata()
        .map_err(|cause| Error::new(cause.to_string()))?;
    if bytes != before.len()
        || after.len() != before.len()
        || after.mtime() != before.mtime()
        || after.mtime_nsec() != before.mtime_nsec()
        || after.ctime() != before.ctime()
        || after.ctime_nsec() != before.ctime_nsec()
    {
        return error("Linux desktop generation changed while being verified");
    }
    file.sync_all()
        .map_err(|cause| Error::new(cause.to_string()))?;
    Ok(InventoryEntry {
        kind: "file",
        mode: before.mode() & 0o7777,
        bytes,
        sha256: Some(
            digest
                .finalize()
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect(),
        ),
    })
}

fn inventory_tree(root: &Path) -> Result<BTreeMap<String, InventoryEntry>> {
    let mut inventory = BTreeMap::new();
    fn walk(
        base: &Path,
        relative: &str,
        inventory: &mut BTreeMap<String, InventoryEntry>,
    ) -> Result<()> {
        let directory = if relative.is_empty() {
            base.to_path_buf()
        } else {
            base.join(relative)
        };
        let metadata = require_owned_directory(&directory)?;
        inventory.insert(
            relative.to_owned(),
            InventoryEntry {
                kind: "directory",
                mode: metadata.mode() & 0o7777,
                bytes: 0,
                sha256: None,
            },
        );
        let mut names: Vec<String> = std::fs::read_dir(&directory)
            .map_err(|cause| Error::new(cause.to_string()))?
            .filter_map(|entry| entry.ok())
            .filter_map(|entry| entry.file_name().to_str().map(str::to_owned))
            .collect();
        names.sort();
        for name in names {
            let child = if relative.is_empty() {
                name.clone()
            } else {
                format!("{relative}/{name}")
            };
            let path = directory.join(&name);
            let metadata =
                std::fs::symlink_metadata(&path).map_err(|cause| Error::new(cause.to_string()))?;
            if metadata.is_dir() && !metadata.file_type().is_symlink() {
                walk(base, &child, inventory)?;
            } else {
                if !metadata.is_file() || metadata.file_type().is_symlink() {
                    return error("Linux desktop generation contains a link or special file");
                }
                inventory.insert(child, hash_file(&path)?);
            }
        }
        sync_directory(&directory)?;
        Ok(())
    }
    walk(root, "", &mut inventory)?;
    Ok(inventory)
}

fn require_matching_inventory(
    root: &Path,
    expected: &BTreeMap<String, InventoryEntry>,
) -> Result<()> {
    let actual = inventory_tree(root)?;
    if actual.len() != expected.len() {
        return error("Linux desktop generation inventory changed after admission");
    }
    for (path, entry) in expected {
        if actual.get(path) != Some(entry) {
            return error("Linux desktop generation bytes or permissions changed after admission");
        }
    }
    Ok(())
}

pub struct Staged {
    pub home: PathBuf,
    pub root: PathBuf,
    pub generation_path: PathBuf,
    pub archive_sha256: String,
    pub version: String,
    generation: Identity,
    inventory: BTreeMap<String, InventoryEntry>,
}

pub fn stage(verified: &Verified, archive_path: &Path, home: Option<&Path>) -> Result<Staged> {
    let descriptor = &verified.descriptor;
    require_ordinary_user()?;
    let home = resolve_install_home(home)?;
    let root = ensure_install_layout(&home)?;
    let root_metadata = require_owned_directory(&root)?;
    let root_identity = Identity::of(&root_metadata);
    let generation = format!("{}-{}", descriptor.version, descriptor.archive.sha256);
    if !generation_ok(&generation) {
        return error("Linux desktop generation identity is invalid");
    }
    if managed_launcher_present(&home, &root)? {
        return error("First install refuses an existing desktop launcher");
    }
    require_managed_desktop(&home)?;
    let lease = acquire_lease(&root)?;
    collect(&root, root_identity);
    assert_disk_admission(&root, descriptor.archive.bytes)?;
    let attempt = mkdtemp(&root)?;
    std::fs::set_permissions(&attempt, std::fs::Permissions::from_mode(0o700))
        .map_err(|cause| Error::new(cause.to_string()))?;
    let uid = require_owned_directory(&attempt)?.uid();
    write_allocation(
        &root,
        &Allocation {
            schema: ALLOCATION_SCHEMA,
            kind: "attempt",
            basename: attempt
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or_default(),
            operation_id: uuid_v4(),
            root: root_identity,
            tree: Identity::of(&require_owned_directory(&attempt)?),
            uid,
            phase: "allocated",
            version: None,
            archive_sha256: None,
        },
    )?;
    let result = stage_attempt(
        &home,
        &root,
        root_identity,
        &attempt,
        verified,
        archive_path,
        &generation,
    );
    let attempt_identity = Identity::of(&require_owned_directory(&attempt)?);
    let _ = retire_tree(
        &root,
        root_identity,
        attempt
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default(),
        attempt_identity,
    );
    drop(lease);
    result
}

fn stage_attempt(
    home: &Path,
    root: &Path,
    root_identity: Identity,
    attempt: &Path,
    verified: &Verified,
    archive_path: &Path,
    generation: &str,
) -> Result<Staged> {
    let descriptor = &verified.descriptor;
    let extracted = archive::extract(
        archive_path,
        attempt,
        &descriptor.archive,
        &descriptor.version,
    )?;
    std::fs::set_permissions(&extracted, std::fs::Permissions::from_mode(0o700))
        .map_err(|cause| Error::new(cause.to_string()))?;
    asar::admit(
        &extracted.join("resources/app.asar"),
        &descriptor.version,
        &descriptor.source_revision,
    )?;
    let inventory = inventory_tree(&extracted)?;
    match inventory.get("junto") {
        Some(entry) if entry.kind == "file" && (entry.mode & 0o111) != 0 => {}
        _ => return error("Linux desktop executable is not admitted"),
    }
    let generation_path = root.join(generation);
    let created = match std::fs::create_dir(&generation_path) {
        Ok(()) => {
            std::fs::set_permissions(&generation_path, std::fs::Permissions::from_mode(0o700))
                .map_err(|cause| Error::new(cause.to_string()))?;
            true
        }
        Err(cause) if cause.kind() == std::io::ErrorKind::AlreadyExists => false,
        Err(cause) => {
            return error(format!(
                "Linux desktop generation could not be created: {cause}"
            ));
        }
    };
    if created {
        let metadata = require_owned_directory(&generation_path)?;
        write_allocation(
            root,
            &Allocation {
                schema: ALLOCATION_SCHEMA,
                kind: "generation",
                basename: generation,
                operation_id: uuid_v4(),
                root: root_identity,
                tree: Identity::of(&metadata),
                uid: metadata.uid(),
                phase: "allocated",
                version: Some(&descriptor.version),
                archive_sha256: Some(&descriptor.archive.sha256),
            },
        )?;
        let outcome = (|| -> Result<()> {
            for entry in
                std::fs::read_dir(&extracted).map_err(|cause| Error::new(cause.to_string()))?
            {
                let entry = entry.map_err(|cause| Error::new(cause.to_string()))?;
                std::fs::rename(entry.path(), generation_path.join(entry.file_name()))
                    .map_err(|cause| Error::new(cause.to_string()))?;
            }
            require_matching_inventory(&generation_path, &inventory)
        })();
        if let Err(cause) = outcome {
            let _ = retire_tree(
                root,
                root_identity,
                generation,
                Identity::of(&require_owned_directory(&generation_path)?),
            );
            return Err(cause);
        }
    } else {
        require_matching_inventory(&generation_path, &inventory)?;
    }
    let metadata = require_owned_directory(&generation_path)?;
    write_allocation(
        root,
        &Allocation {
            schema: ALLOCATION_SCHEMA,
            kind: "generation",
            basename: generation,
            operation_id: uuid_v4(),
            root: root_identity,
            tree: Identity::of(&metadata),
            uid: metadata.uid(),
            phase: "admitted",
            version: Some(&descriptor.version),
            archive_sha256: Some(&descriptor.archive.sha256),
        },
    )?;
    for relative in [
        ".local/opt/junto-alpha",
        ".local/opt",
        ".local/bin",
        ".local/share/applications",
        ".local/share",
        ".local",
        "",
    ] {
        sync_directory(&home.join(relative))?;
    }
    Ok(Staged {
        home: home.to_path_buf(),
        root: root.to_path_buf(),
        generation_path: generation_path.clone(),
        archive_sha256: descriptor.archive.sha256.clone(),
        version: descriptor.version.clone(),
        generation: Identity::of(&metadata),
        inventory,
    })
}

fn require_staged(staged: &Staged) -> Result<()> {
    if staged.generation.ino == 0 {
        return error("Linux desktop release was not staged by this installer");
    }
    Ok(())
}

pub fn revalidate(staged: &Staged) -> Result<()> {
    require_staged(staged)?;
    require_install_layout(&staged.home)?;
    let metadata = require_owned_directory(&staged.generation_path)?;
    if !Identity::of(&metadata).same(staged.generation) {
        return error("Linux desktop generation changed filesystem identity");
    }
    require_matching_inventory(&staged.generation_path, &staged.inventory)?;
    Ok(())
}

fn write_temporary_file(path: &Path, body: &str, mode: u32) -> Result<()> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(mode)
        .custom_flags(no_follow())
        .open(path)
        .map_err(|cause| {
            Error::new(format!(
                "Linux desktop activation file could not be written: {cause}"
            ))
        })?;
    file.write_all(body.as_bytes())
        .map_err(|cause| Error::new(cause.to_string()))?;
    file.set_permissions(std::fs::Permissions::from_mode(mode))
        .map_err(|cause| Error::new(cause.to_string()))?;
    file.sync_all()
        .map_err(|cause| Error::new(cause.to_string()))?;
    Ok(())
}

/// No process or product-state operations: the caller quiesces before install.
pub fn activate_first_install(staged: &Staged) -> std::result::Result<PathBuf, ActivationError> {
    let mut activated = false;
    let mut temporary_desktop: Option<PathBuf> = None;
    let mut temporary_launcher: Option<PathBuf> = None;
    let outcome = (|| -> Result<PathBuf> {
        revalidate(staged)?;
        let check_incumbent = || -> Result<()> {
            if managed_launcher_present(&staged.home, &staged.root)? {
                return error("First install refuses an existing managed desktop launcher");
            }
            Ok(())
        };
        check_incumbent()?;
        require_managed_desktop(&staged.home)?;
        let stable_launcher = launcher_path(&staged.home);
        let stable_desktop = desktop_path(&staged.home);
        let reuse_desktop = exists(&stable_desktop);
        let nonce = uuid_v4();
        let launcher_directory = stable_launcher
            .parent()
            .ok_or_else(|| Error::new("Linux desktop install directory is not owner-controlled"))?;
        let desktop_directory = stable_desktop
            .parent()
            .ok_or_else(|| Error::new("Linux desktop install directory is not owner-controlled"))?;
        let launcher_temporary = launcher_directory.join(format!(".junto-desktop-{nonce}"));
        temporary_launcher = Some(launcher_temporary.clone());
        if !reuse_desktop {
            let desktop_temporary = desktop_directory.join(format!(".junto-{nonce}.desktop"));
            write_temporary_file(&desktop_temporary, &desktop_body(&staged.home), 0o644)?;
            temporary_desktop = Some(desktop_temporary);
        }
        let generation = staged
            .generation_path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| Error::new("Linux desktop generation identity is invalid"))?;
        write_temporary_file(
            &launcher_temporary,
            &launcher_body(&staged.root, generation),
            0o755,
        )?;
        require_install_layout(&staged.home)?;
        require_managed_desktop(&staged.home)?;
        if let Some(temporary) = temporary_desktop.take() {
            std::fs::hard_link(&temporary, &stable_desktop).map_err(|cause| {
                Error::new(format!(
                    "Linux desktop desktop entry could not be published: {cause}"
                ))
            })?;
            std::fs::remove_file(&temporary).map_err(|cause| Error::new(cause.to_string()))?;
        }
        sync_directory(desktop_directory)?;
        revalidate(staged)?;
        check_incumbent()?;
        require_managed_desktop(&staged.home)?;
        std::fs::hard_link(&launcher_temporary, &stable_launcher).map_err(|cause| {
            Error::new(format!(
                "Linux desktop launcher could not be published: {cause}"
            ))
        })?;
        activated = true;
        std::fs::remove_file(&launcher_temporary).map_err(|cause| Error::new(cause.to_string()))?;
        temporary_launcher = None;
        sync_directory(launcher_directory)?;
        Ok(staged.generation_path.join("junto"))
    })();
    match outcome {
        Ok(executable) => Ok(executable),
        Err(cause) => {
            if let Some(temporary) = temporary_desktop {
                let _ = std::fs::remove_file(temporary);
            }
            if let Some(temporary) = temporary_launcher {
                let _ = std::fs::remove_file(temporary);
            }
            Err(ActivationError::new(cause.message().to_owned(), activated))
        }
    }
}
