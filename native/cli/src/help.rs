//! Help, built in so it answers with nothing running: `--help` or `-h`
//! anywhere on the line, as the TypeScript CLI's parser reads it.

use std::process::ExitCode;

use crate::commands::Pending;

pub fn asked(words: &[&str]) -> bool {
    words.iter().any(|w| matches!(*w, "--help" | "-h"))
}

pub fn show(_words: &[&str]) -> ExitCode {
    Pending::refuse("help")
}
