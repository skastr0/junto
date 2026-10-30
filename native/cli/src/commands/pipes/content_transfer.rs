//! `junto content-transfer receive|send|stat <sha256> <byteLength> [offset]`
//! (src/cli/content-transfer.ts): the closed argv one machine runs on another
//! to move a content object (src/main/junto/content/transfer-local.ts).
//!
//! Bytes land in a digest-keyed partial under the content store, resume by its
//! size, and publish atomically only once digest and length verify. Nothing is
//! reported available before it verifies; a verified digest delivered again
//! changes nothing. One status line answers, except a send, which streams.

use std::fmt;
use std::fs::{self, DirBuilder, OpenOptions, Permissions};
use std::io::{self, Read, Seek, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use rustix::fs::OFlags;
use serde::Serialize;
use sha2::{Digest as _, Sha256};

use crate::wire;

const DIR_MODE: u32 = 0o700;
const PARTIAL_MODE: u32 = 0o600;
const OBJECT_MODE: u32 = 0o444;
const READ_CHUNK: usize = 64 * 1024;
/// DEFAULT_CONTENT_DISK_RESERVE_BYTES (disk-admission.ts).
const DISK_RESERVE_BYTES: u64 = 256 * 1024 * 1024;
/// Number.MAX_SAFE_INTEGER: a length past it is no ContentRef.
const MAX_SAFE: u64 = (1 << 53) - 1;

// --- argv (helper-contract.ts parseContentHelperArgs) -----------------------

/// A lower-case SHA-256 digest, as the store names objects by.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct Sha256Hex(String);

impl Sha256Hex {
    fn parse(text: &str) -> Option<Self> {
        let valid =
            text.len() == 64 && text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
        valid.then(|| Sha256Hex(text.to_string()))
    }

    fn shard(&self) -> &str {
        &self.0[..2]
    }
}

/// What the closed argv names: a mode and the object it is about.
#[derive(Debug, PartialEq, Eq)]
struct Request {
    mode: Mode,
    sha256: Sha256Hex,
    byte_length: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    Stat,
    Receive { offset: u64 },
    Send { offset: u64 },
}

/// A decimal token of at most 16 digits, no leading zero, within a safe integer.
fn count(token: &str) -> Option<u64> {
    let digits = token.len() <= 16 && token.bytes().all(|b| b.is_ascii_digit());
    let canonical = token == "0" || !token.starts_with('0');
    (digits && canonical && !token.is_empty())
        .then(|| token.parse().ok())
        .flatten()
}

fn parse(argv: &[&str]) -> Result<Request, String> {
    const INVALID: &str = "content helper identity tokens are invalid";
    let Some(&mode) = argv.first() else {
        return Err("content helper mode is required".into());
    };
    if !matches!(mode, "receive" | "send" | "stat") {
        return Err("content helper mode is not admitted".into());
    }
    let identity = |sha: &str, length: &str| -> Result<(Sha256Hex, u64), String> {
        let sha256 = Sha256Hex::parse(sha).ok_or(INVALID)?;
        let byte_length = count(length).ok_or(INVALID)?;
        Ok((sha256, byte_length))
    };
    match (mode, &argv[1..]) {
        ("stat", [sha, length]) => {
            let (sha256, byte_length) = identity(sha, length)?;
            if byte_length > MAX_SAFE {
                return Err("content helper byteLength is not a safe integer".into());
            }
            Ok(Request {
                mode: Mode::Stat,
                sha256,
                byte_length,
            })
        }
        ("stat", _) => Err("content helper stat requires <sha256> <byteLength>".into()),
        (_, [sha, length, rest @ ..]) if rest.len() <= 1 => {
            let (sha256, byte_length) = identity(sha, length)?;
            let offset = count(rest.first().copied().unwrap_or("0")).ok_or(INVALID)?;
            if byte_length > MAX_SAFE || offset > MAX_SAFE || offset > byte_length {
                return Err("content helper offset/byteLength is out of range".into());
            }
            let mode = if mode == "receive" {
                Mode::Receive { offset }
            } else {
                Mode::Send { offset }
            };
            Ok(Request {
                mode,
                sha256,
                byte_length,
            })
        }
        _ => Err(format!(
            "content helper {mode} requires <sha256> <byteLength> [offset]"
        )),
    }
}

// --- the store's failures (store.ts ContentStoreError) ---------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Code {
    Symlink,
    Corrupt,
    Missing,
    Io,
    Invalid,
    DiskLow,
}

