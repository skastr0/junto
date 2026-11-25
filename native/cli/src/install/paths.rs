//! Which paths a machine's install may touch, as src/cli/hosts/install-paths.ts
//! decides it: under the real account home, every component a real directory
//! this user owns and nobody else may write, files regular and never links,
//! and a service definition replaced only by exact bytes.

use std::fs;
use std::io;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use std::path::{Component, Path, PathBuf};

use rustix::process::getuid;

use super::Refused;

/// The account home, resolved, as Node's homedir() names it.
pub fn home() -> PathBuf {
    let raw = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default();
    fs::canonicalize(&raw).unwrap_or(raw)
}

fn missing(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::NotFound
}

pub fn optional_metadata(path: &Path) -> io::Result<Option<fs::Metadata>> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if missing(&error) => Ok(None),
        Err(error) => Err(error),
    }
}

fn owned(path: &Path, metadata: &fs::Metadata) -> Result<(), Refused> {
    if metadata.uid() != getuid().as_raw() || metadata.mode() & 0o022 != 0 {
        return Err(Refused::new(format!(
            "machine path must be owned by this user and not writable by others: {}",
            path.display()
        )));
    }
    Ok(())
}

/// A path as Node's path.resolve makes it: absolute, with `.` and `..` folded
/// and no link followed.
pub fn resolve_path(value: impl AsRef<Path>) -> PathBuf {
    let path = value.as_ref();
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_default().join(path)
    };
    let mut out = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// A path that must live under the account home, with every existing component
/// below it a real directory this user alone may write.
pub fn machine_home_path(value: impl AsRef<Path>, allow_home: bool) -> Result<PathBuf, Refused> {
    let home = fs::canonicalize(home()).map_err(|error| {
        Refused::new(format!("the account home could not be resolved: {error}"))
    })?;
    let path = resolve_path(value);
    let suffix = path
        .strip_prefix(&home)
        .map_err(|_| Refused::new("machine files must live under the user home"))?;
    if suffix.as_os_str().is_empty() && !allow_home {
        return Err(Refused::new("machine files must live under the user home"));
    }
    let mut component = home;
    for part in suffix.components() {
        component.push(part.as_os_str());
        let Some(metadata) = optional_metadata(&component).map_err(Refused::from)? else {
            continue;
        };
        owned(&component, &metadata)?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(Refused::new(format!(
                "machine directory is not a real directory: {}",
                component.display()
            )));
        }
    }
    Ok(path)
}

/// The directory, made 0700 where it is missing, then checked again.
pub fn ensure_machine_directory(path: &Path, allow_home: bool) -> Result<(), Refused> {
    let resolved = machine_home_path(path, allow_home)?;
    let home = fs::canonicalize(home()).map_err(|error| {
        Refused::new(format!("the account home could not be resolved: {error}"))
    })?;
    let mut component = home.clone();
    if let Ok(suffix) = resolved.strip_prefix(&home) {
        for part in suffix.components() {
            component.push(part.as_os_str());
            match optional_metadata(&component).map_err(Refused::from)? {
                Some(_) => {}
                None => fs::DirBuilder::new()
                    .mode(0o700)
                    .create(&component)
                    .map_err(|error| {
                        Refused::new(format!(
                            "machine directory could not be made: {}: {error}",
                            component.display()
                        ))
                    })?,
            }
        }
    }
    machine_home_path(path, allow_home).map(|_| ())
}

/// Whether a path is a regular file this user alone may write; a missing one is
/// not, and a link or a foreign one is refused.
pub fn owned_machine_file(path: &Path) -> Result<bool, Refused> {
    let Some(metadata) = optional_metadata(path).map_err(Refused::from)? else {
        return Ok(false);
    };
    owned(path, &metadata)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(Refused::new(format!(
            "machine file is not a regular file: {}",
            path.display()
        )));
    }
    Ok(true)
}

