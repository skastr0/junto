//! The seat's work control socket, as src/cli/core/socket.ts speaks it: one
//! newline-delimited JSON frame out with the seat credential, one line back,
//! and the same errors for every way that can fail. Blocking std I/O: one
//! connection per call, bounded by the call's timeout from before it connects.
//!
//! A request is a type: [`Request`] ties its arguments to the op that serves
//! them. The answer's `data` comes back as the runtime wrote it, untouched.

use std::fmt;
use std::io::{BufRead, BufReader, ErrorKind, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::value::RawValue;
use serde_json::{Value, json};

use crate::error::{ErrorType, Failure, Result};

/// WORK_MAX_FRAME_BYTES (src/shared/work-control.ts).
const MAX_FRAME_BYTES: u64 = 8 * 1024 * 1024;
const TOKEN_ENV: &str = "JUNTO_WORK_TOKEN";

/// A socket call's bound, in milliseconds (WORK_DEFAULT_TIMEOUT_MS by default).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Timeout(pub i64);

impl Default for Timeout {
    fn default() -> Self {
        Timeout(30_000)
    }
}

impl From<Option<i64>> for Timeout {
    fn from(ms: Option<i64>) -> Self {
        ms.map(Timeout).unwrap_or_default()
    }
}

/// An op's arguments: the type names the op that serves it.
pub trait Request: Serialize {
    const OP: &'static str;

    /// A write's id, when it carries one: a failed send names it.
    fn op_id(&self) -> Option<&OpId> {
        None
    }
}

/// Declares the op each argument type is sent to.
#[macro_export]
macro_rules! ops {
    ($($ty:ty => $op:literal),+ $(,)?) => {
        $(impl $crate::wire::Request for $ty { const OP: &'static str = $op; })+
    };
}

/// The answer's `data`, as the runtime's JSON.stringify wrote it.
pub type Data = Box<RawValue>;

/// A write's id: a ULID, minted here when the caller names none (mintOpId).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct OpId(String);

impl OpId {
    pub fn mint() -> Self {
        OpId(ulid::Ulid::new().to_string())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// The opId a run-time request carries at its top level (opIdInArgs).
    pub fn in_args(args: &Value) -> Option<OpId> {
        args.get("opId")
            .and_then(Value::as_str)
            .filter(|id| OpId::valid(id))
            .map(|id| OpId(id.to_string()))
    }

    fn valid(text: &str) -> bool {
        text.len() == 26
            && text.bytes().all(|b| {
                matches!(b, b'0'..=b'9' | b'A'..=b'H' | b'J' | b'K' | b'M' | b'N' | b'P'..=b'T' | b'V'..=b'Z')
            })
    }
}

impl<'de> Deserialize<'de> for OpId {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;
        if OpId::valid(&text) {
            Ok(OpId(text))
        } else {
            Err(serde::de::Error::custom(
                "Expected a string matching the RegExp ^[0-9A-HJKMNP-TV-Z]{26}$",
            ))
        }
    }
}

impl fmt::Display for OpId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().map(|v| v.trim().to_string())
}

/// `~/.junto`, or a usable JUNTO_HOME (resolveJuntoHome).
pub fn junto_home() -> PathBuf {
    let usable = |home: &String| {
        home.starts_with('/') && home.len() <= 4096 && !home.chars().any(char::is_control)
    };
    match env("JUNTO_HOME").filter(usable) {
        Some(home) => normalize(&home),
        None => std::env::home_dir().unwrap_or_else(|| PathBuf::from("/")),
    }
}

/// `~/.junto/work`, or JUNTO_WORK_HOME (resolveWorkHome).
pub fn work_home() -> PathBuf {
    env("JUNTO_WORK_HOME")
        .filter(|home| !home.is_empty())
        .map_or_else(|| junto_home().join(".junto").join("work"), PathBuf::from)
}

/// node:path resolve of an absolute path: `.`, `..` and repeated slashes go.
fn normalize(path: &str) -> PathBuf {
    let parts = path.split('/').fold(Vec::new(), |mut parts, part| {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            part => parts.push(part),
        }
        parts
    });
    PathBuf::from(format!("/{}", parts.join("/")))
}

/// The seat credential, or the AuthError the TypeScript CLI gives without one.
pub fn seat_token() -> Result<String> {
    env(TOKEN_ENV).filter(|t| !t.is_empty()).ok_or_else(|| {
        Failure::next_step(
            ErrorType::AuthError,
            "this process has no Junto seat credential",
            format!(
                "run the CLI from inside your Junto seat; if already inside one, check that the harness forwards {TOKEN_ENV} to tool shells instead of filtering it"
            ),
        )
    })
}

/// What a call may change, so a failure after it was sent says what to do:
/// a write with its id is sent again under it; a mutation without one is
/// looked at before it is sent again.
#[derive(Debug, Clone, Copy, Default)]
pub struct Change<'a> {
    /// The write's id (opIdInArgs, or the overseer request's own).
    pub op_id: Option<&'a OpId>,
    /// The operation that may have completed: a mail op, or an overseer mutation.
    pub mutation: Option<&'a str>,
}

