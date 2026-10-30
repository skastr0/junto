//! junto-companion/1 frames as this side reads and writes them
//! (src/shared/wire/companion-protocol.ts). The envelope is checked here; each
//! op's arguments are the app's to decode, as it decodes every relayed frame
//! again (OperatorCompanionCallArgs) and refuses what it cannot.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

pub const PROTOCOL: &str = "junto-companion/1";
/// Phone to Mac, sized for one `content.stage` piece; past it the channel closes.
pub const MAX_INBOUND_BYTES: usize = 288 * 1024;
/// Phone to Mac, any op but `content.stage`.
const MAX_REQUEST_BYTES: usize = 16 * 1024;
const MAX_OUTBOUND_BYTES: usize = 512 * 1024;

/// COMPANION_OPS: every op a phone may ask for.
const OPS: [&str; 39] = [
    "pair.complete",
    "ping",
    "canvases.list",
    "feed.get",
    "feed.subscribe",
    "feed.unsubscribe",
    "seats.list",
    "seat.get",
    "signal.answer",
    "signal.dismiss",
    "mail.list",
    "mail.send",
    "quickReplies.get",
    "portrait.get",
    "content.get",
    "content.stage",
    "machines.list",
    "machine.get",
    "tailnet.peers",
    "artifact.history",
    "artifact.moveCheck",
    "artifact.pending",
    "artifact.get",
    "artifacts.list",
    "artifacts.nodes",
    "inbox.set",
    "artifact.apply",
    "threads.list",
    "thread.get",
    "threads.read",
    "canvas.open",
    "canvas.close",
    "comments.list",
    "comment.post",
    "mentions.candidates",
    "mentions.resolve",
    "mentions.linkedFrom",
    "artifacts.subscribe",
    "artifacts.unsubscribe",
];

/// CompanionErrorCode, with the plain message each carries by default.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Code {
    AppNotRunning,
    Revoked,
    UnsupportedVersion,
    Invalid,
    NotFound,
    Conflict,
    TooLarge,
    RateLimited,
    Internal,
    Unavailable,
    Mismatch,
    DiskLow,
}

impl Code {
    /// COMPANION_ERROR_COPY.
    pub fn copy(self) -> &'static str {
        match self {
            Code::AppNotRunning => "Junto is not open on the Mac.",
            Code::Revoked => "This phone was removed from Junto.",
            Code::UnsupportedVersion => "This Mac speaks a different companion protocol.",
            Code::Invalid => "The request was not valid.",
            Code::NotFound => "That is no longer there.",
            Code::Conflict => "That changed on the Mac.",
            Code::TooLarge => "The message was too large.",
            Code::RateLimited => "Too many changes at once. Try again in a moment.",
            Code::Internal => "Something went wrong on the Mac.",
            Code::Unavailable => "This file is not available on the Mac.",
            Code::Mismatch => "The file changed on its way to the Mac. Attach it again.",
            Code::DiskLow => "The Mac is low on disk space.",
        }
    }
}

/// companionFail: a refusal of request `id` (`""` for the connection).
pub fn fail(id: &str, code: Code, message: Option<&str>) -> Value {
    json!({
        "v": PROTOCOL,
        "type": "response",
        "id": id,
        "ok": false,
        "error": { "code": code, "message": message.unwrap_or(code.copy()) },
    })
}

/// companionConnectionErrorLine: an error with no request to answer.
pub fn connection_error_line(code: Code, message: Option<&str>) -> String {
    encode(&fail("", code, message))
}

/// One Mac frame as a line; past the outbound limit it becomes an `internal`
/// refusal of the same request.
pub fn encode(frame: &Value) -> String {
    let line = format!("{frame}\n");
    if line.len() <= MAX_OUTBOUND_BYTES {
        return line;
    }
    let id = frame.get("id").and_then(Value::as_str).unwrap_or_default();
    format!("{}\n", fail(id, Code::Internal, Some("The reply was too large to send.")))
}

/// companionEvent: an event frame, its signals as they leave on this wire.
pub fn event(event: &str, mut data: Value) -> Value {
    match event {
        "signal.changed" => {
            if let Some(signal) = data.get_mut("signal") {
                leaving_signal(signal);
            }
        }
        "feed.changed" => {
            let sections = data.pointer_mut("/feed/sections").and_then(Value::as_array_mut);
            for section in sections.into_iter().flatten() {
                let items = section.get_mut("items").and_then(Value::as_array_mut);
                items.into_iter().flatten().for_each(leaving_signal);
            }
        }
        _ => {}
    }
    json!({ "v": PROTOCOL, "type": "event", "event": event, "data": data })
}