#[derive(Debug)]
struct StoreError {
    code: Code,
    message: String,
}

impl StoreError {
    fn new(code: Code, message: impl Into<String>) -> Self {
        StoreError {
            code,
            message: message.into(),
        }
    }
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

/// A filesystem failure the store did not name is transient I/O.
impl From<io::Error> for StoreError {
    fn from(error: io::Error) -> Self {
        StoreError::new(Code::Io, error.to_string())
    }
}

type Result<T, E = StoreError> = std::result::Result<T, E>;

// --- the store's layout (paths.ts) ------------------------------------------

/// `<JUNTO_HOME>/.junto/content/v1`, its staging area and its object tree.
struct Store {
    root: PathBuf,
}

impl Store {
    fn at_home() -> Self {
        Store {
            root: wire::junto_home().join(".junto/content/v1"),
        }
    }

    fn incoming(&self) -> PathBuf {
        self.root.join("incoming")
    }

    fn objects(&self) -> PathBuf {
        self.root.join("sha256")
    }

    fn object(&self, sha256: &Sha256Hex) -> PathBuf {
        self.objects().join(sha256.shard()).join(&sha256.0)
    }

    /// One digest's partial, so resumes share one file (contentTransferPartialId).
    fn partial(&self, sha256: &Sha256Hex) -> PathBuf {
        self.incoming().join(format!("xfer_{}.partial", sha256.0))
    }

    /// ensureContentLayout: real directories at each leaf the store owns.
    fn ensure_layout(&self) -> Result<()> {
        [self.root.clone(), self.incoming(), self.objects()]
            .iter()
            .try_for_each(|dir| real_directory(dir))
    }
}

fn real_directory(path: &Path) -> Result<()> {
    DirBuilder::new()
        .recursive(true)
        .mode(DIR_MODE)
        .create(path)?;
    let info = fs::symlink_metadata(path)?;
    if !info.is_dir() {
        return Err(StoreError::new(
            Code::Symlink,
            format!("content path is not a real directory: {}", path.display()),
        ));
    }
    // The platform may ignore mode bits.
    let _ = fs::set_permissions(path, Permissions::from_mode(DIR_MODE));
    Ok(())
}

// --- files, never through a link --------------------------------------------

fn no_follow(options: &mut OpenOptions) -> &mut OpenOptions {
    options.custom_flags(OFlags::NOFOLLOW.bits() as i32)
}

/// What sits at a path, without following it.
enum Entry {
    Absent,
    File(u64),
    Other,
}

fn entry(path: &Path) -> Result<Entry> {
    match fs::symlink_metadata(path) {
        Ok(info) if info.file_type().is_file() => Ok(Entry::File(info.len())),
        Ok(_) => Ok(Entry::Other),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Entry::Absent),
        Err(e) => Err(e.into()),
    }
}

/// Removes a regular file the store owns; a link or a directory stays.
fn unlink_owned(path: &Path) -> Result<()> {
    match entry(path)? {
        Entry::File(_) => match fs::remove_file(path) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e.into()),
            _ => Ok(()),
        },
        _ => Ok(()),
    }
}

fn fsync(path: &Path, directory: bool) -> Result<()> {
    let flags = if directory {
        OFlags::NOFOLLOW | OFlags::DIRECTORY
    } else {
        OFlags::NOFOLLOW
    };
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(flags.bits() as i32)
        .open(path)?;
    rustix::fs::fsync(&file).map_err(io::Error::from)?;
    Ok(())
}

