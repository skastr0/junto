//! The operator socket client (N6, cli-identity), as src/cli/core/operator-socket.ts
//! speaks it: the owner's commands, one NDJSON request and one response line
//! over `~/.junto/operator/control.sock`, refused from inside a seat.

use std::io::{BufRead, BufReader, ErrorKind, Read, Write};
use std::os::unix::net::UnixStream;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{ErrorType, Failure, Result};
use crate::wire::{self, Data};

/// src/shared/operator-control.ts.
const PROTOCOL: &str = "junto-operator/v1";
const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const MIN_TIMEOUT_MS: u64 = 250;
const MAX_TIMEOUT_MS: u64 = 15 * 60_000;
const MAX_REQUEST_BYTES: usize = 320 * 1024;
const MAX_RESPONSE_BYTES: u64 = 544 * 1024;

/// owner-access.ts: a seat never runs owner or machine commands.
const OWNER_COMMAND_REFUSAL: &str = "Owner and machine commands are unavailable from a Junto seat.";

/// requireOwnerCommand: the caller is the owner, never a seat.
pub fn require_owner() -> Result<()> {
    match std::env::var_os("JUNTO_WORK_TOKEN") {
        Some(_) => Err(Failure::new(ErrorType::AuthError, OWNER_COMMAND_REFUSAL)),
        None => Ok(()),
    }
}

/// One owner op: its answer's data, or the failure the TypeScript CLI gives.
/// `timeout_ms` is the op's own bound; the socket's default when `None`.
pub fn call<A: Serialize + ?Sized>(op: &str, args: &A, timeout_ms: Option<u64>) -> Result<Data> {
    require_owner()?;
    let timeout = timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS);
    if !(MIN_TIMEOUT_MS..=MAX_TIMEOUT_MS).contains(&timeout) {
        return Err(Failure::new(
            ErrorType::InputError,
            "operator timeout is outside the admitted range",
        ));
    }
    let id = ulid::Ulid::new().to_string();
    let mut frame = serde_json::to_vec(&Request {
        protocol: PROTOCOL,
        id: &id,
        op,
        args,
    })
    .map_err(|e| protocol(e.to_string()))?;
    frame.push(b'\n');
    if frame.len() > MAX_REQUEST_BYTES {
        return Err(protocol(format!(
            "operator control frame exceeds {MAX_REQUEST_BYTES} bytes"
        )));
    }
    let line = exchange(op, &frame, timeout)?;
    let response = decode(&line)?;
    if response.id.as_deref() != Some(id.as_str()) || response.op.as_deref() != Some(op) {
        return Err(protocol(
            "operator response does not match the request".into(),
        ));
    }
    response.into_result()
}

#[derive(Serialize)]
struct Request<'a, A: Serialize + ?Sized> {
    protocol: &'static str,
    id: &'a str,
    op: &'a str,
    args: &'a A,
}

fn protocol(message: String) -> Failure {
    Failure::new(ErrorType::ProtocolError, message)
}

fn runtime_down() -> Failure {
    Failure::next_step(
        ErrorType::RuntimeDown,
        "Junto operator control is unavailable",
        "start Junto for this home, then retry this command",
    )
}

/// A read that may be asked again without harm: a timed-out one says so.
fn retryable(op: &str) -> bool {
    matches!(
        op,
        "machine.status" | "machine.list" | "machine.harnesses" | "machine.exchange"
    ) || op.starts_with("companion.")
}