/// companionSignal: an automation's step stays on the Mac. Its raised values
/// alone can overrun one frame, and the phone reads nothing in it.
fn leaving_signal(signal: &mut Value) {
    if let Some(source) = signal.get_mut("source").and_then(Value::as_object_mut)
        && source.get("kind").and_then(Value::as_str) == Some("automation")
    {
        source.remove("step");
    }
}

/// A request a phone sent: its id, op and the whole frame to relay.
#[derive(Debug, Clone)]
pub struct Request {
    pub op: String,
    pub frame: Value,
}

impl Request {
    #[cfg(test)]
    pub fn id(&self) -> &str {
        self.frame.get("id").and_then(Value::as_str).unwrap_or_default()
    }

    pub fn args(&self) -> &Value {
        &self.frame["args"]
    }

    /// An argument the frame names, as text.
    pub fn arg(&self, key: &str) -> Option<&str> {
        self.args().get(key).and_then(Value::as_str)
    }
}

/// A line that is no request: what to answer, and whether the channel closes.
#[derive(Debug, PartialEq)]
pub struct Refusal {
    pub id: String,
    pub code: Code,
    pub message: &'static str,
    pub close: bool,
}

impl Refusal {
    fn new(id: &str, code: Code, message: &'static str, close: bool) -> Self {
        Refusal { id: id.to_string(), code, message, close }
    }

    /// A refusal with no id is a connection error; one with an id answers that request.
    pub fn line(&self) -> String {
        if self.id.is_empty() {
            connection_error_line(self.code, Some(self.message))
        } else {
            encode(&fail(&self.id, self.code, Some(self.message)))
        }
    }
}

/// CompanionRequestId: chosen by the phone, unique per connection.
fn request_id(value: Option<&Value>) -> Option<&str> {
    let id = value?.as_str()?;
    let valid = (1..=64).contains(&id.len())
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-'));
    valid.then_some(id)
}

/// decodeCompanionRequestLine, up to the op's arguments.
pub fn decode(line: &str) -> Result<Request, Refusal> {
    let size = line.len() + 1;
    if size > MAX_INBOUND_BYTES {
        return Err(Refusal::new("", Code::TooLarge, Code::TooLarge.copy(), true));
    }
    let raw: Value =
        serde_json::from_str(line).map_err(|_| Refusal::new("", Code::Invalid, "The frame was not JSON.", false))?;
    let object = raw.as_object();
    let field = |key: &str| object.and_then(|o| o.get(key));
    // The envelope every frame carries before its op is looked at.
    let envelope = object.is_some()
        && field("v").is_some_and(Value::is_string)
        && field("type").and_then(Value::as_str) == Some("request")
        && field("op").is_some_and(Value::is_string);
    let id = request_id(field("id")).filter(|_| envelope);
    if field("v").and_then(Value::as_str) != Some(PROTOCOL) {
        return Err(Refusal::new(
            id.unwrap_or_default(),
            Code::UnsupportedVersion,
            Code::UnsupportedVersion.copy(),
            true,
        ));
    }
    let Some(id) = id else {
        return Err(Refusal::new("", Code::Invalid, "The frame is not a request.", false));
    };
    let op = field("op").and_then(Value::as_str).unwrap_or_default();
    if !OPS.contains(&op) {
        return Err(Refusal::new(id, Code::Invalid, "Unknown operation.", false));
    }
    if op != "content.stage" && size > MAX_REQUEST_BYTES {
        return Err(Refusal::new("", Code::TooLarge, Code::TooLarge.copy(), true));
    }
    let args = open_args(op, field("args").cloned().unwrap_or_else(|| Value::Object(Map::new())));
    // The frame as its schema reads it: the five keys, nothing else.
    let frame = json!({ "v": PROTOCOL, "type": "request", "id": id, "op": op, "args": args });
    Ok(Request { op: op.to_string(), frame })
}