/// What a file holds: its digest and length (hashContentObjectFile).
#[derive(Debug, PartialEq, Eq)]
struct Observed {
    sha256: Sha256Hex,
    byte_length: u64,
}

fn hash(path: &Path) -> Result<Observed> {
    if !matches!(entry(path)?, Entry::File(_)) {
        return Err(StoreError::new(
            Code::Symlink,
            format!("content object is not a regular file: {}", path.display()),
        ));
    }
    let mut file = no_follow(OpenOptions::new().read(true)).open(path)?;
    let mut digest = Sha256::new();
    let mut buffer = vec![0u8; READ_CHUNK];
    let mut byte_length = 0u64;
    loop {
        match file.read(&mut buffer) {
            Ok(0) => break,
            Ok(n) => {
                digest.update(&buffer[..n]);
                byte_length += n as u64;
            }
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e.into()),
        }
    }
    let sha256 = Sha256Hex(
        digest
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect(),
    );
    Ok(Observed {
        sha256,
        byte_length,
    })
}

fn now() -> String {
    format!("{:.3}", jiff::Timestamp::now())
}

// --- planning a transfer (statContentForTransfer) ---------------------------

enum Local {
    Verified {
        path: PathBuf,
        verified_at: String,
    },
    Partial {
        bytes: u64,
    },
    Missing {
        reason: &'static str,
    },
    Corrupt {
        reason: String,
        observed_sha256: Option<Sha256Hex>,
        observed_byte_length: Option<u64>,
    },
}

impl Local {
    fn corrupt(reason: impl Into<String>) -> Self {
        Local::Corrupt {
            reason: reason.into(),
            observed_sha256: None,
            observed_byte_length: None,
        }
    }
}

/// A verified object wins over any partial; a partial past the length is corrupt.
fn inspect(store: &Store, sha256: &Sha256Hex, byte_length: u64) -> Result<Local> {
    store.ensure_layout()?;
    let path = store.object(sha256);
    match entry(&path)? {
        Entry::Other => return Ok(Local::corrupt("content object path is not a regular file")),
        Entry::File(size) if size != byte_length => {
            return Ok(Local::Corrupt {
                reason: "content object size does not match ContentRef".into(),
                observed_sha256: None,
                observed_byte_length: Some(size),
            });
        }
        Entry::File(_) => {
            return Ok(match hash(&path) {
                Ok(seen) if seen.sha256 == *sha256 && seen.byte_length == byte_length => {
                    Local::Verified {
                        path,
                        verified_at: now(),
                    }
                }
                Ok(seen) => Local::Corrupt {
                    reason: "content object digest or length mismatch".into(),
                    observed_sha256: Some(seen.sha256),
                    observed_byte_length: Some(seen.byte_length),
                },
                Err(error) => Local::corrupt(clip(&error.message)),
            });
        }
        Entry::Absent => {}
    }
    Ok(match entry(&store.partial(sha256))? {
        Entry::Absent => Local::Missing {
            reason: "content object and partial are absent",
        },
        Entry::Other => Local::corrupt("content partial is not a regular file"),
        Entry::File(size) if size > byte_length => Local::Corrupt {
            reason: "content partial exceeds ContentRef byteLength".into(),
            observed_sha256: None,
            observed_byte_length: Some(size),
        },
        // A full partial still waits to be published: the receiver finishes it.
        Entry::File(size) => Local::Partial { bytes: size },
    })
}

// --- receiving (receiveContentTransfer) -------------------------------------

struct Published {
    created: bool,
    verified_at: String,
}

