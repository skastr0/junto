//! `junto link [--opener <installation id>]`: a stream relay between stdio and
//! the core's control socket. The core admits the peer and owns every frame;
//! this side only copies bytes, each half closing on its own.
//!
//! When the core is not running, one start of the service this binary belongs
//! to is attempted: `launchctl bootstrap`, then `launchctl kickstart` when
//! bootstrap refuses a job that is already loaded, or one `systemctl --user
//! start` (start.rs). Then the socket is polled once. Every other failure
//! stays a relay failure. The exit codes and fixed words live here, in one
//! place for this CLI.

use std::io::{self, Read, Write};
use std::net::Shutdown;
use std::os::unix::net::UnixStream;
use std::process::ExitCode;
use std::thread;

use crate::{envelope, wire};

use super::Usage;

mod start;

/// The one place this CLI names its exit codes. 3 and 4 are free in
/// native/cli/src/main.rs, which uses 0, 1, 2 and 64.
const USAGE: u8 = 64;
const GENERIC: u8 = 1;
const CORE_NOT_RUNNING: u8 = 3;
const MACHINE_UPDATING: u8 = 4;
/// ssh's own code for an unreachable machine; junto link never returns it,
/// so only the test that pins the codes names it.
#[cfg(test)]
const UNREACHABLE: u8 = 255;

/// The fixed words this CLI speaks, pinned by the test below.
const STARTING: &str = "junto link: starting the Junto core";
const CORE_NOT_RUNNING_WORDS: &str = "junto link: the Junto core is not running";
const MACHINE_UPDATING_WORDS: &str = "junto link: Junto is updating on this machine";
const CANNOT_REACH_WORDS: &str = "junto link: cannot reach the Junto core";

/// An installation a link key's forced command names (InstallationId,
/// src/shared/installation-id.ts).
struct Opener(String);

impl Opener {
    fn parse(text: &str) -> Option<Self> {
        let mut bytes = text.bytes();
        let first = bytes.next()?;
        let valid = text.len() <= 128
            && first.is_ascii_alphanumeric()
            && bytes.all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-'));
        valid.then(|| Opener(text.to_string()))
    }

    /// The one first line, before any byte from the far end.
    fn line(&self) -> String {
        format!(
            "{}\n",
            serde_json::json!({ "type": "opener", "installationId": self.0 })
        )
    }
}

/// The opener comes from argv alone, as the forced command wrote it: never
/// SSH_ORIGINAL_COMMAND or an environment value the far end could send.
fn parse(args: &[&str]) -> Result<Option<Opener>, Usage> {
    match args {
        [] => Ok(None),
        ["--opener", id] => Opener::parse(id).map(Some).ok_or(Usage),
        _ => Err(Usage),
    }
}

pub fn run(args: &[&str]) -> ExitCode {
    let Ok(opener) = parse(args) else {
        envelope::warn("junto link takes no arguments, or --opener <installation id>");
        return ExitCode::from(USAGE);
    };
    let home = wire::junto_home();
    let path = home.join(".junto/core/control.sock");
    // The first connect is the whole fast path: nothing is read, waited on or
    // run before it. A service start happens only when the core is absent.
    let socket = match UnixStream::connect(&path) {
        Ok(socket) => socket,
        Err(error) if core_absent(&error) => match start::start_and_connect(&home, &path) {
            Ok(socket) => socket,
            Err(start::Refusal::Updating) => {
                envelope::warn(MACHINE_UPDATING_WORDS);
                return ExitCode::from(MACHINE_UPDATING);
            }
            Err(start::Refusal::NotRunning) => {
                envelope::warn(CORE_NOT_RUNNING_WORDS);
                return ExitCode::from(CORE_NOT_RUNNING);
            }
        },
        Err(_) => {
            envelope::warn(CANNOT_REACH_WORDS);
            return ExitCode::from(GENERIC);
        }
    };
    match relay(socket, opener.as_ref()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            envelope::warn(&format!("junto link: {error}"));
            ExitCode::from(GENERIC)
        }
    }
}

/// The core has no one listening: its socket is gone, or a stale one refuses.
fn core_absent(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused
    )
}

/// Stdin to the socket on one thread, the socket to stdout on this one. Stdin
/// ending ends the socket's write half; the far end closing ends the relay.
fn relay(mut socket: UnixStream, opener: Option<&Opener>) -> io::Result<()> {
    if let Some(opener) = opener {
        socket.write_all(opener.line().as_bytes())?;
    }
    let mut upstream = socket.try_clone()?;
    // Detached: once the far end is gone, a stdin still open has nowhere to go.
    thread::spawn(move || {
        let copied = io::copy(&mut io::stdin().lock(), &mut upstream);
        let _ = upstream.shutdown(Shutdown::Write);
        copied
    });
    let mut stdout = io::stdout().lock();
    let copied = copy_flushing(&mut socket, &mut stdout);
    let _ = socket.shutdown(Shutdown::Both);
    copied
}

/// Copies until end of stream, flushing each read: frames go out as they
/// come. A reader that hung up ends the copy as the far end closing would.
fn copy_flushing(from: &mut impl Read, to: &mut impl Write) -> io::Result<()> {
    let mut buffer = [0u8; 64 * 1024];
    loop {
        match from.read(&mut buffer) {
            Ok(0) => return super::closed_is_end(to.flush()),
            Ok(n) => {
                let written = to.write_all(&buffer[..n]).and_then(|()| to.flush());
                if written
                    .as_ref()
                    .is_err_and(|e| e.kind() == io::ErrorKind::BrokenPipe)
                {
                    return Ok(());
                }
                written?;
            }
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_opener_from_argv_alone() {
        assert!(matches!(parse(&[]), Ok(None)));
        assert!(matches!(parse(&["--opener", "inst-1.a:b_c"]), Ok(Some(_))));
        for bad in [
            &["--opener"][..],
            &["--opener", ""],
            &["--opener", "-x"],
            &["x"],
            &["--opener", "a", "b"],
        ] {
            assert!(parse(bad).is_err(), "{bad:?}");
        }
        assert!(Opener::parse(&"a".repeat(129)).is_none());
        assert_eq!(
            Opener::parse("i1").map(|o| o.line()),
            Some("{\"type\":\"opener\",\"installationId\":\"i1\"}\n".into())
        );
    }

    #[test]
    fn an_absent_core_is_a_missing_or_stale_socket_only() {
        assert!(core_absent(&io::Error::from(io::ErrorKind::NotFound)));
        assert!(core_absent(&io::Error::from(
            io::ErrorKind::ConnectionRefused
        )));
        assert!(!core_absent(&io::Error::from(
            io::ErrorKind::PermissionDenied
        )));
        assert!(!core_absent(&io::Error::from(io::ErrorKind::TimedOut)));
    }

    #[test]
    fn the_contract_codes_and_words_are_the_pinned_ones() {
        assert_eq!(
            (
                USAGE,
                GENERIC,
                CORE_NOT_RUNNING,
                MACHINE_UPDATING,
                UNREACHABLE
            ),
            (64, 1, 3, 4, 255)
        );
        assert_eq!(STARTING, "junto link: starting the Junto core");
        assert_eq!(
            CORE_NOT_RUNNING_WORDS,
            "junto link: the Junto core is not running"
        );
        assert_eq!(
            MACHINE_UPDATING_WORDS,
            "junto link: Junto is updating on this machine"
        );
        assert_eq!(
            CANNOT_REACH_WORDS,
            "junto link: cannot reach the Junto core"
        );
    }
}
