//! The home database lock, installer side: one core at a time on
//! `<home>/.junto/state`, so a GUI login that loads a plist `bootout` left, or a
//! core started by hand, cannot open the database while an install copies or
//! restores it.
//!
//! The identity of the lock is a random id in `<state>/home.lock`, never a name
//! derived from the path: a local user could bind a predictable abstract socket
//! first and block every boot and install. Linux binds the abstract stream
//! socket `\0junto-home-<hex of the id>`; Darwin holds `flock` on the same file.
//! Both are exclusive, non-blocking, close on exec, and refused rather than
//! waited on. The file is never unlinked or renamed: it is the name a boot
//! reads, and a race that recreates it would split the lock in two.

use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
use std::path::Path;
use std::time::{Duration, Instant};

use rustix::fs::{Mode, OFlags};
use rustix::process::getuid;

use super::Refused;

/// Fixed words: a boot or an installer that meets a held lock says what to do.
pub const HELD_WORDS: &str = "Junto is running on this home; stop it first";

/// A held home lock. Dropping it releases the lock with the descriptor.
pub struct HomeDatabaseLock {
    // The abstract socket on Linux, the file everywhere: the lock lives on it.
    _socket: Socket,
    _file: Option<fs::File>,
}

/// How long a `home.lock` another process is writing has to reach 32 bytes.
const ID_WAIT: Duration = Duration::from_secs(2);
const ID_POLL: Duration = Duration::from_millis(20);
const ID_BYTES: usize = 32;

/// The lock, `None` when a core or another install holds it, or the refusal
/// that says the state directory or its lock file is not Junto's to use.
pub fn try_lock_home_database(state_directory: &Path) -> Result<Option<HomeDatabaseLock>, Refused> {
    prepare_state_directory(state_directory)?;
    let file = open_home_lock(state_directory)?;
    let id = match read_id(&file) {
        Ok(id) => id,
        Err(short) if short => {
            // Another process made the file and is writing the id this moment.
            let deadline = Instant::now() + ID_WAIT;
            loop {
                if Instant::now() >= deadline {
                    return Err(Refused::new(
                        "home.lock is not a home lock. No core can hold it: remove it and start Junto again",
                    ));
                }
                std::thread::sleep(ID_POLL);
                match read_id(&file) {
                    Ok(id) => break id,
                    Err(short) if short => continue,
                    Err(_) => {
                        return Err(Refused::new(
                            "home.lock is not a home lock. No core can hold it: remove it and start Junto again",
                        ));
                    }
                }
            }
        }
        Err(_) => {
            return Err(Refused::new(
                "home.lock is not a home lock. No core can hold it: remove it and start Junto again",
            ));
        }
    };
    match bind_socket(&id, &file) {
        Ok(socket) => Ok(Some(HomeDatabaseLock {
            _socket: socket,
            _file: Some(file),
        })),
        Err(Held::Held) => Ok(None),
        Err(Held::Refused(refused)) => Err(refused),
    }
}

/// `mkdir -p` at 0700, then lstat: a real directory of this user that group and
/// other may not write.
fn prepare_state_directory(state_directory: &Path) -> Result<(), Refused> {
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(state_directory)
        .map_err(|error| {
            Refused::new(format!(
                "the state directory could not be made: {}: {error}",
                state_directory.display()
            ))
        })?;
    let metadata = fs::symlink_metadata(state_directory).map_err(|error| {
        Refused::new(format!(
            "the state directory could not be read: {}: {error}",
            state_directory.display()
        ))
    })?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(Refused::new(format!(
            "the state directory is not a real directory: {}",
            state_directory.display()
        )));
    }
    if metadata.uid() != getuid().as_raw() || metadata.mode() & 0o022 != 0 {
        return Err(Refused::new(format!(
            "the state directory is not this user's alone: {}",
            state_directory.display()
        )));
    }
    Ok(())
}