fn is_mail(op: &str) -> bool {
    matches!(op, "msg.send" | "msg.prompt" | "msg.reply")
}

/// One call of `R::OP`: the answer's data, or the error the TypeScript CLI would give.
pub fn call<R: Request>(args: &R, timeout: Timeout) -> Result<Data> {
    let change = Change {
        op_id: args.op_id(),
        mutation: is_mail(R::OP).then_some(R::OP),
    };
    send(R::OP, args, change, timeout)
}

/// One call of an op named at run time, with arguments built at run time
/// (`junto op`, the overseer's closed commands), that changes nothing.
pub fn call_dynamic(op: &str, args: &Value, timeout: Timeout) -> Result<Data> {
    send(op, args, Change::default(), timeout)
}

/// One call of an op named at run time that may change something: a failure
/// after it was sent offers a replay under its id, or says it may have completed.
pub fn call_changing(op: &str, args: &Value, change: Change<'_>, timeout: Timeout) -> Result<Data> {
    send(op, args, change, timeout)
}

fn send<A: Serialize + ?Sized>(
    op: &str,
    args: &A,
    change: Change<'_>,
    timeout: Timeout,
) -> Result<Data> {
    let token = seat_token()?;
    let frame = Frame {
        token: &token,
        op,
        args,
    };
    Call {
        op,
        change,
        timeout,
    }
    .run(&frame)
}

#[derive(Serialize)]
struct Frame<'a, A: Serialize + ?Sized> {
    token: &'a str,
    op: &'a str,
    args: &'a A,
}

struct Call<'a> {
    op: &'a str,
    change: Change<'a>,
    timeout: Timeout,
}

/// How far a call got: past `Sent`, the request may have reached the runtime.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Stage {
    Unsent,
    Sent,
}

