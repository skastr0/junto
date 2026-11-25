//! The database family an install puts back when its candidate never reaches
//! ready, as src/node/hosts/install-restore.ts writes it and the core reads it
//! at boot (docs/machines.md, Installing and updating a machine).
//!
//! The installer never opens SQLite. It copies `junto.db` and its `-wal` and
//! `-shm` as one family while the previous core is quiescent, into
//! `<state>/.rollback-<uuid>`, and deletes that copy the moment the candidate is
//! ready. If the candidate fails, the copy is renamed back over whatever the
//! candidate left, and a marker written first lets a boot finish the same steps
//! after a crash.
//!
//! The protocol is the cross-language seam: these names, this JSON, this order
//! and this idempotence are read by the TypeScript core at boot, and
//! tests/machine-restore.test.ts is the lock on that side. Every copied member,
//! the kept directory, the state directory and the marker are fsynced in the
//! order the doctrine names, so a crash never leaves a copy that reads as whole
//! and is not.

use std::fs;
use std::io::{self, Read, Write};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use rustix::fs::OFlags;
use rustix::process::getuid;

use super::Refused;

pub const DATABASE: &str = "junto.db";
/// The family, in restore order.
pub const FAMILY: [&str; 3] = ["junto.db", "junto.db-wal", "junto.db-shm"];
const COPY_CHUNK: usize = 1024 * 1024;

#[derive(Debug, Clone)]
pub struct RestorePoint {
    pub id: String,
    /// The kept copy; the one path an operator is told on the double failure.
    pub directory: PathBuf,
    pub state_directory: PathBuf,
    /// The family members the copy holds.
    pub members: Vec<String>,
}

/// The product state directory under a Junto home (`JUNTO_HOME` is the home,
/// not `.junto`).
pub fn machine_state_directory(junto_home: &Path) -> PathBuf {
    junto_home.join(".junto").join("state")
}

fn missing(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::NotFound
}

/// A private regular file of this user's, never a link; a missing one is not.
fn owned_regular_file(path: &Path) -> Result<bool, Refused> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if missing(&error) => return Ok(false),
        Err(error) => return Err(Refused::new(error.to_string())),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(Refused::new(format!(
            "not a regular file: {}",
            path.display()
        )));
    }
    if metadata.uid() != getuid().as_raw() || metadata.mode() & 0o077 != 0 {
        return Err(Refused::new(format!(
            "not owned by this user with private modes: {}",
            path.display()
        )));
    }
    Ok(true)
}

/// The state directory itself: a real directory of this user's that group and
/// other may not write.
fn check_state_directory(path: &Path) -> Result<(), Refused> {
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        Refused::new(format!(
            "the state directory could not be read: {}: {error}",
            path.display()
        ))
    })?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(Refused::new(format!(
            "the state directory is not a real directory: {}",
            path.display()
        )));
    }
    if metadata.uid() != getuid().as_raw() || metadata.mode() & 0o022 != 0 {
        return Err(Refused::new(format!(
            "the state directory is not this user's alone: {}",
            path.display()
        )));
    }
    Ok(())
}

fn sync_directory(path: &Path) -> Result<(), Refused> {
    let directory = fs::File::open(path).map_err(Refused::from)?;
    directory.sync_all().map_err(Refused::from)
}

/// A fresh restore id, as the marker's file name carries it.
pub fn new_uuid() -> Result<String, Refused> {
    random_uuid()
}

fn random_uuid() -> Result<String, Refused> {
    let mut bytes = [0u8; 16];
    fs::File::open("/dev/urandom")
        .and_then(|mut source| source.read_exact(&mut bytes))
        .map_err(|error| Refused::new(format!("a restore id could not be made: {error}")))?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: Vec<String> = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    Ok(format!(
        "{}-{}-{}-{}-{}",
        hex[0..4].concat(),
        hex[4..6].concat(),
        hex[6..8].concat(),
        hex[8..10].concat(),
        hex[10..16].concat()
    ))
}