/// The keys an op whose arguments are open takes: the TypeScript decode drops
/// any other, while the app decodes the relayed frame strictly. Closed ops are
/// relayed whole, and the app refuses an unknown key as the phone expects.
fn open_keys(op: &str, args: &Map<String, Value>) -> Option<&'static [&'static str]> {
    Some(match op {
        "ping" | "canvases.list" | "feed.unsubscribe" | "quickReplies.get" | "machines.list" | "tailnet.peers" => &[],
        "pair.complete" => &["publicKey", "deviceName"],
        "feed.get" | "feed.subscribe" | "seats.list" => &["canvasName"],
        "seat.get" => &["canvasName", "nodeId"],
        "signal.dismiss" => &["signalId"],
        "mail.list" => &["canvasName", "nodeId", "limit"],
        "portrait.get" => &["portraitIdentity", "size", "theme", "format"],
        "machine.get" => &["name", "minLevel"],
        // The union's first form that reads: quiet, then loud, then an artifact answer.
        "signal.answer" if args.get("quiet") == Some(&Value::Bool(true)) && args.contains_key("text") => {
            &["signalId", "text", "quiet", "attachments"]
        }
        "signal.answer" if args.contains_key("text") => &["signalId", "text", "attachments"],
        "signal.answer" => &["signalId", "artifact"],
        _ => return None,
    })
}

fn open_args(op: &str, args: Value) -> Value {
    match args {
        Value::Object(mut map) => {
            if let Some(keys) = open_keys(op, &map) {
                map.retain(|key, _| keys.contains(&key.as_str()));
            }
            Value::Object(map)
        }
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn refused(line: &str) -> (String, Code, &'static str, bool) {
        let r = decode(line).unwrap_err();
        (r.id, r.code, r.message, r.close)
    }

    #[test]
    fn checks_the_envelope_in_the_order_the_protocol_does() {
        let ok = decode(r#"{"v":"junto-companion/1","type":"request","id":"r1","op":"ping"}"#).unwrap();
        assert_eq!((ok.id(), ok.op.as_str(), ok.args()), ("r1", "ping", &json!({})));
        assert_eq!(refused("{"), ("".into(), Code::Invalid, "The frame was not JSON.", false));
        assert_eq!(
            refused(r#"{"v":"junto-companion/2","type":"request","id":"r2","op":"ping"}"#),
            ("r2".into(), Code::UnsupportedVersion, Code::UnsupportedVersion.copy(), true)
        );
        assert_eq!(refused("5").1, Code::UnsupportedVersion);
        assert_eq!(
            refused(r#"{"v":"junto-companion/1","type":"event","id":"r3","op":"ping"}"#),
            ("".into(), Code::Invalid, "The frame is not a request.", false)
        );
        assert_eq!(
            refused(r#"{"v":"junto-companion/1","type":"request","id":"r4","op":"nope"}"#),
            ("r4".into(), Code::Invalid, "Unknown operation.", false)
        );
        let long = format!(r#"{{"v":"junto-companion/1","type":"request","id":"r5","op":"ping","args":{{"x":"{}"}}}}"#, "a".repeat(17_000));
        assert_eq!(refused(&long), ("".into(), Code::TooLarge, Code::TooLarge.copy(), true));
        assert!(decode(&long.replace("\"ping\"", "\"content.stage\"")).is_ok());
        let open = decode(r#"{"v":"junto-companion/1","x":1,"type":"request","id":"r6","op":"seat.get","args":{"nodeId":"n","old":1,"canvasName":"c"}}"#).unwrap();
        assert_eq!(open.frame.to_string(), r#"{"v":"junto-companion/1","type":"request","id":"r6","op":"seat.get","args":{"nodeId":"n","canvasName":"c"}}"#);
        let closed = decode(r#"{"v":"junto-companion/1","type":"request","id":"r7","op":"mail.send","args":{"old":1}}"#).unwrap();
        assert_eq!(closed.args(), &json!({ "old": 1 }));
    }

    #[test]
    fn leaves_an_automation_step_on_the_mac() {
        let signal = json!({ "id": "s", "source": { "kind": "automation", "step": { "raised": 1 }, "name": "n" } });
        let frame = event("signal.changed", json!({ "signal": signal }));
        assert_eq!(
            frame.to_string(),
            r#"{"v":"junto-companion/1","type":"event","event":"signal.changed","data":{"signal":{"id":"s","source":{"kind":"automation","name":"n"}}}}"#
        );
        assert_eq!(
            connection_error_line(Code::Revoked, None),
            "{\"v\":\"junto-companion/1\",\"type\":\"response\",\"id\":\"\",\"ok\":false,\"error\":{\"code\":\"revoked\",\"message\":\"This phone was removed from Junto.\"}}\n"
        );
    }
}
