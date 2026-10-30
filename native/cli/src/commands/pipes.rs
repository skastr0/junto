//! The byte pipes, run before any parsing (src/cli/early-dispatch.ts):
//! `link` (src/cli/link.ts), `companion-stdio` (src/cli/companion-stdio.ts)
//! and `content-transfer` (src/cli/content-transfer.ts).

use std::process::ExitCode;

use super::Pending;

pub fn link(_args: &[&str]) -> ExitCode {
    Pending::refuse("link")
}

pub fn companion_stdio(_args: &[&str]) -> ExitCode {
    Pending::refuse("companion-stdio")
}

pub fn content_transfer(_args: &[&str]) -> ExitCode {
    Pending::refuse("content-transfer")
}