/// Verifies the partial and moves it into place, or finds the object already there.
fn publish(
    store: &Store,
    sha256: &Sha256Hex,
    byte_length: u64,
    partial: &Path,
) -> Result<Published> {
    let seen = hash(partial)?;
    if seen.sha256 != *sha256 || seen.byte_length != byte_length {
        unlink_owned(partial)?;
        return Err(StoreError::new(
            Code::Corrupt,
            format!(
                "content transfer digest mismatch: expected {}/{byte_length}, got {}/{}",
                sha256.0, seen.sha256.0, seen.byte_length
            ),
        ));
    }
    let object = store.object(sha256);
    match entry(&object)? {
        Entry::Other => {
            return Err(StoreError::new(
                Code::Symlink,
                format!(
                    "content object path is not a regular file: {}",
                    object.display()
                ),
            ));
        }
        Entry::File(_) => {
            if hash(&object)?
                != (Observed {
                    sha256: sha256.clone(),
                    byte_length,
                })
            {
                return Err(StoreError::new(
                    Code::Corrupt,
                    format!(
                        "existing content object does not match digest at {}",
                        object.display()
                    ),
                ));
            }
            unlink_owned(partial)?;
            return Ok(Published {
                created: false,
                verified_at: now(),
            });
        }
        Entry::Absent => {}
    }
    let shard = object.parent().unwrap_or(&store.root);
    DirBuilder::new()
        .recursive(true)
        .mode(DIR_MODE)
        .create(shard)?;
    fs::rename(partial, &object)?;
    let _ = fs::set_permissions(&object, Permissions::from_mode(OBJECT_MODE));
    fsync(shard, true)?;
    fsync(&store.incoming(), true)?;
    match entry(&object)? {
        Entry::File(size) if size == byte_length => Ok(Published {
            created: true,
            verified_at: now(),
        }),
        Entry::File(_) => Err(StoreError::new(
            Code::Corrupt,
            format!("published content size mismatch at {}", object.display()),
        )),
        _ => Err(StoreError::new(
            Code::Symlink,
            format!(
                "published content object is not a regular file: {}",
                object.display()
            ),
        )),
    }
}

/// New bytes must leave the reserve free (assertContentDiskAdmission).
fn admit(store: &Store, need: u64) -> Result<()> {
    let stats = rustix::fs::statvfs(&store.root).map_err(io::Error::from)?;
    let free = stats.f_bavail.saturating_mul(stats.f_frsize);
    let required = need + DISK_RESERVE_BYTES;
    if free < required {
        return Err(StoreError::new(
            Code::DiskLow,
            format!(
                "content disk free {free} bytes is below need {need} plus reserve {DISK_RESERVE_BYTES}"
            ),
        ));
    }
    Ok(())
}

enum Received {
    Verified(Published),
    Partial { bytes: u64 },
}

/// Takes the remaining bytes from `source` into the partial, resuming at
/// `offset`, and publishes once the whole object is there and verifies.
fn receive(
    store: &Store,
    sha256: &Sha256Hex,
    byte_length: u64,
    offset: u64,
    source: &mut impl Read,
) -> Result<Received> {
    let partial = store.partial(sha256);
    let current = match inspect(store, sha256, byte_length)? {
        Local::Verified { verified_at, .. } => {
            return Ok(Received::Verified(Published {
                created: false,
                verified_at,
            }));
        }
        Local::Corrupt { reason, .. } => {
            // A clean retry starts from nothing.
            unlink_owned(&partial)?;
            return Err(StoreError::new(Code::Corrupt, reason));
        }
        Local::Partial { bytes } => bytes,
        Local::Missing { .. } => 0,
    };
    if offset != current {
        return Err(StoreError::new(
            Code::Invalid,
            format!("content transfer resume offset mismatch: expected {current}, got {offset}"),
        ));
    }
    admit(store, byte_length - current)?;

    if current == byte_length {
        if byte_length == 0 && matches!(entry(&partial)?, Entry::Absent) {
            let file = no_follow(
                OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .mode(PARTIAL_MODE),
            )
            .open(&partial)?;
            rustix::fs::fsync(&file).map_err(io::Error::from)?;
        }
        return publish(store, sha256, byte_length, &partial).map(Received::Verified);
    }

    let written = append(&partial, current, byte_length, source).inspect_err(|error| {
        // Verified corruption wipes the partial; transient I/O keeps it for a resume.
        if error.code == Code::Corrupt {
            let _ = unlink_owned(&partial);
        }
    })?;
    if written < byte_length {
        return Ok(Received::Partial { bytes: written });
    }
    publish(store, sha256, byte_length, &partial).map(Received::Verified)
}