/// Every file under a tree is a regular owned file; a link anywhere refuses.
pub fn check_machine_tree(path: &Path) -> Result<(), Refused> {
    machine_home_path(path, false)?;
    for entry in fs::read_dir(path).map_err(Refused::from)? {
        let entry = entry.map_err(Refused::from)?;
        let child = entry.path();
        let metadata = fs::symlink_metadata(&child).map_err(Refused::from)?;
        if metadata.is_dir() && !metadata.file_type().is_symlink() {
            check_machine_tree(&child)?;
        } else {
            owned_machine_file(&child)?;
        }
    }
    Ok(())
}

/// The service definition, written only where no other install's is: identical
/// bytes are the same install's, different bytes are refused.
pub fn write_machine_service_file(file: &Path, body: &str) -> Result<(), Refused> {
    if owned_machine_file(file)? {
        let existing = fs::read_to_string(file).map_err(Refused::from)?;
        if existing != body {
            return Err(Refused::new(
                "existing service definition belongs to a different install",
            ));
        }
        return Ok(());
    }
    let mut options = fs::OpenOptions::new();
    options
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(rustix::fs::OFlags::NOFOLLOW.bits() as i32);
    use std::io::Write as _;
    let mut handle = options.open(file).map_err(Refused::from)?;
    handle.write_all(body.as_bytes()).map_err(Refused::from)
}

/// The service definition comes off only when it is still exactly ours.
pub fn remove_machine_service_file(file: &Path, body: &str) -> Result<(), Refused> {
    if !owned_machine_file(file)? {
        return Ok(());
    }
    let existing = fs::read_to_string(file).map_err(Refused::from)?;
    if existing != body {
        return Err(Refused::new("service definition changed; cleanup refused"));
    }
    fs::remove_file(file).map_err(Refused::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{PermissionsExt, symlink};

    /// A private scratch directory under the real home, since every path this
    /// module admits must live there.
    fn scratch(name: &str) -> PathBuf {
        let directory = home().join(format!(".junto-paths-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(&directory).expect("a scratch directory");
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).expect("private modes");
        directory
    }

    #[test]
    fn a_path_outside_the_home_is_refused_and_one_inside_is_resolved() {
        let outside = machine_home_path("/etc/passwd", false);
        assert!(outside.is_err());
        let home = home();
        let inside = machine_home_path(home.join("junto-paths-test"), false);
        assert_eq!(
            inside.expect("inside the home"),
            home.join("junto-paths-test")
        );
        assert!(machine_home_path(&home, false).is_err());
        assert!(machine_home_path(&home, true).is_ok());
    }

    #[test]
    fn a_directory_is_made_private_and_one_anyone_may_write_is_refused() {
        let root = scratch("dirs");
        let target = root.join("a/b");
        ensure_machine_directory(&target, false).expect("made under the home");
        let mode = fs::metadata(&target).expect("made").mode() & 0o777;
        assert_eq!(mode, 0o700);
        let open = root.join("open");
        fs::create_dir(&open).expect("a directory");
        fs::set_permissions(&open, fs::Permissions::from_mode(0o777)).expect("open modes");
        assert!(machine_home_path(&open, false).is_err());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_service_file_is_written_once_and_only_its_own_bytes_remove_it() {
        let directory = scratch("service");
        let file = directory.join("unit.service");
        write_machine_service_file(&file, "one\n").expect("the first write");
        write_machine_service_file(&file, "one\n").expect("the same bytes");
        assert!(write_machine_service_file(&file, "two\n").is_err());
        assert!(remove_machine_service_file(&file, "two\n").is_err());
        remove_machine_service_file(&file, "one\n").expect("its own bytes");
        assert!(!file.exists());
    }

    #[test]
    fn a_link_where_a_file_is_expected_is_refused() {
        let directory = scratch("links");
        let target = directory.join("real");
        fs::write(&target, "x").expect("a file");
        let link = directory.join("link");
        symlink(&target, &link).expect("a link");
        assert!(owned_machine_file(&link).is_err());
        assert!(!owned_machine_file(&directory.join("absent")).expect("absent"));
    }
}

