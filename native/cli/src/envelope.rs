//! The success and failure envelopes, as src/cli/core/output.ts writes them:
//! `{"ok":true,"command","data"}` on stdout, `{"ok":false,"command"?,"error"}`
//! on stderr with exit 1.

use std::io::Write;
use std::process::ExitCode;

use serde::Serialize;
use serde_json::value::{RawValue, to_raw_value};

use crate::error::{ErrorType, Failure, Result};
use crate::wire::Data;

/// What a command answers: its data, and whether it carries bad news that
/// sets exit 1 while still printing whole (executeJsonCommandWithVerdict).
pub struct Reply {
    pub data: Data,
    pub unmet: bool,
}

pub type Answer = Result<Reply>;

impl From<Data> for Reply {
    fn from(data: Data) -> Self {
        Reply { data, unmet: false }
    }
}

/// Data built here, answered in full.
pub fn ok<T: Serialize + ?Sized>(data: &T) -> Answer {
    verdict(data, false)
}

/// Data built here, answered in full; `unmet` sets exit 1.
pub fn verdict<T: Serialize + ?Sized>(data: &T, unmet: bool) -> Answer {
    to_raw_value(data)
        .map(|data| Reply { data, unmet })
        .map_err(|e| Failure::new(ErrorType::InternalError, e.to_string()))
}

#[derive(Serialize)]
struct Success<'a> {
    ok: bool,
    command: &'a str,
    data: &'a RawValue,
}

#[derive(Serialize)]
struct Refusal<'a> {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    command: Option<&'a str>,
    error: &'a Failure,
}

/// Prints the answer's envelope and gives the exit code.
pub fn print(command: &str, answer: Answer) -> ExitCode {
    match answer {
        Ok(Reply { data, unmet }) => {
            line(
                &mut std::io::stdout(),
                &Success {
                    ok: true,
                    command,
                    data: &data,
                },
            );
            if unmet {
                ExitCode::FAILURE
            } else {
                ExitCode::SUCCESS
            }
        }
        Err(failure) => refuse(Some(command), &failure),
    }
}

/// The failure envelope on stderr, exit 1.
pub fn refuse(command: Option<&str>, error: &Failure) -> ExitCode {
    line(
        &mut std::io::stderr(),
        &Refusal {
            ok: false,
            command,
            error,
        },
    );
    ExitCode::FAILURE
}

/// One line of text on stdout. A reader that hung up has no one left to
/// tell, so a closed pipe is not a panic (println! would abort).
pub fn say(text: &str) {
    let _ = writeln!(std::io::stdout(), "{text}");
}

/// One line of text on stderr, as `say`.
pub fn warn(text: &str) {
    let _ = writeln!(std::io::stderr(), "{text}");
}

fn line<T: Serialize>(out: &mut impl Write, value: &T) {
    let mut bytes = serde_json::to_vec(value).unwrap_or_default();
    bytes.push(b'\n');
    // A closed pipe has no one left to tell.
    let _ = out.write_all(&bytes);
}