/// Appends `source` to the partial (exclusively created when empty) and gives
/// how many bytes it now holds. A byte past the length is corruption.
fn append(partial: &Path, current: u64, byte_length: u64, source: &mut impl Read) -> Result<u64> {
    let mut file = if current == 0 {
        // Exclusive create, so concurrent receivers fail closed.
        unlink_owned(partial)?;
        let file = no_follow(
            OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(PARTIAL_MODE),
        )
        .open(partial)?;
        let _ = file.set_permissions(Permissions::from_mode(PARTIAL_MODE));
        file
    } else {
        no_follow(OpenOptions::new().append(true)).open(partial)?
    };
    let mut buffer = vec![0u8; READ_CHUNK];
    let mut received = current;
    loop {
        let n = match source.read(&mut buffer) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e.into()),
        };
        let remaining = byte_length - received;
        let take = (n as u64).min(remaining) as usize;
        file.write_all(&buffer[..take])?;
        received += take as u64;
        if take < n {
            return Err(StoreError::new(
                Code::Corrupt,
                "content transfer received more bytes than ContentRef byteLength",
            ));
        }
    }
    rustix::fs::fsync(&file).map_err(io::Error::from)?;
    Ok(received)
}

// --- the status line (encodeContentHelperStatus) ----------------------------

#[derive(Serialize)]
#[serde(untagged)]
enum Status<'a> {
    Ok {
        ok: bool,
        #[serde(flatten)]
        state: State<'a>,
    },
    Err {
        ok: bool,
        error: String,
    },
}

#[derive(Serialize)]
#[serde(
    tag = "state",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
enum State<'a> {
    Verified {
        sha256: &'a Sha256Hex,
        byte_length: u64,
        verified_at: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        created: Option<bool>,
    },
    Partial {
        sha256: &'a Sha256Hex,
        byte_length: u64,
        received_bytes: u64,
    },
    Missing {
        sha256: &'a Sha256Hex,
        byte_length: u64,
        reason: &'static str,
    },
    Corrupt {
        sha256: &'a Sha256Hex,
        byte_length: u64,
        reason: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        observed_sha256: Option<Sha256Hex>,
        #[serde(skip_serializing_if = "Option::is_none")]
        observed_byte_length: Option<u64>,
    },
}

impl Status<'_> {
    fn failed(message: &str) -> Self {
        Status::Err {
            ok: false,
            error: clip(message),
        }
    }

    fn line(&self) -> Vec<u8> {
        let mut bytes = serde_json::to_vec(self).unwrap_or_default();
        bytes.push(b'\n');
        bytes
    }
}

/// message.slice(0, 1024), counted in UTF-16 units as JavaScript counts.
fn clip(message: &str) -> String {
    let mut units = 0;
    message
        .chars()
        .take_while(|c| {
            units += c.len_utf16();
            units <= 1024
        })
        .collect()
}

// --- the command ------------------------------------------------------------