fn is_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => *byte == b'-',
            _ => byte.is_ascii_digit() || (b'a'..=b'f').contains(byte),
        })
}

/// Copy one member without following a link at either end, then make it durable.
fn copy_member(source: &Path, destination: &Path) -> Result<(), Refused> {
    let mut from = {
        let fd = rustix::fs::open(
            source,
            OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            rustix::fs::Mode::empty(),
        )
        .map_err(|error| Refused::new(format!("{}: {error}", source.display())))?;
        fs::File::from(fd)
    };
    let mut to = {
        let fd = rustix::fs::open(
            destination,
            OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            rustix::fs::Mode::from_bits_truncate(0o600),
        )
        .map_err(|error| Refused::new(format!("{}: {error}", destination.display())))?;
        fs::File::from(fd)
    };
    let mut buffer = vec![0u8; COPY_CHUNK];
    loop {
        let read = from.read(&mut buffer).map_err(Refused::from)?;
        if read == 0 {
            break;
        }
        to.write_all(&buffer[..read]).map_err(Refused::from)?;
    }
    to.sync_all().map_err(Refused::from)
}

/// Keep the database family as it stands, or nothing when this install has no
/// database yet. The caller makes the copy only while no core of this home runs.
pub fn make_restore_point(state_directory: &Path) -> Result<Option<RestorePoint>, Refused> {
    if !owned_regular_file(&state_directory.join(DATABASE))? {
        return Ok(None);
    }
    fs::create_dir_all(state_directory).map_err(Refused::from)?;
    fs::set_permissions(state_directory, fs::Permissions::from_mode(0o700))
        .map_err(Refused::from)?;
    check_state_directory(state_directory)?;
    let id = random_uuid()?;
    let directory = state_directory.join(format!(".rollback-{id}"));
    fs::DirBuilder::new()
        .mode(0o700)
        .create(&directory)
        .map_err(Refused::from)?;
    let mut members = Vec::new();
    let copied = (|| -> Result<(), Refused> {
        for name in FAMILY {
            let source = state_directory.join(name);
            if owned_regular_file(&source)? {
                copy_member(&source, &directory.join(name))?;
                members.push(name.to_string());
            }
        }
        sync_directory(&directory)?;
        sync_directory(state_directory)?;
        Ok(())
    })();
    if let Err(error) = copied {
        let _ = fs::remove_dir_all(&directory);
        return Err(error);
    }
    Ok(Some(RestorePoint {
        id,
        directory,
        state_directory: state_directory.to_path_buf(),
        members,
    }))
}

fn marker_of(point: &RestorePoint) -> PathBuf {
    point
        .state_directory
        .join(format!(".restore-{}.marker", point.id))
}

fn write_marker(point: &RestorePoint) -> Result<(), Refused> {
    let marker = marker_of(point);
    let members: Vec<String> = point
        .members
        .iter()
        .map(|name| format!("\"{name}\""))
        .collect();
    let body = format!(
        "{{\"database\":\"{DATABASE}\",\"rollback\":\".rollback-{}\",\"id\":\"{}\",\"members\":[{}]}}\n",
        point.id,
        point.id,
        members.join(",")
    );
    let written = (|| -> Result<(), Refused> {
        let mut options = fs::OpenOptions::new();
        options
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(OFlags::NOFOLLOW.bits() as i32);
        let mut handle = options.open(&marker).map_err(Refused::from)?;
        handle.write_all(body.as_bytes()).map_err(Refused::from)?;
        handle.sync_all().map_err(Refused::from)
    })();
    if let Err(error) = written {
        // Its own earlier write is the only admitted "already there".
        if owned_regular_file(&marker)? {
            let _ = error;
        } else {
            return Err(error);
        }
    }
    if !owned_regular_file(&marker)? {
        return Err(Refused::new(format!(
            "the restore marker is not a private regular file: {}",
            marker.display()
        )));
    }
    sync_directory(&point.state_directory)
}