/// The lock file, made once with `O_EXCL` and never through a link, then opened
/// to read: the id is written by whoever makes it first and read by everyone,
/// so the name is never guessed and never rewritten.
fn open_home_lock(state_directory: &Path) -> Result<fs::File, Refused> {
    let path = state_directory.join("home.lock");
    match rustix::fs::open(
        &path,
        OFlags::CREATE | OFlags::EXCL | OFlags::WRONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::from_bits_truncate(0o600),
    ) {
        Ok(fd) => {
            let file = fs::File::from(fd);
            file.set_permissions(fs::Permissions::from_mode(0o600))
                .map_err(Refused::from)?;
            check_lock_file(&file)?;
            write_id(&file)?;
            drop(file);
        }
        Err(rustix::io::Errno::EXIST) => {}
        Err(errno) => {
            return Err(Refused::new(format!(
                "the home lock could not be made: {}: {errno}",
                path.display()
            )));
        }
    }
    let fd = rustix::fs::open(
        &path,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map_err(|error| Refused::new(format!("{}: {error}", path.display())))?;
    let file = fs::File::from(fd);
    check_lock_file(&file)?;
    Ok(file)
}

/// A regular file of this user's alone, one link.
fn check_lock_file(file: &fs::File) -> Result<(), Refused> {
    let metadata = file.metadata().map_err(Refused::from)?;
    if !metadata.is_file()
        || metadata.uid() != getuid().as_raw()
        || metadata.nlink() != 1
        || metadata.mode() & 0o077 != 0
    {
        return Err(Refused::new(
            "home.lock is not this user's alone. Remove it and start Junto again",
        ));
    }
    Ok(())
}

fn write_id(mut file: &fs::File) -> Result<(), Refused> {
    let id = random_id()?;
    file.write_all(&id).map_err(Refused::from)?;
    file.sync_all().map_err(Refused::from)?;
    Ok(())
}

/// 32 bytes from the OS random source.
fn random_id() -> Result<[u8; ID_BYTES], Refused> {
    let mut id = [0u8; ID_BYTES];
    fs::File::open("/dev/urandom")
        .and_then(|mut source| source.read_exact(&mut id))
        .map_err(|error| Refused::new(format!("a home lock id could not be made: {error}")))?;
    Ok(id)
}

/// `Ok` the id, `Err(true)` while the file holds fewer than 32 bytes, `Err(false)`
/// when it holds something else.
fn read_id(mut file: &fs::File) -> Result<[u8; ID_BYTES], bool> {
    // The id is written before this read, which leaves the offset at its end.
    if file.seek(SeekFrom::Start(0)).is_err() {
        return Err(false);
    }
    let mut bytes = Vec::with_capacity(ID_BYTES + 1);
    match file.read_to_end(&mut bytes) {
        Ok(_) if bytes.len() == ID_BYTES => {
            let mut id = [0u8; ID_BYTES];
            id.copy_from_slice(&bytes);
            Ok(id)
        }
        Ok(_) if bytes.len() < ID_BYTES => Err(true),
        Ok(_) => Err(false),
        Err(_) => Err(false),
    }
}

enum Held {
    Held,
    Refused(Refused),
}

#[cfg(target_os = "linux")]
type Socket = std::os::unix::net::UnixListener;

/// The abstract name, bound and never accepted on: the kernel keeps it while the
/// listener lives, and a second bind is `EADDRINUSE`.
#[cfg(target_os = "linux")]
fn bind_socket(id: &[u8; ID_BYTES], _file: &fs::File) -> Result<Socket, Held> {
    use std::os::linux::net::SocketAddrExt;

    let hex: String = id.iter().map(|byte| format!("{byte:02x}")).collect();
    let name = format!("junto-home-{hex}");
    let address = std::os::unix::net::SocketAddr::from_abstract_name(name.as_bytes())
        .map_err(|error| Held::Refused(Refused::new(format!("the home lock address: {error}"))))?;
    let listener = Socket::bind_addr(&address).map_err(|error| match error.kind() {
        std::io::ErrorKind::AddrInUse => Held::Held,
        _ => Held::Refused(Refused::new(format!("the home lock: {error}"))),
    })?;
    // Nothing spawned by this process may inherit the lock.
    let _ = rustix::io::fcntl_setfd(&listener, rustix::io::FdFlags::CLOEXEC);
    Ok(listener)
}

#[cfg(not(target_os = "linux"))]
type Socket = ();

/// Darwin holds `flock` on the file itself: the same lock a core takes.
#[cfg(not(target_os = "linux"))]
fn bind_socket(_id: &[u8; ID_BYTES], file: &fs::File) -> Result<Socket, Held> {
    // `O_EXLOCK` would be the same lock; a plain flock keeps the id read above
    // and the lock on one descriptor.
    let _ = rustix::io::fcntl_setfd(file, rustix::io::FdFlags::CLOEXEC);
    match rustix::fs::flock(file, rustix::fs::FlockOperation::NonBlockingLockExclusive) {
        Ok(()) => Ok(()),
        Err(rustix::io::Errno::WOULDBLOCK) => Err(Held::Held),
        Err(errno) => Err(Held::Refused(Refused::new(format!(
            "the home lock: {errno}"
        )))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn scratch(name: &str) -> std::path::PathBuf {
        let directory = crate::install::paths::home()
            .join(format!(".junto-homelock-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(&directory).expect("scratch");
        directory
    }

    #[test]
    fn one_core_at_a_time_and_the_file_survives_the_holder() {
        let root = scratch("one");
        let state = root.join(".junto/state");
        let first = try_lock_home_database(&state)
            .expect("the state directory is readable")
            .expect("the first hold");
        let lock = state.join("home.lock");
        assert!(lock.is_file());
        assert_eq!(
            fs::metadata(&lock).expect("the lock").permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(fs::metadata(&lock).expect("the lock").len(), 32);
        assert!(
            try_lock_home_database(&state).expect("readable").is_none(),
            "a second holder is told who holds it"
        );
        drop(first);
        assert!(
            try_lock_home_database(&state).expect("readable").is_some(),
            "the lock lives with its holder"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn the_id_is_the_name_and_it_is_not_the_path() {
        let root = scratch("id");
        let state = root.join(".junto/state");
        let held = try_lock_home_database(&state)
            .expect("readable")
            .expect("hold");
        let id = fs::read(state.join("home.lock")).expect("the id");
        assert_eq!(id.len(), 32);
        assert_eq!(fs::read(state.join("home.lock")).expect("the id"), id);
        drop(held);
        // The file keeps its id: a lock recreated with a new name would split
        // the lock in two, so the id is written once and read after.
        let again = try_lock_home_database(&state)
            .expect("readable")
            .expect("hold");
        assert_eq!(fs::read(state.join("home.lock")).expect("the id"), id);
        drop(again);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_lock_file_this_user_does_not_own_alone_is_refused() {
        let root = scratch("mode");
        let state = root.join(".junto/state");
        fs::create_dir_all(&state).expect("state");
        let lock = state.join("home.lock");
        fs::write(&lock, [7u8; 32]).expect("write");
        fs::set_permissions(&lock, fs::Permissions::from_mode(0o644)).expect("mode");
        let refused = match try_lock_home_database(&state) {
            Err(refused) => refused,
            Ok(_) => panic!("a readable lock file is not Junto's"),
        };
        assert!(
            refused.message.contains("not this user's alone"),
            "{}",
            refused.message
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_lock_file_that_is_a_link_is_refused() {
        let root = scratch("link");
        let state = root.join(".junto/state");
        let elsewhere = root.join("elsewhere");
        fs::create_dir_all(&state).expect("state");
        fs::write(&elsewhere, [9u8; 32]).expect("write");
        std::os::unix::fs::symlink(&elsewhere, state.join("home.lock")).expect("link");
        assert!(
            try_lock_home_database(&state).is_err(),
            "a link is never followed to a lock"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_state_directory_group_can_write_is_refused() {
        let root = scratch("world");
        let state = root.join(".junto/state");
        fs::create_dir_all(&state).expect("state");
        fs::set_permissions(&state, fs::Permissions::from_mode(0o770)).expect("mode");
        assert!(try_lock_home_database(&state).is_err());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_short_id_waits_and_then_refuses_with_words_that_say_what_to_do() {
        let root = scratch("short");
        let state = root.join(".junto/state");
        fs::create_dir_all(&state).expect("state");
        let lock = state.join("home.lock");
        fs::write(&lock, [1u8; 16]).expect("write");
        fs::set_permissions(&lock, fs::Permissions::from_mode(0o600)).expect("mode");
        let refused = match try_lock_home_database(&state) {
            Err(refused) => refused,
            Ok(_) => panic!("a short id is not a home lock"),
        };
        assert_eq!(
            refused.message,
            "home.lock is not a home lock. No core can hold it: remove it and start Junto again"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_squatter_on_a_name_made_from_the_path_cannot_block_the_home() {
        use std::os::linux::net::SocketAddrExt;

        let root = scratch("squat");
        let state = root.join(".junto/state");
        fs::create_dir_all(&state).expect("state");
        // The name the old spec would have used: anyone can compute and bind it.
        let mut squatter = [0u8; 32];
        for (index, byte) in b"/home/peer/.junto/state/junto.db".iter().enumerate() {
            squatter[index % 32] ^= byte;
        }
        let hex: String = squatter.iter().map(|byte| format!("{byte:02x}")).collect();
        let address = std::os::unix::net::SocketAddr::from_abstract_name(
            format!("junto-home-{hex}").as_bytes(),
        )
        .expect("address");
        let _blocker = std::os::unix::net::UnixListener::bind_addr(&address).expect("the squatter");
        assert!(
            try_lock_home_database(&state).expect("readable").is_some(),
            "a name made from the path is not this home's name"
        );
        let _ = fs::remove_dir_all(&root);
    }
}
