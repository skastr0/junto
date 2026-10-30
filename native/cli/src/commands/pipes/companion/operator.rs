//! The owner-only operator control socket, as src/cli/core/operator-socket.ts
//! speaks it for the companion ops: one NDJSON request, one line back, bound
//! by the call's timeout from before it connects.

use std::io::{BufRead, BufReader, ErrorKind, Read, Write};
use std::os::unix::net::UnixStream;
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{Value, json};

use crate::wire;

const PROTOCOL: &str = "junto-operator/v1";
const MAX_REQUEST_BYTES: usize = 320 * 1024;
const MAX_RESPONSE_BYTES: u64 = 544 * 1024;
/// The shortest wait the TypeScript client admits; a shorter one is refused before it goes.
const MIN_TIMEOUT_MS: u64 = 250;
/// OPERATOR_PEER_LIMIT_MESSAGE: every peer slot taken, the app is up.
const PEER_LIMIT_MESSAGE: &str = "operator control peer limit reached";
/// What the server answers a request it could not decode.
const UNDECODED: &str = "invalid operator request";

/// Why a call brought no data back.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refused {
    /// The app is not running.
    Down,
    /// The app is up, every operator control slot taken.
    Busy,
    /// The app could not decode what was sent.
    Undecoded,
    /// Anything else: a timeout, a malformed answer, an error the app ruled.
    Failed,
}

#[derive(Deserialize)]
struct Response {
    ok: bool,
    id: Option<String>,
    op: Option<String>,
    data: Option<Value>,
    error: Option<ErrorBody>,
}

#[derive(Deserialize)]
struct ErrorBody {
    #[serde(rename = "type")]
    kind: String,
    message: String,
}

/// One operator op: its data, or why there is none.
pub fn call(op: &str, args: Value, timeout_ms: u64) -> Result<Value, Refused> {
    if timeout_ms < MIN_TIMEOUT_MS {
        return Err(Refused::Failed);
    }
    let id = ulid::Ulid::new().to_string();
    let mut frame = json!({ "protocol": PROTOCOL, "id": id, "op": op, "args": args }).to_string();
    frame.push('\n');
    if frame.len() > MAX_REQUEST_BYTES {
        return Err(Refused::Failed);
    }

    let started = Instant::now();
    let bound = Duration::from_millis(timeout_ms);
    let left = || {
        bound
            .checked_sub(started.elapsed())
            .filter(|d| !d.is_zero())
            .ok_or(Refused::Failed)
    };
    let path = wire::junto_home().join(".junto/operator/control.sock");
    let mut stream = UnixStream::connect(&path).map_err(|e| match e.kind() {
        ErrorKind::NotFound | ErrorKind::ConnectionRefused | ErrorKind::PermissionDenied => {
            Refused::Down
        }
        _ => Refused::Failed,
    })?;
    stream
        .set_write_timeout(Some(left()?))
        .map_err(|_| Refused::Failed)?;
    stream
        .write_all(frame.as_bytes())
        .map_err(|_| Refused::Failed)?;

    let mut reader = BufReader::new(&stream).take(MAX_RESPONSE_BYTES);
    let mut line = Vec::new();
    while !line.ends_with(b"\n") {
        stream
            .set_read_timeout(Some(left()?))
            .map_err(|_| Refused::Failed)?;
        match reader.read_until(b'\n', &mut line) {
            Ok(0) => return Err(Refused::Failed),
            Ok(_) => {}
            Err(e) if e.kind() == ErrorKind::Interrupted => {}
            Err(_) => return Err(Refused::Failed),
        }
    }
    let text = std::str::from_utf8(&line).map_err(|_| Refused::Failed)?;
    let response: Response = serde_json::from_str(text.trim_end()).map_err(|_| Refused::Failed)?;
    match response {
        Response {
            ok: true,
            data: Some(data),
            id: Some(rid),
            op: Some(rop),
            ..
        } if rid == id && rop == op => Ok(data),
        Response {
            ok: false,
            error: Some(error),
            ..
        } => Err(match (error.kind.as_str(), error.message.as_str()) {
            ("runtime_down" | "shutdown", PEER_LIMIT_MESSAGE) => Refused::Busy,
            ("runtime_down" | "shutdown", _) => Refused::Down,
            ("protocol_error", UNDECODED) => Refused::Undecoded,
            _ => Refused::Failed,
        }),
        _ => Err(Refused::Failed),
    }
}