/// Put the kept family back. Steps, in this order and none beside a database it
/// was not copied with: marker (fsynced), the candidate's members unlinked and
/// the kept ones renamed in db, wal, shm order, the state directory fsynced, the
/// marker removed, the directory fsynced again, then the kept copy removed.
pub fn restore_database(point: &RestorePoint) -> Result<(), Refused> {
    write_marker(point)?;
    for name in FAMILY {
        let kept = point.directory.join(name);
        let target = point.state_directory.join(name);
        if owned_regular_file(&kept)? {
            match fs::remove_file(&target) {
                Ok(()) => {}
                Err(error) if missing(&error) => {}
                Err(error) => return Err(Refused::new(error.to_string())),
            }
            fs::rename(&kept, &target).map_err(Refused::from)?;
        } else if !point.members.iter().any(|member| member == name) {
            // The kept family never had this member, so the candidate's must not stay.
            match fs::remove_file(&target) {
                Ok(()) => {}
                Err(error) if missing(&error) => {}
                Err(error) => return Err(Refused::new(error.to_string())),
            }
        } else if !owned_regular_file(&target)? {
            // A crash after this member was renamed, before the marker went: the
            // restored one is in place and the kept copy no longer holds it.
            return Err(Refused::new(format!(
                "the restore has neither its kept {name} nor a restored one: {}",
                point.directory.display()
            )));
        }
    }
    sync_directory(&point.state_directory)?;
    fs::remove_file(marker_of(point)).map_err(Refused::from)?;
    sync_directory(&point.state_directory)?;
    fs::remove_dir_all(&point.directory).map_err(Refused::from)?;
    Ok(())
}

/// The candidate is ready: the kept copy is no longer needed. The marker comes
/// off first and the directory is fsynced, so no boot ever meets a marker whose
/// copy is gone.
pub fn discard_restore_point(point: &RestorePoint) -> Result<(), Refused> {
    match fs::remove_file(marker_of(point)) {
        Ok(()) => {}
        Err(error) if missing(&error) => {}
        Err(error) => return Err(Refused::new(error.to_string())),
    }
    sync_directory(&point.state_directory)?;
    match fs::remove_dir_all(&point.directory) {
        Ok(()) => Ok(()),
        Err(error) if missing(&error) => Ok(()),
        Err(error) => Err(Refused::new(error.to_string())),
    }
}

/// The one marker a crash may leave, read closed: its id from the file name,
/// its members a subset of the family that includes the database.
fn read_marker(state_directory: &Path, name: &str, id: &str) -> Result<Vec<String>, Refused> {
    let path = state_directory.join(name);
    let refused = |why: &str| {
        Refused::new(format!(
            "the database restore marker {name} {why}; inspect it before starting Junto"
        ))
    };
    if !owned_regular_file(&path)? {
        return Err(refused("is not a private regular file"));
    }
    let mut bytes = Vec::new();
    let mut handle = {
        let fd = rustix::fs::open(
            &path,
            OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            rustix::fs::Mode::empty(),
        )
        .map_err(|_| refused("could not be read"))?;
        fs::File::from(fd)
    };
    handle
        .read_to_end(&mut bytes)
        .map_err(|_| refused("could not be read"))?;
    let text = String::from_utf8_lossy(&bytes).into_owned();
    let value: serde_json::Value =
        serde_json::from_str(&text).map_err(|_| refused("is not JSON"))?;
    let object = value
        .as_object()
        .ok_or_else(|| refused("is not a JSON object"))?;
    if object.get("id").and_then(|value| value.as_str()) != Some(id) {
        return Err(refused("does not name its own id"));
    }
    if object.get("database").and_then(|value| value.as_str()) != Some(DATABASE) {
        return Err(refused("does not name junto.db"));
    }
    let listed = object
        .get("members")
        .and_then(|value| value.as_array())
        .ok_or_else(|| refused("does not name its kept family"))?;
    let mut members = Vec::new();
    for member in listed {
        let name = member
            .as_str()
            .ok_or_else(|| refused("does not name its kept family"))?;
        if !FAMILY.contains(&name) || members.iter().any(|held: &String| held == name) {
            return Err(refused("does not name its kept family"));
        }
        members.push(name.to_string());
    }
    if !members.iter().any(|name| name == DATABASE) {
        return Err(refused("does not name junto.db in its kept family"));
    }
    Ok(members)
}

