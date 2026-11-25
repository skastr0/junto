//! What a machine package must be before this machine copies it, as
//! src/node/hosts/bundle.ts inspects it: a directory, a regular manifest, no
//! file writable by others, every file and its mode and sha256 exactly the
//! manifest's, and the entry points present and executable.

use std::fs;
use std::io::Read;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::Refused;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BundleFile {
    pub path: String,
    pub bytes: u64,
    pub mode: u32,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub build: String,
    pub target: String,
    pub node: String,
    pub app_version: String,
    pub files: Vec<BundleFile>,
}

/// This build's own target, as the manifest names it.
pub fn this_target() -> &'static str {
    if cfg!(target_os = "macos") {
        "darwin-arm64"
    } else {
        "linux-x64"
    }
}

fn hex64(value: &str) -> bool {
    value.len() == 64
        && value
            .chars()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&(c as u8)))
}

fn bundle_path(value: &str) -> bool {
    value.split('/').all(|part| {
        !part.is_empty()
            && part != "."
            && part != ".."
            && part
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "@._-".contains(c))
    })
}

fn sha256_file(path: &Path) -> Result<String, Refused> {
    let mut file = fs::File::open(path).map_err(Refused::from)?;
    let mut digest = Sha256::new();
    let mut buffer = vec![0u8; 1024 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(Refused::from)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

/// Every file in the bundle, manifest.json aside, in path order.
pub fn bundle_files(root: &Path) -> Result<Vec<BundleFile>, Refused> {
    let mut files = Vec::new();
    let mut pending: Vec<PathBuf> = vec![PathBuf::new()];
    while let Some(relative) = pending.pop() {
        let directory = root.join(&relative);
        let mut names: Vec<PathBuf> = fs::read_dir(&directory)
            .map_err(Refused::from)?
            .map(|entry| entry.map(|entry| entry.path()).map_err(Refused::from))
            .collect::<Result<_, _>>()?;
        names.sort();
        for absolute in names {
            let child = absolute
                .strip_prefix(root)
                .map(Path::to_path_buf)
                .unwrap_or_else(|_| absolute.clone());
            let text = child
                .to_string_lossy()
                .replace(std::path::MAIN_SEPARATOR, "/");
            if text == "manifest.json" {
                continue;
            }
            let metadata = fs::symlink_metadata(&absolute).map_err(Refused::from)?;
            if metadata.is_dir() && !metadata.file_type().is_symlink() {
                pending.push(child);
            } else if metadata.is_file() && !metadata.file_type().is_symlink() {
                files.push(BundleFile {
                    path: text,
                    bytes: metadata.len(),
                    mode: metadata.mode() & 0o777,
                    sha256: sha256_file(&absolute)?,
                });
            } else {
                return Err(Refused::new(format!(
                    "bundle contains a link or special file: {text}"
                )));
            }
        }
    }
    files.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(files)
}

/// The manifest, read closed, with the bundle proven to be exactly what it says.
pub fn inspect_bundle(root: &Path) -> Result<Manifest, Refused> {
    let directory = fs::symlink_metadata(root).map_err(Refused::from)?;
    if !directory.is_dir() || directory.file_type().is_symlink() {
        return Err(Refused::new("bundle must be a directory, not a link"));
    }
    let manifest_path = root.join("manifest.json");
    let metadata = fs::symlink_metadata(&manifest_path).map_err(Refused::from)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(Refused::new("bundle manifest must be a regular file"));
    }
    let text = fs::read_to_string(&manifest_path).map_err(Refused::from)?;
    let manifest: Manifest = serde_json::from_str(&text).map_err(|error| {
        Refused::new(format!(
            "the bundle manifest is not what this build expects: {error}"
        ))
    })?;
    if !hex64(&manifest.build) {
        return Err(Refused::new("the bundle manifest build is not a build id"));
    }
    if manifest.target != "darwin-arm64" && manifest.target != "linux-x64" {
        return Err(Refused::new(
            "the bundle manifest target is not one Junto builds",
        ));
    }
    if manifest.files.len() > 128 {
        return Err(Refused::new("the bundle manifest lists too many files"));
    }
    for file in &manifest.files {
        if !bundle_path(&file.path) {
            return Err(Refused::new(format!(
                "the bundle manifest names a path it may not hold: {}",
                file.path
            )));
        }
        if file.mode > 0o777 {
            return Err(Refused::new(format!(
                "the bundle manifest names modes outside 0777: {}",
                file.path
            )));
        }
        if !hex64(&file.sha256) {
            return Err(Refused::new(format!(
                "the bundle manifest names no sha256 for {}",
                file.path
            )));
        }
    }
    if manifest.files.iter().any(|file| file.mode & 0o022 != 0) {
        return Err(Refused::new(
            "bundle files must not be writable by others; rebuild this machine package",
        ));
    }
    let found = bundle_files(root)?;
    if found != manifest.files {
        return Err(Refused::new("bundle files do not match the manifest"));
    }
    for required in ["bin/node", "bin/junto", "core/junto.cjs"] {
        let Some(file) = found.iter().find(|file| file.path == required) else {
            return Err(Refused::new(format!(
                "bundle is missing an executable or entry: {required}"
            )));
        };
        if required.starts_with("bin/") && file.mode & 0o111 == 0 {
            return Err(Refused::new(format!(
                "bundle is missing an executable or entry: {required}"
            )));
        }
    }
    Ok(manifest)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;
    use std::os::unix::fs::{PermissionsExt, symlink};

    fn scratch(name: &str) -> PathBuf {
        let directory = super::super::paths::home()
            .join(format!(".junto-bundle-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(directory.join("bin")).expect("a bin");
        fs::create_dir_all(directory.join("core")).expect("a core");
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).expect("private");
        for (path, body, mode) in [
            ("bin/node", "node", 0o755),
            ("bin/junto", "junto", 0o755),
            ("core/junto.cjs", "core", 0o644),
        ] {
            let file = directory.join(path);
            let mut handle = fs::File::create(&file).expect("a file");
            handle.write_all(body.as_bytes()).expect("written");
            fs::set_permissions(&file, fs::Permissions::from_mode(mode)).expect("modes");
        }
        directory
    }

    fn manifest_of(root: &Path) -> Manifest {
        let files = bundle_files(root).expect("files");
        Manifest {
            build: "a".repeat(64),
            target: this_target().to_string(),
            node: "26.10.0".to_string(),
            app_version: "0.11.15".to_string(),
            files,
        }
    }

    fn write_manifest(root: &Path, manifest: &Manifest) {
        let text = serde_json::to_string(manifest).expect("json");
        fs::write(root.join("manifest.json"), text).expect("the manifest");
    }

    #[test]
    fn a_bundle_that_is_exactly_its_manifest_is_admitted() {
        let root = scratch("good");
        let manifest = manifest_of(&root);
        write_manifest(&root, &manifest);
        let read = inspect_bundle(&root).expect("admitted");
        assert_eq!(read.files.len(), 3);
        assert_eq!(read.files[0].path, "bin/junto");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_changed_byte_a_foreign_mode_and_a_missing_entry_are_refused() {
        let root = scratch("refusals");
        let mut manifest = manifest_of(&root);
        write_manifest(&root, &manifest);
        fs::write(root.join("bin/node"), "changed").expect("changed");
        let refused = inspect_bundle(&root).expect_err("refused");
        assert!(
            refused.message.contains("do not match the manifest"),
            "{}",
            refused.message
        );
        fs::write(root.join("bin/node"), "node").expect("restored");
        manifest.files[0].mode = 0o775;
        write_manifest(&root, &manifest);
        let refused = inspect_bundle(&root).expect_err("refused");
        assert!(
            refused.message.contains("writable by others"),
            "{}",
            refused.message
        );
        // A bundle that is exactly its manifest but holds no junto entry.
        fs::remove_file(root.join("bin/junto")).expect("the entry goes");
        let mut manifest = manifest_of(&root);
        write_manifest(&root, &manifest);
        let refused = inspect_bundle(&root).expect_err("refused");
        assert!(
            refused.message.contains("missing an executable"),
            "{}",
            refused.message
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_link_inside_the_bundle_is_refused() {
        let root = scratch("link");
        let manifest = manifest_of(&root);
        write_manifest(&root, &manifest);
        symlink(root.join("bin/node"), root.join("bin/other")).expect("a link");
        let refused = inspect_bundle(&root).expect_err("refused");
        assert!(
            refused.message.contains("link or special file"),
            "{}",
            refused.message
        );
        let _ = fs::remove_dir_all(&root);
    }
}

