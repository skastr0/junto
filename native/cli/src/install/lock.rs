//! One install at a time on a machine: only an installation's exact owner marker admits its lock directory, and
//! the lease is a kernel flock on a private file there, so it outlives this
//! process while it holds the descriptor and a crash releases it.

use std::fs;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

use rustix::fs::{FlockOperation, OFlags};
use rustix::process::getuid;

use super::Check;
use super::Refused;
use super::paths::{ensure_machine_directory, machine_home_path, owned_machine_file};

/// The lease held: the open file description carries the lock, and closing it
/// (or dropping this) releases it.
pub struct InstallLock {
    _file: fs::File,
}

/// Only an installation's exact owner marker admits its lock directory.
pub fn admit_install_lock_root(root: &Path, expected_owner: &str) -> Result<PathBuf, Refused> {
    let root = machine_home_path(root, false)?;
    let marker = root.join("owner.json");
    if !owned_machine_file(&marker)? {
        return Err(
            Refused::new("This folder belongs to another Junto installation")
                .with_check(Check::InstallFolderNotOurs),
        );
    }
    let held = fs::read_to_string(&marker).map_err(Refused::from)?;
    if held != expected_owner {
        return Err(
            Refused::new("This folder belongs to another Junto installation")
                .with_check(Check::InstallFolderNotOurs),
        );
    }
    Ok(root)
}

/// The install lock on an admitted root, or the refusal that names why it could
/// not be held.
pub fn acquire_install_lock(root: &Path) -> Result<InstallLock, Refused> {
    match take_install_lock(root)? {
        Some(lease) => Ok(lease),
        None => Err(Refused::new(
            "Junto is already being sent to this machine. Wait for it to finish, then send again",
        )
        .with_check(Check::SendInProgress)),
    }
}

/// The lock, or `None` while an install holds it: a boot that finds a restore
/// pending has to tell held from free, since the installer starts the candidate
/// core while it holds the lock itself.
pub fn try_install_lock(root: &Path) -> Result<Option<InstallLock>, Refused> {
    take_install_lock(root)
}

fn take_install_lock(root: &Path) -> Result<Option<InstallLock>, Refused> {
    let directory = root.join(".install-lock");
    ensure_machine_directory(&directory, false)?;
    let path = directory.join("lease");
    owned_machine_file(&path)?;
    let file = {
        let fd = rustix::fs::open(
            &path,
            OFlags::CREATE | OFlags::RDWR | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            rustix::fs::Mode::from_bits_truncate(0o600),
        )
        .map_err(|error| {
            Refused::new(format!("{}: {error}", path.display()))
                .with_check(Check::InstallLeaseUnavailable)
        })?;
        fs::File::from(fd)
    };
    {
        let metadata = file.metadata().map_err(Refused::from)?;
        if !metadata.is_file()
            || metadata.uid() != getuid().as_raw()
            || metadata.nlink() != 1
            || metadata.mode() & 0o077 != 0
        {
            return Err(Refused::new(
                "The install lock is not owned by Junto. Choose another install folder",
            )
            .with_check(Check::InstallFolderNotOurs));
        }
    }
    match rustix::fs::flock(&file, FlockOperation::NonBlockingLockExclusive) {
        Ok(()) => Ok(Some(InstallLock { _file: file })),
        Err(rustix::io::Errno::WOULDBLOCK) => Ok(None),
        Err(errno) => Err(Refused::new(format!(
            "The system install lease is unavailable. Check this machine's operating system: {errno}"
        )).with_check(Check::InstallLeaseUnavailable)),
    }
}

/// The owner marker's own bytes: the service label and the home it serves.
pub fn owner_marker(service_label: &str, junto_home: &Path) -> String {
    format!(
        "{{\"serviceLabel\":\"{service_label}\",\"juntoHome\":{}}}",
        serde_json::to_string(&junto_home.to_string_lossy()).unwrap_or_else(|_| "\"\"".into())
    )
}