/// Before anything opens the database: finish a restore a crash interrupted. A
/// marker whose copy is gone refuses the boot rather than opening a database
/// whose history is unknown.
pub fn finish_interrupted_restore(state_directory: &Path) -> Result<Option<PathBuf>, Refused> {
    let entries = match fs::read_dir(state_directory) {
        Ok(entries) => entries,
        Err(error) if missing(&error) => return Ok(None),
        Err(error) => return Err(Refused::new(error.to_string())),
    };
    let mut markers: Vec<String> = Vec::new();
    for entry in entries {
        let entry = entry.map_err(Refused::from)?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if let Some(id) = name
            .strip_prefix(".restore-")
            .and_then(|rest| rest.strip_suffix(".marker"))
            .filter(|id| is_uuid(id))
        {
            let _ = id;
            markers.push(name);
        }
    }
    if markers.is_empty() {
        return Ok(None);
    }
    if markers.len() > 1 {
        return Err(Refused::new(format!(
            "more than one database restore was interrupted in {}; inspect them before starting Junto",
            state_directory.display()
        )));
    }
    check_state_directory(state_directory)?;
    let name = markers[0].clone();
    let id = name
        .strip_prefix(".restore-")
        .and_then(|rest| rest.strip_suffix(".marker"))
        .unwrap_or_default()
        .to_string();
    let directory = state_directory.join(format!(".rollback-{id}"));
    let kept = fs::symlink_metadata(&directory).ok();
    let usable = kept
        .as_ref()
        .is_some_and(|metadata| metadata.is_dir() && !metadata.file_type().is_symlink());
    if !usable {
        return Err(Refused::new(format!(
            "a database restore was interrupted and its kept copy is missing at {}; inspect it before starting Junto",
            directory.display()
        )));
    }
    let members = read_marker(state_directory, &name, &id)?;
    let point = RestorePoint {
        id,
        directory: directory.clone(),
        state_directory: state_directory.to_path_buf(),
        members,
    };
    restore_database(&point)?;
    Ok(Some(directory))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let directory = super::super::paths::home()
            .join(format!(".junto-restore-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(directory.join("state")).expect("a state directory");
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).expect("private");
        fs::set_permissions(directory.join("state"), fs::Permissions::from_mode(0o700))
            .expect("private");
        directory.join("state")
    }

    fn database(state: &Path) {
        for (name, body) in [(DATABASE, "database"), ("junto.db-wal", "wal")] {
            let file = state.join(name);
            fs::write(&file, body).expect("a family member");
            fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).expect("private modes");
        }
    }

    #[test]
    fn keeps_the_family_it_finds_and_restores_it_in_order() {
        let state = scratch("keep");
        database(&state);
        let point = make_restore_point(&state)
            .expect("a point")
            .expect("a database");
        assert_eq!(point.members, vec!["junto.db", "junto.db-wal"]);
        for name in &point.members {
            let copied = point.directory.join(name);
            assert!(copied.is_file());
            assert_eq!(fs::metadata(&copied).expect("kept").mode() & 0o777, 0o600);
        }
        assert_eq!(
            fs::metadata(&point.directory).expect("kept").mode() & 0o777,
            0o700
        );
        // The candidate leaves a different family behind.
        fs::write(state.join(DATABASE), b"candidate").expect("a candidate");
        fs::write(state.join("junto.db-wal"), b"candidate-wal").expect("a candidate wal");
        fs::write(state.join("junto.db-shm"), b"candidate-shm").expect("a candidate shm");
        restore_database(&point).expect("restored");
        assert_eq!(
            fs::read(state.join(DATABASE)).expect("restored"),
            b"database"
        );
        assert_eq!(
            fs::read(state.join("junto.db-wal")).expect("restored"),
            b"wal"
        );
        assert!(
            !state.join("junto.db-shm").exists(),
            "the kept family never had it"
        );
        assert!(!point.directory.exists());
        assert!(!state.join(format!(".restore-{}.marker", point.id)).exists());
    }

    #[test]
    fn a_marker_written_by_a_crash_finishes_on_the_next_read() {
        let state = scratch("resume");
        database(&state);
        let point = make_restore_point(&state)
            .expect("a point")
            .expect("a database");
        // A crash after the marker and the database rename, before the wal.
        write_marker(&point).expect("the marker");
        fs::rename(point.directory.join(DATABASE), state.join(DATABASE)).expect("renamed");
        let finished = finish_interrupted_restore(&state).expect("finished");
        assert_eq!(finished, Some(point.directory.clone()));
        assert_eq!(
            fs::read(state.join("junto.db-wal")).expect("restored"),
            b"wal"
        );
        assert!(!state.join(format!(".restore-{}.marker", point.id)).exists());
    }

    #[test]
    fn a_marker_with_no_kept_copy_refuses_rather_than_opening_past_it() {
        let state = scratch("missing");
        database(&state);
        let point = make_restore_point(&state)
            .expect("a point")
            .expect("a database");
        write_marker(&point).expect("the marker");
        fs::remove_dir_all(&point.directory).expect("the copy goes");
        let refused = finish_interrupted_restore(&state).expect_err("refused");
        assert!(
            refused.message.contains("kept copy is missing"),
            "{}",
            refused.message
        );
    }

    #[test]
    fn two_markers_and_a_foreign_member_refuse() {
        let state = scratch("shapes");
        database(&state);
        let point = make_restore_point(&state)
            .expect("a point")
            .expect("a database");
        write_marker(&point).expect("the marker");
        let second = state.join(".restore-11111111-2222-4333-8444-555555555555.marker");
        fs::write(&second, b"{}").expect("a second marker");
        let refused = finish_interrupted_restore(&state).expect_err("refused");
        assert!(
            refused.message.contains("more than one"),
            "{}",
            refused.message
        );
        fs::remove_file(&second).expect("the second goes");
        // An id its file name does not carry is refused.
        let marker = state.join(format!(".restore-{}.marker", point.id));
        fs::write(
            &marker,
            "{\"database\":\"junto.db\",\"id\":\"11111111-2222-4333-8444-555555555555\",\"members\":[\"junto.db\"]}",
        )
        .expect("rewritten");
        let refused = finish_interrupted_restore(&state).expect_err("refused");
        assert!(
            refused.message.contains("does not name its own id"),
            "{}",
            refused.message
        );
        // A member outside the family is refused.
        fs::write(&marker, format!("{{\"database\":\"junto.db\",\"id\":\"{}\",\"members\":[\"junto.db\",\"elsewhere\"]}}", point.id)).expect("rewritten");
        let refused = finish_interrupted_restore(&state).expect_err("refused");
        assert!(
            refused.message.contains("does not name its kept family"),
            "{}",
            refused.message
        );
    }

    #[test]
    fn discard_removes_the_marker_before_the_copy() {
        let state = scratch("discard");
        database(&state);
        let point = make_restore_point(&state)
            .expect("a point")
            .expect("a database");
        write_marker(&point).expect("the marker");
        discard_restore_point(&point).expect("discarded");
        assert!(!state.join(format!(".restore-{}.marker", point.id)).exists());
        assert!(!point.directory.exists());
    }

    #[test]
    fn an_install_with_no_database_keeps_nothing() {
        let state = scratch("empty");
        assert!(make_restore_point(&state).expect("read").is_none());
    }
}