pub fn run(argv: &[&str]) -> ExitCode {
    let request = match parse(argv) {
        Ok(request) => request,
        Err(error) => {
            crate::envelope::warn(&format!("junto content-transfer: {error}"));
            return ExitCode::from(64);
        }
    };
    let store = Store::at_home();
    let (sha256, byte_length) = (&request.sha256, request.byte_length);
    // A send streams its bytes on stdout, so its failures go to stderr.
    let (outcome, to_stderr) = match request.mode {
        Mode::Stat => (stat(&store, sha256, byte_length), false),
        Mode::Send { offset } => (send(&store, sha256, byte_length, offset), true),
        Mode::Receive { offset } => {
            let received = receive(&store, sha256, byte_length, offset, &mut io::stdin().lock());
            let status = received.map(|received| match received {
                Received::Verified(Published {
                    created,
                    verified_at,
                }) => Some(State::Verified {
                    sha256,
                    byte_length,
                    verified_at,
                    created: Some(created),
                }),
                Received::Partial { bytes } => Some(State::Partial {
                    sha256,
                    byte_length,
                    received_bytes: bytes,
                }),
            });
            (status.map(|state| (state, ExitCode::SUCCESS)), false)
        }
    };
    let (line, code) = match outcome {
        Ok((None, code)) => return code,
        Ok((Some(state), code)) => (Status::Ok { ok: true, state }.line(), code),
        Err(error) => {
            let code = if error.code == Code::Corrupt { 2 } else { 1 };
            (Status::failed(&error.message).line(), ExitCode::from(code))
        }
    };
    // A closed pipe has no one left to tell.
    let _ = if to_stderr {
        io::stderr().write_all(&line)
    } else {
        io::stdout().write_all(&line)
    };
    code
}

type Outcome<'a> = Result<(Option<State<'a>>, ExitCode)>;

fn stat<'a>(store: &Store, sha256: &'a Sha256Hex, byte_length: u64) -> Outcome<'a> {
    Ok(match inspect(store, sha256, byte_length)? {
        Local::Verified { verified_at, .. } => (
            Some(State::Verified {
                sha256,
                byte_length,
                verified_at,
                created: None,
            }),
            ExitCode::SUCCESS,
        ),
        Local::Partial { bytes } => (
            Some(State::Partial {
                sha256,
                byte_length,
                received_bytes: bytes,
            }),
            ExitCode::SUCCESS,
        ),
        Local::Missing { reason } => (
            Some(State::Missing {
                sha256,
                byte_length,
                reason,
            }),
            ExitCode::SUCCESS,
        ),
        Local::Corrupt {
            reason,
            observed_sha256,
            observed_byte_length,
        } => (
            Some(State::Corrupt {
                sha256,
                byte_length,
                reason,
                observed_sha256,
                observed_byte_length,
            }),
            ExitCode::FAILURE,
        ),
    })
}

