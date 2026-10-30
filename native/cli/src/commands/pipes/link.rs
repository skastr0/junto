//! `junto link [--opener <installation id>]` (src/cli/link.ts): a stream relay
//! between stdio and the core's control socket. The core admits the peer and
//! owns every frame; this side only copies bytes, each half closing on its own.

use std::io::{self, Read, Write};
use std::net::Shutdown;
use std::os::unix::net::UnixStream;
use std::process::ExitCode;
use std::thread;

use crate::wire;

use super::Usage;

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
        format!("{}\n", serde_json::json!({ "type": "opener", "installationId": self.0 }))
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
        eprintln!("junto link takes no arguments, or --opener <installation id>");
        return ExitCode::from(64);
    };
    let path = wire::junto_home().join(".junto/core/control.sock");
    match relay(&path, opener.as_ref()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("junto link: {error}");
            ExitCode::FAILURE
        }
    }
}

/// Stdin to the socket on one thread, the socket to stdout on this one. Stdin
/// ending ends the socket's write half; the far end closing ends the relay.
fn relay(path: &std::path::Path, opener: Option<&Opener>) -> io::Result<()> {
    let mut socket = UnixStream::connect(path)
        .map_err(|e| io::Error::new(e.kind(), format!("connect {e} {}", path.display())))?;
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

/// Copies until end of stream, flushing each read: frames go out as they come.
fn copy_flushing(from: &mut impl Read, to: &mut impl Write) -> io::Result<()> {
    let mut buffer = [0u8; 64 * 1024];
    loop {
        match from.read(&mut buffer) {
            Ok(0) => return to.flush(),
            Ok(n) => {
                to.write_all(&buffer[..n])?;
                to.flush()?;
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
        for bad in [&["--opener"][..], &["--opener", ""], &["--opener", "-x"], &["x"], &["--opener", "a", "b"]] {
            assert!(parse(bad).is_err(), "{bad:?}");
        }
        assert!(Opener::parse(&"a".repeat(129)).is_none());
        assert_eq!(
            Opener::parse("i1").map(|o| o.line()),
            Some("{\"type\":\"opener\",\"installationId\":\"i1\"}\n".into())
        );
    }
}
