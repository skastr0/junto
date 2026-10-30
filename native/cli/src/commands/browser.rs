//! `browser` (src/cli/commands/browser.ts): drive a page this seat's navigates
//! edge grants. Transport is HTTP over the app's browser control socket
//! (src/cli/core/browser-control-client.ts), carrying the owner-local
//! transport token and the seat credential; the server admits the seat that
//! credential names, and decodes every body again.

use std::io::{self, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::{Duration, Instant};

use clap::{Args, Subcommand};
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::Run;
use crate::envelope;
use crate::error::{ErrorType, Failure, Result};
use crate::wire::{self, Data};

/// BROWSER_CLI_REQUEST_TIMEOUT_MS (src/shared/browser-limits.ts).
const REQUEST_TIMEOUT_MS: u64 = 40_000;
const MAX_REQUEST_BODY_BYTES: usize = 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
/// Far past any head the control server writes; a head this long is not one.
const MAX_HEAD_BYTES: usize = 64 * 1024;
const HOME_ENV: &str = "JUNTO_BROWSER_HOME";
const TIMEOUT_ENV: &str = "JUNTO_BROWSER_REQUEST_TIMEOUT_MS";

// --- the control plane's errors (src/cli/core/browser-errors.ts) -----------

/// ControlErrorTag (src/shared/browser-control.ts).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Tag {
    Unauthorized,
    Forbidden,
    BadRequest,
    Invalid,
    NotFound,
    Timeout,
    Cancelled,
    ResourceExhausted,
    UnsupportedCapability,
    UnsupportedResult,
    ResultTooLarge,
    Failed,
    OperatorHolds,
    RuntimeDown,
}

impl Tag {
    /// The work error each tag reads as: its type, whether to retry, and the way past it.
    fn mapped(self) -> (ErrorType, bool, Option<&'static str>) {
        use ErrorType as E;
        match self {
            Tag::Unauthorized => (
                E::AuthError,
                false,
                Some("run junto browser from a seat Junto started: the CLI sends its JUNTO_WORK_TOKEN, and a missing or stale one is refused"),
            ),
            // A paused canvas, a page out of reach, no edge, off the editing
            // machine: scope facts about the seat, not a broken credential.
            Tag::Forbidden => (E::ScopeError, false, None),
            Tag::BadRequest => (E::InputError, false, Some("junto schema show <browser command> lists the fields")),
            Tag::Invalid => (E::InputError, false, None),
            Tag::NotFound => (
                E::UnknownTarget,
                false,
                Some("junto browser pages and junto browser sessions list what exists; junto browser open <ref> --tab <tab> joins a tab"),
            ),
            Tag::Timeout | Tag::Cancelled => (E::Timeout, true, None),
            Tag::ResourceExhausted => {
                (E::InternalError, true, Some("retry after a moment, or stop a session you no longer need"))
            }
            Tag::UnsupportedCapability => (E::InputError, false, None),
            Tag::UnsupportedResult => (E::InputError, false, Some("return a plain JSON value from the page")),
            Tag::ResultTooLarge => (E::InputError, false, None),
            Tag::Failed => (E::InternalError, false, None),
            Tag::OperatorHolds => (
                E::Paused,
                true,
                Some("the operator has taken this page over; retry once they hand it back"),
            ),
            Tag::RuntimeDown => (E::RuntimeDown, true, Some("start the Junto app on this machine")),
        }
    }
}

/// A control error, as the envelope carries it.
#[derive(Debug, Deserialize)]
struct ControlError {
    #[serde(rename = "_tag")]
    tag: Tag,
    message: String,
}

fn control(tag: Tag, message: impl Into<String>) -> Failure {
    ControlError { tag, message: message.into() }.into()
}

/// browserErrorBody: `reason` keeps the control tag.
impl From<ControlError> for Failure {
    fn from(error: ControlError) -> Self {
        let (kind, retryable, next) = error.tag.mapped();
        let failure = Failure::new(kind, error.message).with(json!({ "reason": error.tag, "retryable": retryable }));
        match next {
            Some(next) => failure.and("next_step", next),
            None => failure,
        }
    }
}

// --- routes and bodies --------------------------------------------------------

/// CONTROL_ROUTES: the one table both ends dispatch on.
#[derive(Debug, Clone, Copy)]
enum Route {
    Doctor,
    Profiles,
    Pages,
    Sessions,
    Open,
    Goto,
    Eval,
    Screenshot,
    Comment,
    Close,
    Stop,
}

