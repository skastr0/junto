//! The success and failure envelopes:
//! `{"ok":true,"command","data"}` on stdout, `{"ok":false,"command"?,"error"}`
//! on stderr with exit 1.

use std::io::Write;
use std::process::ExitCode;

use serde::{Deserialize, Serialize};
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
    refuse_with(command, error, ExitCode::FAILURE)
}

/// The failure envelope on stderr with the code the caller chose: a boot check
/// that an install owns the machine answers 75 rather than 1.
pub fn refuse_with(command: Option<&str>, error: &Failure, code: ExitCode) -> ExitCode {
    line(
        &mut std::io::stderr(),
        &Refusal {
            ok: false,
            command,
            error,
        },
    );
    // A refused machine send carries the take-over preview as typed fields.
    // The command is fixed argv parts, after the error and never inside its
    // words; a field outside the near side's own shapes prints nothing.
    if let Some(next) = takeover_command(error) {
        warn(&next);
    }
    code
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Takeover {
    machine_name: String,
    installation_id: String,
    previous_installation_id: String,
}

/// `junto machine takeover <machineName> <installationId>`, only when both are
/// in the shape the near side admits: 1-64 for the name, 1-128 for the id,
/// each starting with a letter or digit, no shell metacharacter.
fn takeover_command(error: &Failure) -> Option<String> {
    let takeover = error.details.as_ref()?.get("takeover")?;
    let takeover: Takeover = serde_json::from_value(takeover.clone()).ok()?;
    if !machine_name_is_valid(&takeover.machine_name)
        || !installation_id_is_valid(&takeover.installation_id)
        || !installation_id_is_valid(&takeover.previous_installation_id)
    {
        return None;
    }
    Some(format!(
        "junto machine takeover {} {}",
        takeover.machine_name, takeover.installation_id
    ))
}

fn machine_name_is_valid(value: &str) -> bool {
    value != "local"
        && (1..=64).contains(&value.len())
        && value
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphanumeric())
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

fn installation_id_is_valid(value: &str) -> bool {
    (1..=128).contains(&value.len())
        && value
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphanumeric())
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-'))
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
