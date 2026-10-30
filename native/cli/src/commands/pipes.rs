//! The byte pipes, run before any parsing (src/cli/early-dispatch.ts):
//! `link` (src/cli/link.ts), `companion-stdio` (src/cli/companion-stdio.ts)
//! and `content-transfer` (src/cli/content-transfer.ts). Each owns its stdio
//! and its exit code; none prints an envelope.

use std::io;
use std::process::ExitCode;

mod companion;
mod content_transfer;
mod link;

/// An argv a pipe does not take: it says so on stderr and exits 64 (EX_USAGE).
#[derive(Debug)]
struct Usage;

/// A write to a reader that hung up is the end of the stream, not a failure.
fn closed_is_end(written: io::Result<()>) -> io::Result<()> {
    match written {
        Err(e) if e.kind() == io::ErrorKind::BrokenPipe => Ok(()),
        other => other,
    }
}

pub fn link(args: &[&str]) -> ExitCode {
    link::run(args)
}

pub fn companion_stdio(args: &[&str]) -> ExitCode {
    companion::run(args)
}

pub fn content_transfer(args: &[&str]) -> ExitCode {
    content_transfer::run(args)
}