impl Route {
    fn method_and_path(self) -> (&'static str, &'static str) {
        match self {
            Route::Doctor => ("GET", "/doctor"),
            Route::Profiles => ("GET", "/profiles"),
            Route::Pages => ("GET", "/pages"),
            Route::Sessions => ("GET", "/sessions"),
            Route::Open => ("POST", "/open"),
            Route::Goto => ("POST", "/goto"),
            Route::Eval => ("POST", "/eval"),
            Route::Screenshot => ("POST", "/screenshot"),
            Route::Comment => ("POST", "/comment"),
            Route::Close => ("POST", "/close"),
            Route::Stop => ("POST", "/stop"),
        }
    }
}

/// Each body names its fields in the order the command builds them.
#[derive(Serialize)]
struct OpenBody {
    r#ref: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    tab: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GotoBody {
    session_id: String,
    url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    tab: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EvalBody {
    session_id: String,
    code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    tab: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ShotBody {
    session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    tab: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CommentBody {
    session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    tab: Option<String>,
    rect: Rect,
    text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionBody {
    session_id: String,
}

/// The box a comment is on, in page pixels.
#[derive(Debug, PartialEq, Serialize)]
struct Rect {
    #[serde(serialize_with = "as_js")]
    x: f64,
    #[serde(serialize_with = "as_js")]
    y: f64,
    #[serde(serialize_with = "as_js")]
    w: f64,
    #[serde(serialize_with = "as_js")]
    h: f64,
}

/// A number as JSON.stringify writes it: a whole one without a fraction.
fn as_js<S: serde::Serializer>(n: &f64, serializer: S) -> std::result::Result<S::Ok, S::Error> {
    if n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0 {
        serializer.serialize_i64(*n as i64)
    } else {
        serializer.serialize_f64(*n)
    }
}

impl Rect {
    /// `--box x,y,w,h`: four finite numbers, as JavaScript's Number reads each.
    fn parse(text: &str) -> Result<Self> {
        let numbers: Vec<f64> = text.split(',').map(str::trim).filter_map(js_number).collect();
        match numbers[..] {
            [x, y, w, h] if text.split(',').count() == 4 => Ok(Rect { x, y, w, h }),
            _ => {
                let shown = String::from_utf16_lossy(&text.encode_utf16().take(80).collect::<Vec<_>>());
                Err(Failure::input(format!("--box takes four numbers x,y,w,h, not {}", json!(shown)), "box")
                    .and("next_step", "junto schema show browser.comment"))
            }
        }
    }
}

/// Number(part) for a trimmed, non-empty part, when it is finite.
fn js_number(part: &str) -> Option<f64> {
    if part.is_empty() {
        return None;
    }
    let lower = part.to_ascii_lowercase();
    let radix = |prefix: &str, radix| {
        lower.strip_prefix(prefix).and_then(|digits| u64::from_str_radix(digits, radix).ok()).map(|n| n as f64)
    };
    let value = radix("0x", 16).or_else(|| radix("0o", 8)).or_else(|| radix("0b", 2)).or_else(|| {
        // JavaScript takes digits, a dot and an exponent; not Rust's inf or nan words.
        let plain = part.bytes().all(|b| b.is_ascii_digit() || matches!(b, b'.' | b'e' | b'E' | b'+' | b'-'));
        plain.then(|| part.parse::<f64>().ok()).flatten()
    })?;
    value.is_finite().then_some(value)
}

// --- the command line -----------------------------------------------------------

/// Drive a page this seat's navigates edge grants
#[derive(Args)]
pub struct Browser {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    Doctor,
    Profiles,
    Pages,
    Sessions,
    Open {
        #[arg(value_name = "node-ref")]
        r#ref: String,
        #[arg(long)]
        tab: Option<String>,
    },
    Goto {
        #[arg(value_name = "sessionId")]
        session_id: String,
        url: String,
        #[arg(long)]
        tab: Option<String>,
    },
    Eval {
        #[arg(value_name = "sessionId")]
        session_id: String,
        code: String,
        #[arg(long)]
        tab: Option<String>,
    },
    Shot {
        #[arg(value_name = "sessionId")]
        session_id: String,
        #[arg(long)]
        tab: Option<String>,
    },
    Comment {
        #[arg(value_name = "sessionId")]
        session_id: String,
        #[arg(long = "box")]
        r#box: String,
        #[arg(long)]
        text: String,
        #[arg(long)]
        tab: Option<String>,
    },
    Close {
        #[arg(value_name = "sessionId")]
        session_id: String,
    },
    Stop {
        #[arg(value_name = "sessionId")]
        session_id: String,
    },
}

impl Run for Browser {
    fn run(self) -> ExitCode {
        let none = None::<&()>;
        let (name, answer) = match self.command {
            Command::Doctor => ("doctor", call(Route::Doctor, none)),
            Command::Profiles => ("profiles", call(Route::Profiles, none)),
            Command::Pages => ("pages", call(Route::Pages, none)),
            Command::Sessions => ("sessions", call(Route::Sessions, none)),
            Command::Open { r#ref, tab } => ("open", call(Route::Open, Some(&OpenBody { r#ref, tab }))),
            Command::Goto { session_id, url, tab } => {
                ("goto", call(Route::Goto, Some(&GotoBody { session_id, url, tab })))
            }
            Command::Eval { session_id, code, tab } => {
                ("eval", call(Route::Eval, Some(&EvalBody { session_id, code, tab })))
            }
            Command::Shot { session_id, tab } => ("shot", call(Route::Screenshot, Some(&ShotBody { session_id, tab }))),
            Command::Comment { session_id, r#box, text, tab } => (
                "comment",
                Rect::parse(&r#box)
                    .and_then(|rect| call(Route::Comment, Some(&CommentBody { session_id, tab, rect, text }))),
            ),
            Command::Close { session_id } => ("close", call(Route::Close, Some(&SessionBody { session_id }))),
            Command::Stop { session_id } => ("stop", call(Route::Stop, Some(&SessionBody { session_id }))),
        };
        envelope::print(&format!("browser {name}"), answer.map(Into::into))
    }
}

// --- the transport ---------------------------------------------------------------

/// `$JUNTO_BROWSER_HOME`, a bounded absolute path, or the account's home.
fn control_home() -> Result<PathBuf> {
    let Some(configured) = std::env::var_os(HOME_ENV) else {
        return Ok(std::env::home_dir().unwrap_or_else(|| PathBuf::from("/")));
    };
    let text = configured.to_string_lossy();
    let usable = !text.is_empty()
        && text.len() <= 4096
        && !text.chars().any(|c| c.is_control() && (c as u32) < 0x80)
        && text.starts_with('/');
    if !usable {
        return Err(Failure::new(
            ErrorType::InputError,
            format!("{HOME_ENV} must be a bounded absolute path without control characters"),
        )
        .with(json!({ "reason": "bad_request", "retryable": false })));
    }
    Ok(PathBuf::from(configured).components().collect())
}

/// The round trip's bound: a page script that never resolves cannot hang the CLI.
fn request_timeout() -> Duration {
    let configured = std::env::var(TIMEOUT_ENV).ok().filter(|v| {
        v.bytes().next().is_some_and(|b| (b'1'..=b'9').contains(&b)) && v.bytes().all(|b| b.is_ascii_digit())
    });
    let ms = configured
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|ms| *ms <= 9_007_199_254_740_991)
        .map_or(REQUEST_TIMEOUT_MS, |ms| ms.min(REQUEST_TIMEOUT_MS));
    Duration::from_millis(ms)
}

/// One control route: its data on success, the mapped work error otherwise.
fn call<B: Serialize>(route: Route, body: Option<&B>) -> Result<Data> {
    let home = control_home()?.join(".junto/browser");
    // No token file: the app has never started its control plane.
    let token = std::fs::read_to_string(home.join("control.token"))
        .map_err(|_| control(Tag::RuntimeDown, "control token unavailable, is the app running?"))?;
    // The seat's credential from its environment, never argv. Absent, the
    // request still goes: token-only routes answer, protected ones refuse it.
    let credential = wire::seat_token().ok();
    let body = body
        .map(serde_json::to_string)
        .transpose()
        .map_err(|e| Failure::new(ErrorType::InternalError, e.to_string()))?;
    if body.as_ref().is_some_and(|b| b.len() > MAX_REQUEST_BODY_BYTES) {
        return Err(control(Tag::BadRequest, format!("request body exceeds {MAX_REQUEST_BODY_BYTES} bytes")));
    }
    let request = Request { route, token: token.trim(), credential: credential.as_deref(), body: body.as_deref() };
    request.send(&home.join("control.sock"), request_timeout())
}

struct Request<'a> {
    route: Route,
    token: &'a str,
    credential: Option<&'a str>,
    body: Option<&'a str>,
}

impl Request<'_> {
    /// The request as HTTP/1.1 bytes, or None when a header value could split the head.
    fn encode(&self) -> Option<Vec<u8>> {
        let (method, path) = self.route.method_and_path();
        let request_id = format!("{:032x}", u128::from(ulid::Ulid::new()));
        let mut headers = vec![
            ("host", "localhost".to_string()),
            ("content-type", "application/json".to_string()),
            ("x-junto-token", self.token.to_string()),
            ("x-junto-request-id", request_id),
        ];
        if let Some(credential) = self.credential {
            headers.push(("x-junto-seat-credential", credential.to_string()));
        }
        if let Some(body) = self.body {
            headers.push(("content-length", body.len().to_string()));
        }
        headers.push(("connection", "close".to_string()));
        if headers.iter().any(|(_, v)| v.bytes().any(|b| (b < 0x20 && b != b'\t') || b == 0x7f)) {
            return None;
        }
        let mut bytes = format!("{method} {path} HTTP/1.1\r\n").into_bytes();
        for (name, value) in headers {
            bytes.extend_from_slice(format!("{name}: {value}\r\n").as_bytes());
        }
        bytes.extend_from_slice(b"\r\n");
        bytes.extend_from_slice(self.body.unwrap_or_default().as_bytes());
        Some(bytes)
    }

    fn send(&self, socket: &std::path::Path, bound: Duration) -> Result<Data> {
        let failed = || control(Tag::Failed, "browser control request failed");
        let timed_out = || control(Tag::Timeout, format!("request timed out after {}ms", bound.as_millis()));
        let bytes = self.encode().ok_or_else(failed)?;
        let started = Instant::now();
        let left = || bound.checked_sub(started.elapsed()).filter(|d| !d.is_zero()).ok_or_else(timed_out);

        let mut stream = UnixStream::connect(socket).map_err(|e| match e.kind() {
            io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused => {
                control(Tag::RuntimeDown, "Junto app is not running")
            }
            _ => failed(),
        })?;
        let io_failure = |e: io::Error| match e.kind() {
            io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut => timed_out(),
            _ => control(Tag::Failed, "server response could not be read"),
        };
        stream.set_write_timeout(Some(left()?)).map_err(io_failure)?;
        stream.write_all(&bytes).map_err(|e| match e.kind() {
            io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut => timed_out(),
            _ => failed(),
        })?;

        let mut response = Response::default();
        let mut buffer = [0u8; 64 * 1024];
        loop {
            stream.set_read_timeout(Some(left()?)).map_err(io_failure)?;
            let n = match stream.read(&mut buffer) {
                Ok(n) => n,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                // The server hung up mid-answer.
                Err(e) if matches!(e.kind(), io::ErrorKind::ConnectionReset | io::ErrorKind::BrokenPipe) => {
                    return Err(control(Tag::Failed, "server response closed before completion"));
                }
                Err(e) => return Err(io_failure(e)),
            };
            match response.feed(&buffer[..n])? {
                Progress::More => {}
                Progress::Body(body) => return Envelope::decode(&body).and_then(Envelope::into_result),
            }
        }
    }
}

/// A response read so far: bytes until the head parses, then the body.
#[derive(Default)]
struct Response {
    bytes: Vec<u8>,
    /// Where the body starts and how long the head says it is, once parsed.
    head: Option<(usize, Option<usize>)>,
}

enum Progress {
    More,
    Body(Vec<u8>),
}

impl Response {
    /// Takes the next read (empty at end of stream).
    fn feed(&mut self, chunk: &[u8]) -> Result<Progress> {
        let too_large = || control(Tag::ResultTooLarge, format!("server response exceeds {MAX_RESPONSE_BYTES} bytes"));
        let incomplete = || control(Tag::Failed, "server response closed before completion");
        let ended = chunk.is_empty();
        self.bytes.extend_from_slice(chunk);
        if self.head.is_none() {
            let mut headers = [httparse::EMPTY_HEADER; 32];
            let mut parsed = httparse::Response::new(&mut headers);
            match parsed.parse(&self.bytes) {
                Ok(httparse::Status::Complete(start)) => {
                    let length = parsed
                        .headers
                        .iter()
                        .find(|h| h.name.eq_ignore_ascii_case("content-length"))
                        .and_then(|h| std::str::from_utf8(h.value).ok())
                        .and_then(|v| v.trim().parse::<usize>().ok());
                    if length.is_some_and(|l| l > MAX_RESPONSE_BYTES) {
                        return Err(too_large());
                    }
                    self.head = Some((start, length));
                }
                Ok(httparse::Status::Partial) if ended => return Err(incomplete()),
                Ok(httparse::Status::Partial) if self.bytes.len() > MAX_HEAD_BYTES => {
                    return Err(control(Tag::Failed, "server response could not be read"));
                }
                Ok(httparse::Status::Partial) => return Ok(Progress::More),
                Err(_) => return Err(control(Tag::Failed, "server response could not be read")),
            }
        }
        let Some((start, length)) = self.head else { return Ok(Progress::More) };
        let body = &self.bytes[start..];
        if body.len() > MAX_RESPONSE_BYTES {
            return Err(too_large());
        }
        match length {
            Some(length) if body.len() >= length => Ok(Progress::Body(body[..length].to_vec())),
            Some(_) if ended => Err(incomplete()),
            None if ended => Ok(Progress::Body(body.to_vec())),
            _ => Ok(Progress::More),
        }
    }
}

/// The control envelope: data on success, a control error otherwise.
#[derive(Deserialize)]
struct Envelope {
    ok: bool,
    data: Option<Data>,
    error: Option<ControlError>,
}

impl Envelope {
    fn decode(body: &[u8]) -> Result<Self> {
        let text = std::str::from_utf8(body).map_err(|_| control(Tag::Failed, "server returned non-JSON"))?;
        let value: &serde_json::value::RawValue =
            serde_json::from_str(text).map_err(|_| control(Tag::Failed, "server returned non-JSON"))?;
        serde_json::from_str(value.get()).map_err(|_| control(Tag::Failed, "server returned a malformed envelope"))
    }

    fn into_result(self) -> Result<Data> {
        match self {
            Envelope { ok: true, data: Some(data), .. } => Ok(data),
            Envelope { ok: false, error: Some(error), .. } => Err(error.into()),
            _ => Err(control(Tag::Failed, "server returned a malformed envelope")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_box_as_javascript_numbers() {
        assert_eq!(Rect::parse("40, 120,320,80").ok(), Some(Rect { x: 40.0, y: 120.0, w: 320.0, h: 80.0 }));
        assert_eq!(Rect::parse("0x10,1e2,-1.5,.5").ok(), Some(Rect { x: 16.0, y: 100.0, w: -1.5, h: 0.5 }));
        let rect = Rect { x: 40.0, y: -0.0, w: 1.5, h: 2.25 };
        assert_eq!(serde_json::to_string(&rect).unwrap(), r#"{"x":40,"y":0,"w":1.5,"h":2.25}"#);
        for bad in ["1,2,3", "1,2,3,4,5", "1,,3,4", "1,2,3,inf", "1,2,3,NaN", "1,2,3,Infinity", "a,b,c,d"] {
            assert!(Rect::parse(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn maps_control_errors_to_work_errors() {
        let failure: Failure = ControlError { tag: Tag::NotFound, message: "gone".into() }.into();
        assert_eq!(failure.kind, ErrorType::UnknownTarget);
        assert_eq!(
            serde_json::to_string(&failure.details).unwrap(),
            r#"{"reason":"not_found","retryable":false,"next_step":"junto browser pages and junto browser sessions list what exists; junto browser open <ref> --tab <tab> joins a tab"}"#
        );
    }

    #[test]
    fn reads_a_response_by_its_length() {
        let mut response = Response::default();
        assert!(matches!(response.feed(b"HTTP/1.1 200 OK\r\ncontent-length: 24\r\n\r\n{\"ok\":true,").unwrap(), Progress::More));
        let Progress::Body(body) = response.feed(b"\"data\":[1.0]}").unwrap() else { panic!("no body") };
        assert_eq!(Envelope::decode(&body).unwrap().into_result().unwrap().get(), "[1.0]");

        let mut cut = Response::default();
        cut.feed(b"HTTP/1.1 200 OK\r\ncontent-length: 9\r\n\r\n{}").unwrap();
        assert!(cut.feed(b"").is_err_and(|f| f.message == "server response closed before completion"));

        let err = Envelope::decode(br#"{"ok":false,"error":{"_tag":"forbidden","message":"no edge"}}"#).unwrap();
        assert!(err.into_result().is_err_and(|f| f.kind == ErrorType::ScopeError));
        for bad in [&br#"{"ok":true}"#[..], br#"{"ok":false,"error":{"_tag":"nope","message":"m"}}"#, b"[]"] {
            let read = Envelope::decode(bad).and_then(Envelope::into_result);
            assert!(read.is_err_and(|f| f.message == "server returned a malformed envelope"));
        }
        assert!(Envelope::decode(b"nope").is_err_and(|f| f.message == "server returned non-JSON"));
    }
}