/// Streams a verified object from `offset`; anything unverified is refused.
fn send<'a>(store: &Store, sha256: &'a Sha256Hex, byte_length: u64, offset: u64) -> Outcome<'a> {
    // Refused before any byte: exit 1, whatever is wrong with the object.
    let path = match inspect(store, sha256, byte_length)? {
        Local::Verified { path, .. } => path,
        Local::Missing { .. } => {
            return Err(StoreError::new(
                Code::Missing,
                "content object is not available to send",
            ));
        }
        _ => {
            return Err(StoreError::new(
                Code::Invalid,
                "content object is not verified for send",
            ));
        }
    };
    let mut file = no_follow(OpenOptions::new().read(true)).open(&path)?;
    file.seek(io::SeekFrom::Start(offset))?;
    let mut stdout = io::stdout().lock();
    // A receiver that hung up ends the send: it resumes from what it holds.
    let copied = io::copy(
        &mut io::BufReader::with_capacity(READ_CHUNK, file),
        &mut stdout,
    )
    .and_then(|_| stdout.flush());
    super::closed_is_end(copied)?;
    Ok((None, ExitCode::SUCCESS))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHA: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

    #[test]
    fn admits_only_the_closed_argv() {
        let ok = |argv: &[&str]| parse(argv).map(|r| r.mode);
        assert_eq!(ok(&["stat", SHA, "0"]), Ok(Mode::Stat));
        assert_eq!(ok(&["receive", SHA, "10"]), Ok(Mode::Receive { offset: 0 }));
        assert_eq!(
            ok(&["send", SHA, "10", "10"]),
            Ok(Mode::Send { offset: 10 })
        );
        assert_eq!(ok(&[]), Err("content helper mode is required".into()));
        assert_eq!(
            ok(&["copy", SHA, "1"]),
            Err("content helper mode is not admitted".into())
        );
        assert_eq!(
            ok(&["stat", SHA]),
            Err("content helper stat requires <sha256> <byteLength>".into())
        );
        assert_eq!(
            ok(&["send", SHA]),
            Err("content helper send requires <sha256> <byteLength> [offset]".into())
        );
        assert_eq!(
            ok(&["send", SHA, "1", "2"]),
            Err("content helper offset/byteLength is out of range".into())
        );
        assert_eq!(
            ok(&["stat", SHA, "9999999999999999"]),
            Err("content helper byteLength is not a safe integer".into())
        );
        for bad in [
            &["stat", &SHA.to_uppercase(), "1"][..],
            &["stat", SHA, "01"],
            &["stat", SHA, "-1"],
            &["send", SHA, "1", ""],
        ] {
            assert_eq!(
                ok(bad),
                Err("content helper identity tokens are invalid".into()),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn writes_the_status_line_in_its_key_order() {
        let sha = Sha256Hex(SHA.into());
        let line = |state| String::from_utf8(Status::Ok { ok: true, state }.line()).unwrap();
        assert_eq!(
            line(State::Partial {
                sha256: &sha,
                byte_length: 3,
                received_bytes: 1
            }),
            format!(
                "{{\"ok\":true,\"state\":\"partial\",\"sha256\":\"{SHA}\",\"byteLength\":3,\"receivedBytes\":1}}\n"
            )
        );
        assert_eq!(
            line(State::Corrupt {
                sha256: &sha,
                byte_length: 3,
                reason: "r".into(),
                observed_sha256: None,
                observed_byte_length: Some(4)
            }),
            format!(
                "{{\"ok\":true,\"state\":\"corrupt\",\"sha256\":\"{SHA}\",\"byteLength\":3,\"reason\":\"r\",\"observedByteLength\":4}}\n"
            )
        );
        assert_eq!(
            String::from_utf8(Status::failed("no").line()).unwrap(),
            "{\"ok\":false,\"error\":\"no\"}\n"
        );
    }

    #[test]
    fn receives_resumes_and_publishes_once() {
        let home = std::env::temp_dir().join(format!("jct-{}", ulid::Ulid::new()));
        let store = Store {
            root: home.join("v1"),
        };
        let bytes = b"hello, store";
        let sha = Sha256Hex(
            Sha256::digest(bytes)
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect(),
        );
        let len = bytes.len() as u64;

        let first = receive(&store, &sha, len, 0, &mut &bytes[..5]).unwrap();
        assert!(matches!(first, Received::Partial { bytes: 5 }));
        assert!(
            receive(&store, &sha, len, 0, &mut &bytes[..]).is_err_and(|e| e.code == Code::Invalid)
        );
        let done = receive(&store, &sha, len, 5, &mut &bytes[5..]).unwrap();
        assert!(matches!(
            done,
            Received::Verified(Published { created: true, .. })
        ));
        let again = receive(&store, &sha, len, 0, &mut &b""[..]).unwrap();
        assert!(matches!(
            again,
            Received::Verified(Published { created: false, .. })
        ));
        assert!(matches!(
            inspect(&store, &sha, len).unwrap(),
            Local::Verified { .. }
        ));

        let other = Sha256Hex("0".repeat(64));
        let wrong = receive(&store, &other, 2, 0, &mut &b"ab"[..]);
        assert!(wrong.is_err_and(|e| e.code == Code::Corrupt));
        assert!(matches!(
            entry(&store.partial(&other)).unwrap(),
            Entry::Absent
        ));
        let _ = fs::remove_dir_all(home);
    }
}