impl Call<'_> {
    fn run<F: Serialize>(&self, frame: &F) -> Result<Data> {
        let started = Instant::now();
        let bound = Duration::from_millis(self.timeout.0.max(0) as u64);
        let left = || {
            bound
                .checked_sub(started.elapsed())
                .filter(|d| !d.is_zero())
        };
        if self.timeout.0 <= 0 {
            return Err(self.timed_out(Stage::Unsent));
        }

        let path = work_home().join("control.sock");
        let mut stream = UnixStream::connect(&path).map_err(|error| match error.kind() {
            ErrorKind::NotFound | ErrorKind::ConnectionRefused => Failure::next_step(
                ErrorType::RuntimeDown,
                "Junto app is not running (work socket down)",
                "launch Junto, then `junto doctor`",
            ),
            _ => Failure::new(
                ErrorType::InternalError,
                format!("connect {} {}", errno_name(&error), path.display()),
            ),
        })?;

        // Identity is the seat generation credential in the frame; no client-supplied nodeRef.
        let mut bytes = serde_json::to_vec(frame)
            .map_err(|e| Failure::new(ErrorType::InternalError, e.to_string()))?;
        bytes.push(b'\n');
        let io = |stage| move |error: std::io::Error| self.io_failure(&error, stage);

        let wait = left().ok_or_else(|| self.timed_out(Stage::Sent))?;
        stream
            .set_write_timeout(Some(wait))
            .map_err(io(Stage::Sent))?;
        stream.write_all(&bytes).map_err(io(Stage::Sent))?;

        let mut reader = BufReader::new(&stream).take(MAX_FRAME_BYTES + 1);
        let mut line = Vec::new();
        loop {
            let wait = left().ok_or_else(|| self.timed_out(Stage::Sent))?;
            stream
                .set_read_timeout(Some(wait))
                .map_err(io(Stage::Sent))?;
            match reader.read_until(b'\n', &mut line) {
                Ok(_) if line.ends_with(b"\n") => break,
                Ok(_) if line.len() as u64 > MAX_FRAME_BYTES => {
                    return Err(self.transport(
                        ErrorType::ProtocolError,
                        format!("response exceeds {MAX_FRAME_BYTES} bytes"),
                        None,
                        Stage::Sent,
                    ));
                }
                Ok(0) => {
                    return Err(self.transport(
                        ErrorType::ProtocolError,
                        "socket closed before response".into(),
                        None,
                        Stage::Sent,
                    ));
                }
                Ok(_) => {}
                Err(error) if error.kind() == ErrorKind::Interrupted => {}
                Err(error) => return Err(self.io_failure(&error, Stage::Sent)),
            }
        }
        drop(reader);
        drop(stream);

        let text = String::from_utf8_lossy(&line);
        let malformed = |what: &str| {
            self.transport(
                ErrorType::ProtocolError,
                format!("server returned {what}"),
                None,
                Stage::Sent,
            )
        };
        let response: Response =
            serde_json::from_str(text.trim()).map_err(|error| match error.classify() {
                serde_json::error::Category::Syntax | serde_json::error::Category::Eof => {
                    malformed("non-JSON")
                }
                _ => malformed("a malformed envelope"),
            })?;
        response
            .into_result()
            .ok_or_else(|| malformed("a malformed envelope"))?
    }

    fn timed_out(&self, stage: Stage) -> Failure {
        self.transport(
            ErrorType::ProtocolError,
            format!("request timed out after {}ms", self.timeout.0),
            Some(json!({ "retryable": true })),
            stage,
        )
    }

    fn io_failure(&self, error: &std::io::Error, stage: Stage) -> Failure {
        match error.kind() {
            ErrorKind::WouldBlock | ErrorKind::TimedOut => self.timed_out(stage),
            _ => self.transport(
                ErrorType::InternalError,
                format!("socket {}", errno_name(error)),
                None,
                stage,
            ),
        }
    }

    /// A transport failure. Once sent, a write with its id is offered for
    /// replay under it (writeTimeout); mail and an overseer mutation without
    /// one may have completed, and mail is looked at before it is sent again.
    fn transport(
        &self,
        kind: ErrorType,
        message: String,
        details: Option<Value>,
        stage: Stage,
    ) -> Failure {
        let Change { op_id, mutation } = self.change;
        if stage == Stage::Sent
            && !is_mail(self.op)
            && let Some(id) = op_id
        {
            return Failure::new(ErrorType::Timeout, format!("{message}; the write may have applied"))
                .and("opId", id.as_str())
                .and("retryable", true)
                .and(
                    "next_step",
                    format!("send the same command again with --op-id {id}; it applies once, or read it with junto op show {id}"),
                );
        }
        let Some(operation) = mutation.filter(|_| stage == Stage::Sent) else {
            let failure = Failure::new(kind, message);
            return match details {
                Some(details) => failure.with(details),
                None => failure,
            };
        };
        let failure = Failure::new(
            ErrorType::UncertainCompletion,
            format!("{message}; operation {operation} may have completed"),
        )
        .and("retryable", false)
        .and("operation", operation);
        if !is_mail(operation) {
            return failure;
        }
        // Plain mail is never deduplicated, so it is never offered for replay;
        // only a comment is written once per opId.
        let look = "inspect msg sent before sending again; the mail may already be in the recipient's mailbox";
        match op_id {
            None => failure.and("next_step", look),
            Some(id) => failure.and("opId", id.as_str()).and(
                "next_step",
                format!("{look}. A comment on a task or a subject thread sent again with \"opId\": \"{id}\" is written once"),
            ),
        }
    }
}

pub(crate) fn errno_name(error: &std::io::Error) -> &'static str {
    match error.raw_os_error() {
        Some(1) => "EPERM",
        Some(2) => "ENOENT",
        Some(13) => "EACCES",
        Some(22) => "EINVAL",
        Some(32) => "EPIPE",
        Some(54 | 104) => "ECONNRESET",
        Some(38 | 88) => "ENOTSOCK",
        Some(36 | 63) => "ENAMETOOLONG",
        _ => "EIO",
    }
}