/// Sends the frame and reads one response line, inside `timeout_ms` from
/// before the connect.
fn exchange(op: &str, frame: &[u8], timeout_ms: u64) -> Result<Vec<u8>> {
    let started = Instant::now();
    let bound = Duration::from_millis(timeout_ms);
    let timed_out = || {
        protocol(format!("operator request timed out after {timeout_ms}ms"))
            .with(serde_json::json!({ "retryable": retryable(op) }))
    };
    let left = || {
        bound
            .checked_sub(started.elapsed())
            .filter(|d| !d.is_zero())
            .ok_or_else(timed_out)
    };
    let io = |error: std::io::Error| match error.kind() {
        ErrorKind::WouldBlock | ErrorKind::TimedOut => timed_out(),
        _ => Failure::new(ErrorType::InternalError, error.to_string()),
    };

    let path = wire::junto_home().join(".junto/operator/control.sock");
    let mut stream = UnixStream::connect(&path).map_err(|error| match error.kind() {
        ErrorKind::NotFound | ErrorKind::ConnectionRefused | ErrorKind::PermissionDenied => {
            runtime_down()
        }
        _ => Failure::new(ErrorType::InternalError, error.to_string()),
    })?;
    stream.set_write_timeout(Some(left()?)).map_err(io)?;
    stream.write_all(frame).map_err(io)?;

    let mut reader = BufReader::new(&stream).take(MAX_RESPONSE_BYTES + 1);
    let mut line = Vec::new();
    loop {
        stream.set_read_timeout(Some(left()?)).map_err(io)?;
        match reader.read_until(b'\n', &mut line) {
            Ok(_) if line.len() as u64 > MAX_RESPONSE_BYTES => {
                return Err(protocol(format!(
                    "operator response exceeds {MAX_RESPONSE_BYTES} bytes"
                )));
            }
            Ok(_) if line.ends_with(b"\n") => break,
            Ok(0) => {
                return Err(protocol(
                    "operator socket closed before its response".into(),
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == ErrorKind::Interrupted => {}
            Err(error) => return Err(io(error)),
        }
    }
    // What came after the line, already read, is whitespace or a second response.
    if reader
        .get_ref()
        .buffer()
        .iter()
        .any(|b| !b" \t\r\n".contains(b))
    {
        return Err(protocol(
            "operator server returned more than one response".into(),
        ));
    }
    line.pop();
    if line.last() == Some(&b'\r') {
        line.pop();
    }
    Ok(line)
}

/// The response envelope; anything else is malformed.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Response {
    #[allow(dead_code)]
    protocol: Protocol,
    id: Option<String>,
    ok: bool,
    op: Option<String>,
    data: Option<Data>,
    error: Option<WireError>,
}

#[derive(Deserialize)]
enum Protocol {
    #[serde(rename = "junto-operator/v1")]
    V1,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WireError {
    #[serde(rename = "type")]
    kind: OperatorErrorType,
    message: String,
    details: Option<Value>,
}

/// OperatorErrorType: what the socket names a failure.
#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "snake_case")]
enum OperatorErrorType {
    Validation,
    NotFound,
    Conflict,
    Io,
    RuntimeDown,
    AuthError,
    ProtocolError,
    Forbidden,
    Shutdown,
    InternalError,
}

fn decode(line: &[u8]) -> Result<Response> {
    let text = std::str::from_utf8(line)
        .map_err(|_| protocol("operator server returned non-JSON or invalid UTF-8".into()))?;
    serde_json::from_str(text).map_err(|error| match error.classify() {
        serde_json::error::Category::Syntax | serde_json::error::Category::Eof => {
            protocol("operator server returned non-JSON or invalid UTF-8".into())
        }
        _ => protocol("operator server returned a malformed envelope".into()),
    })
}

impl Response {
    fn into_result(self) -> Result<Data> {
        match self {
            Response {
                ok: true,
                data: Some(data),
                error: None,
                ..
            } => Ok(data),
            Response {
                ok: false,
                data: None,
                error: Some(error),
                ..
            } => Err(error.into()),
            _ => Err(protocol(
                "operator server returned a malformed envelope".into(),
            )),
        }
    }
}

impl From<WireError> for Failure {
    fn from(error: WireError) -> Self {
        let next_step = || {
            error
                .details
                .as_ref()
                .and_then(|d| d.get("next_step"))
                .and_then(Value::as_str)
        };
        let carried = |kind| match next_step() {
            Some(next) => Failure::next_step(kind, error.message.clone(), next),
            None => Failure::new(kind, error.message.clone()),
        };
        let kind = match error.kind {
            OperatorErrorType::RuntimeDown | OperatorErrorType::Shutdown => {
                return carried(ErrorType::RuntimeDown);
            }
            OperatorErrorType::AuthError | OperatorErrorType::Forbidden => {
                return carried(ErrorType::AuthError);
            }
            OperatorErrorType::Validation => ErrorType::Validation,
            OperatorErrorType::NotFound => ErrorType::OperatorNotFound,
            OperatorErrorType::Conflict => ErrorType::OperatorConflict,
            OperatorErrorType::Io => ErrorType::Io,
            OperatorErrorType::ProtocolError => ErrorType::OperatorProtocolError,
            OperatorErrorType::InternalError => ErrorType::OperatorInternalError,
        };
        let failure = Failure::new(kind, error.message);
        match error.details {
            Some(details) => failure.with(details),
            None => failure,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn outcome(line: &str) -> std::result::Result<String, String> {
        decode(line.as_bytes())
            .and_then(Response::into_result)
            .map(|data| data.get().to_string())
            .map_err(|f| serde_json::to_string(&f).unwrap_or_default())
    }

    #[test]
    fn decodes_the_operator_envelope() {
        assert_eq!(
            outcome(
                r#"{"protocol":"junto-operator/v1","id":"a","ok":true,"op":"machine.list","data":{"x":1}}"#
            ),
            Ok(r#"{"x":1}"#.into())
        );
        assert_eq!(
            outcome(
                r#"{"protocol":"junto-operator/v1","ok":false,"error":{"type":"shutdown","message":"m","details":{"next_step":"n","retryable":true}}}"#
            ),
            Err(r#"{"type":"RuntimeDown","message":"m","details":{"next_step":"n"}}"#.into())
        );
        assert_eq!(
            outcome(
                r#"{"protocol":"junto-operator/v1","ok":false,"error":{"type":"not_found","message":"m","details":{"path":"name"}}}"#
            ),
            Err(r#"{"type":"not_found","message":"m","details":{"path":"name"}}"#.into())
        );
        for bad in [
            r#"{"protocol":"junto-operator/v2","ok":true,"data":1}"#,
            r#"{"protocol":"junto-operator/v1","ok":true}"#,
            r#"{"protocol":"junto-operator/v1","ok":true,"data":1,"more":1}"#,
            "not json",
        ] {
            assert!(outcome(bad).is_err(), "{bad}");
        }
    }
}