/// Writes the marker once, 0600, refusing to replace another's; identical bytes
/// already there are this install's.
pub fn write_owner_marker(install_root: &Path, body: &str) -> Result<(), Refused> {
    let marker = install_root.join("owner.json");
    if owned_machine_file(&marker)? {
        let held = fs::read_to_string(&marker).map_err(Refused::from)?;
        if held != body {
            return Err(
                Refused::new("install directory belongs to another machine home")
                    .with_check(Check::InstallFolderNotOurs),
            );
        }
        return Ok(());
    }
    use std::io::Write as _;
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true).mode(0o600);
    match options.open(&marker) {
        Ok(mut handle) => handle.write_all(body.as_bytes()).map_err(Refused::from),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let held = fs::read_to_string(&marker).map_err(Refused::from)?;
            if held == body && owned_machine_file(&marker)? {
                Ok(())
            } else {
                Err(Refused::new(error.to_string()))
            }
        }
        Err(error) => Err(Refused::from(error)),
    }
}

/// Whether the directory holds nothing but its own lock directory.
pub fn only_lock_here(install_root: &Path) -> Result<bool, Refused> {
    let entries = fs::read_dir(install_root).map_err(Refused::from)?;
    for entry in entries {
        let entry = entry.map_err(Refused::from)?;
        if entry.file_name() != ".install-lock" {
            return Ok(false);
        }
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;
    use std::os::unix::fs::PermissionsExt;

    fn scratch(name: &str) -> PathBuf {
        let directory =
            super::super::paths::home().join(format!(".junto-lock-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(&directory).expect("a scratch directory");
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).expect("private");
        directory
    }

    #[test]
    fn a_foreign_marker_refuses_and_the_own_one_admits() {
        let root = scratch("marker");
        let body = owner_marker(
            "dev.junto.machine.0123456789abcdef",
            &super::super::paths::home(),
        );
        let foreign = format!("{body}x");
        write_owner_marker(&root, &foreign).expect("the marker");
        assert!(admit_install_lock_root(&root, &body).is_err());
        write_owner_marker(&root, &body).expect_err("a foreign body is refused");
        fs::remove_file(root.join("owner.json")).expect("goes");
        write_owner_marker(&root, &body).expect("its own marker");
        admit_install_lock_root(&root, &body).expect("admitted");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_second_holder_is_refused_and_the_lock_releases_on_drop() {
        let root = scratch("held");
        let body = owner_marker(
            "dev.junto.machine.0123456789abcdef",
            &super::super::paths::home(),
        );
        write_owner_marker(&root, &body).expect("the marker");
        let held = acquire_install_lock(&root).expect("the first holder");
        assert!(acquire_install_lock(&root).is_err());
        drop(held);
        acquire_install_lock(&root).expect("released with its holder");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn the_lease_file_is_private_and_a_link_is_refused() {
        let root = scratch("lease");
        let body = owner_marker(
            "dev.junto.machine.0123456789abcdef",
            &super::super::paths::home(),
        );
        write_owner_marker(&root, &body).expect("the marker");
        let first = acquire_install_lock(&root).expect("the first holder");
        drop(first);
        let lease = root.join(".install-lock/lease");
        let mode = fs::metadata(&lease).expect("the lease").mode() & 0o777;
        assert_eq!(mode, 0o600);
        // A second marker file written by someone else is refused as a link.
        fs::remove_file(&lease).expect("goes");
        let elsewhere = root.join("elsewhere");
        fs::File::create(&elsewhere).expect("a file");
        std::os::unix::fs::symlink(&elsewhere, &lease).expect("a link");
        assert!(acquire_install_lock(&root).is_err());
        let mut file = fs::File::create(root.join("note")).expect("a file");
        file.write_all(b"x").expect("written");
        let _ = fs::remove_dir_all(&root);
    }
}