/// The runtime's answer envelope; anything else is malformed.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Response {
    ok: bool,
    op: Option<String>,
    data: Option<Data>,
    error: Option<WireError>,
    #[allow(dead_code)]
    id: Option<String>,
    #[allow(dead_code)]
    protocol_version: Option<String>,
}

impl Response {
    fn into_result(self) -> Option<Result<Data>> {
        match self {
            Response {
                ok: true,
                op: Some(_),
                data: Some(data),
                error: None,
                ..
            } => Some(Ok(data)),
            Response {
                ok: false,
                data: None,
                error: Some(error),
                ..
            } => Some(Err(error.into())),
            _ => None,
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WireError {
    #[serde(rename = "type")]
    kind: ErrorType,
    message: String,
    details: Option<WireDetails>,
}

/// WorkErrorDetails, in its order: the TypeScript CLI prints details as it decodes them.
#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct WireDetails {
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    expected: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    received: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    hint: Option<String>,
    #[serde(rename = "next_step", skip_serializing_if = "Option::is_none")]
    next_step: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    retryable: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    from: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    to: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    holder: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    target: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    caller: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    missing: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    generation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    candidates: Option<Vec<Candidate>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    op_id: Option<OpId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    machine: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Candidate {
    kind: String,
    node_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    item_id: Option<String>,
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    number: Option<Value>,
}

impl From<WireError> for Failure {
    fn from(error: WireError) -> Self {
        let failure = Failure::new(error.kind, error.message);
        match (error.kind, error.details) {
            (_, None) => failure,
            // AuthError and RuntimeDown keep only their next step, as the CLI's own carry it.
            (ErrorType::AuthError | ErrorType::RuntimeDown, Some(details)) => {
                match details.next_step {
                    Some(next) => failure.with(json!({ "next_step": next })),
                    None => failure,
                }
            }
            (_, Some(details)) => match serde_json::to_value(details) {
                Ok(details) => failure.with(details),
                Err(_) => failure,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode(line: &str) -> Option<Result<String, String>> {
        let response: Response = serde_json::from_str(line).ok()?;
        Some(
            response
                .into_result()?
                .map(|data| data.get().to_string())
                .map_err(|f| serde_json::to_string(&f).unwrap_or_default()),
        )
    }

    #[test]
    fn mints_an_op_id() {
        let id = OpId::mint();
        assert!(OpId::valid(id.as_str()), "{id}");
        assert_ne!(id, OpId::mint());
    }

    #[test]
    fn normalizes_as_node_path_does() {
        assert_eq!(normalize("/a//b/./c/../d/"), PathBuf::from("/a/b/d"));
        assert_eq!(normalize("/"), PathBuf::from("/"));
    }

    #[test]
    fn decodes_the_response_envelope() {
        assert_eq!(
            decode(
                r#"{"ok":true,"op":"msg.send","data":{"b":1,"a":1e21},"protocol_version":"v1"}"#
            ),
            Some(Ok(r#"{"b":1,"a":1e21}"#.into()))
        );
        assert_eq!(
            decode(r#"{"ok":false,"op":"x","error":{"type":"InputError","message":"m","details":{"retryable":false,"path":"args"}}}"#),
            Some(Err(r#"{"type":"InputError","message":"m","details":{"path":"args","retryable":false}}"#.into()))
        );
        assert_eq!(
            decode(
                r#"{"ok":false,"error":{"type":"AuthError","message":"m","details":{"retryable":false,"next_step":"n"}}}"#
            ),
            Some(Err(
                r#"{"type":"AuthError","message":"m","details":{"next_step":"n"}}"#.into()
            ))
        );
        for bad in [
            r#"{"ok":true,"op":"msg.send"}"#,
            r#"{"ok":true,"op":"x","data":1,"more":1}"#,
            r#"{"ok":false,"error":{"type":"Nope","message":"m"}}"#,
            r#"{"ok":false,"error":{"type":"BatchFailed","message":"m"}}"#,
            r#"{"ok":false,"error":{"type":"InputError","message":"m","details":{"odd":1}}}"#,
            "[]",
        ] {
            assert_eq!(decode(bad), None, "{bad}");
        }
    }
}
