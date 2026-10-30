//! ping, doctor, capabilities, onboard, since and offboard
//! (src/cli/commands/seat-discovery.ts): a seat learns where it is, and ends
//! its session.

use std::os::unix::fs::PermissionsExt;
use std::process::ExitCode;

use clap::Args;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use super::{Run, Timeout};
use crate::envelope::{self, Answer};
use crate::error::{Failure, Result};
use crate::wire::{self, Data};
use crate::{features, input, ops};

/// WORK_PROTOCOL_VERSION (src/shared/work-control.ts).
const PROTOCOL_VERSION: &str = "junto/work-control/v1";
const TOKEN_ENV: &str = "JUNTO_WORK_TOKEN";

#[derive(Serialize)]
pub struct PingArgs {}

#[derive(Serialize)]
pub struct DoctorArgs {}

#[derive(Serialize)]
pub struct CapabilitiesArgs {}

#[derive(Serialize)]
pub struct OnboardArgs {}

#[derive(Serialize)]
pub struct SinceArgs {
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    all: bool,
}

/// OffboardArgs: the notes, and the note a continuing session reads first.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OffboardArgs {
    notes: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    continuation: Option<String>,
}

ops! {
    PingArgs => "ping",
    DoctorArgs => "doctor",
    CapabilitiesArgs => "capabilities",
    OnboardArgs => "onboard",
    SinceArgs => "since",
    OffboardArgs => "offboard",
}

/// Liveness probe against the work control socket
#[derive(Args)]
pub struct Ping {
    #[command(flatten)]
    timeout: Timeout,
}

/// Inspect work control env, perms, protocol
#[derive(Args)]
pub struct Doctor {
    #[command(flatten)]
    timeout: Timeout,
}

/// Live edge wiring as a contract
#[derive(Args)]
pub struct Capabilities {
    #[command(flatten)]
    timeout: Timeout,
}

/// Load this seat
#[derive(Args)]
pub struct Onboard {
    #[command(flatten)]
    timeout: Timeout,
}

/// Since your last session
#[derive(Args)]
pub struct Since {
    /// Every line of every section, uncapped
    #[arg(long)]
    all: bool,
    #[command(flatten)]
    timeout: Timeout,
}

/// End this session with notes
#[derive(Args)]
pub struct Offboard {
    notes: String,
    /// Continue in a fresh session: a note for it
    #[arg(long = "continue")]
    continuation: Option<String>,
    #[command(flatten)]
    timeout: Timeout,
}

impl Run for Ping {
    fn run(self) -> ExitCode {
        envelope::print(
            "ping",
            wire::call(&PingArgs {}, self.timeout.into()).map(Into::into),
        )
    }
}

impl Run for Onboard {
    fn run(self) -> ExitCode {
        // Onboard already carries the commands each connection allows.
        envelope::print(
            "onboard",
            wire::call(&OnboardArgs {}, self.timeout.into()).map(Into::into),
        )
    }
}

impl Run for Since {
    fn run(self) -> ExitCode {
        let args = SinceArgs { all: self.all };
        envelope::print(
            "since",
            wire::call(&args, self.timeout.into()).map(Into::into),
        )
    }
}

impl Run for Capabilities {
    fn run(self) -> ExitCode {
        let answer = wire::call(&CapabilitiesArgs {}, self.timeout.into())
            .and_then(|data| decode::<Value>(&data))
            .and_then(|value| envelope::ok(&annotate(value)));
        envelope::print("capabilities", answer)
    }
}

impl Run for Doctor {
    fn run(self) -> ExitCode {
        envelope::print("doctor", doctor(self.timeout))
    }
}

impl Run for Offboard {
    fn run(self) -> ExitCode {
        let answer = offboard_args(&self.notes, self.continuation.as_deref())
            .and_then(|args| wire::call(&args, self.timeout.into()))
            .map(Into::into);
        envelope::print("offboard", answer)
    }
}

fn decode<T: for<'de> Deserialize<'de>>(data: &Data) -> Result<T> {
    serde_json::from_str(data.get())
        .map_err(|e| Failure::new(crate::error::ErrorType::InternalError, e.to_string()))
}

// --- doctor ---

/// localDoctorChecks (src/cli/core/socket.ts): what this process can see
/// before it calls. The credential itself never leaves this function.
struct Local {
    socket_path: String,
    socket_mode: Option<u32>,
    credential_present: bool,
    credential_shape_ok: bool,
}

impl Local {
    fn read() -> Self {
        let path = wire::work_home().join("control.sock");
        let socket_mode = std::fs::metadata(&path)
            .ok()
            .map(|m| m.permissions().mode() & 0o777);
        let credential = std::env::var(TOKEN_ENV)
            .map(|t| t.trim().to_string())
            .unwrap_or_default();
        Local {
            socket_path: path.display().to_string(),
            socket_mode,
            credential_present: !credential.is_empty(),
            credential_shape_ok: seat_credential_shape(&credential),
        }
    }

    fn mode(&self) -> Option<String> {
        self.socket_mode.map(|mode| format!("{mode:03o}"))
    }
}

/// isSeatCredentialShape: `junto-seat-` and 43 base64url characters.
fn seat_credential_shape(value: &str) -> bool {
    value.strip_prefix("junto-seat-").is_some_and(|body| {
        body.len() == 43
            && body
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    })
}

#[derive(Serialize)]
struct Check {
    name: &'static str,
    ok: bool,
    details: Value,
}

#[derive(Serialize)]
struct Cli {
    name: &'static str,
    version: &'static str,
}

#[derive(Serialize)]
struct Report<'a> {
    cli: Cli,
    protocol_version: &'static str,
    status: &'static str,
    checks: Vec<Check>,
    live: Option<&'a serde_json::value::RawValue>,
}

/// The live answer's version, as `String(protocol_version)` reads it.
#[derive(Deserialize)]
struct Live {
    protocol_version: Option<Value>,
}

fn doctor(timeout: Timeout) -> Answer {
    let local = Local::read();
    let present = local.socket_mode.is_some();
    let mut checks = vec![
        Check {
            name: "work.socket",
            ok: present,
            details: json!({ "path": local.socket_path, "mode": local.mode(), "required_mode": "600" }),
        },
        Check {
            name: "work.credential",
            ok: local.credential_present && local.credential_shape_ok,
            details: json!({
                "present": local.credential_present,
                "shape_ok": local.credential_shape_ok,
                "source": TOKEN_ENV,
            }),
        },
        Check {
            name: "work.socket.perms",
            ok: local.socket_mode.is_none_or(|mode| mode == 0o600),
            details: json!({ "mode": local.mode() }),
        },
    ];

    let live =
        (present && local.credential_present).then(|| wire::call(&DoctorArgs {}, timeout.into()));
    match &live {
        Some(Ok(data)) => {
            let version = serde_json::from_str::<Live>(data.get())
                .ok()
                .and_then(|live| live.protocol_version)
                .map(|v| v.as_str().map_or_else(|| v.to_string(), str::to_string));
            let mut details = Map::new();
            details.insert("expected".into(), PROTOCOL_VERSION.into());
            if let Some(version) = &version {
                details.insert("received".into(), version.as_str().into());
            }
            checks.push(Check {
                name: "protocol.version",
                ok: version.as_deref() == Some(PROTOCOL_VERSION),
                details: Value::Object(details),
            });
        }
        Some(Err(failure)) => checks.push(Check {
            name: "protocol.live",
            ok: false,
            details: json!({
                "error": failure.message,
                "hint": "CLI must run inside a live Junto seat with its generation credential",
            }),
        }),
        None => {}
    }

    let live = match &live {
        Some(Ok(data)) => Some(data.as_ref()),
        _ => None,
    };
    let healthy = live.is_some() && checks.iter().all(|c| c.ok);
    envelope::ok(&Report {
        cli: Cli {
            name: "junto",
            version: crate::CLI_VERSION,
        },
        protocol_version: PROTOCOL_VERSION,
        status: if healthy { "ok" } else { "attention_required" },
        checks,
        live,
    })
}

// --- capabilities ---

/// A grant an agent exercises with a command (capability-invocations.ts).
struct Invocation {
    port: &'static str,
    command: &'static str,
    discover: &'static str,
}

const BROWSER_INVOCATION: Invocation = Invocation {
    port: "browser.automate",
    command: "junto browser",
    discover: "junto browser pages",
};

const CREW_INVOCATIONS: [Invocation; 3] = [
    Invocation {
        port: "msg.prompt",
        command: "junto msg send --prompt",
        discover: "junto schema show msg.prompt",
    },
    Invocation {
        port: "seat.wait",
        command: "junto seat wait",
        discover: "junto schema show seat.wait",
    },
    Invocation {
        port: "terminal.read",
        command: "junto seat read",
        discover: "junto schema show seat.read",
    },
];

impl Invocation {
    fn json(&self) -> Value {
        json!({ "port": self.port, "command": self.command, "discover": self.discover })
    }
}

/// annotateCapabilityInvocations: each connected peer with the commands its
/// grants realize. The runtime stays the authority on what is held.
fn annotate(value: Value) -> Value {
    let Value::Object(mut root) = value else {
        return value;
    };
    if let Some(connected) = root.get_mut("connected") {
        annotate_connected(connected);
    }
    if let Some(Value::Object(capabilities)) = root.get_mut("capabilities")
        && let Some(connected) = capabilities.get_mut("connected")
    {
        annotate_connected(connected);
    }
    Value::Object(root)
}

fn annotate_connected(connected: &mut Value) {
    let Value::Array(entries) = connected else {
        return;
    };
    for entry in entries.iter_mut().filter_map(Value::as_object_mut) {
        let Some(Value::Array(grants)) = entry.get("grants") else {
            continue;
        };
        let holds = |port: &str| grants.iter().any(|g| g.as_str() == Some(port));
        let browser =
            (!features::MACHINE_BUILD && features::BROWSER && holds(BROWSER_INVOCATION.port))
                .then_some(&BROWSER_INVOCATION);
        let invocations: Vec<Value> = browser
            .into_iter()
            .chain(CREW_INVOCATIONS.iter().filter(|i| holds(i.port)))
            .map(Invocation::json)
            .collect();
        if !invocations.is_empty() {
            entry.insert("invocations".into(), Value::Array(invocations));
        }
    }
}

// --- offboard ---

/// Where a part of the input comes from (signal-input.ts sourceOf).
pub enum Source<'a> {
    Stdin,
    File(&'a str),
    Inline(&'a str),
}

impl<'a> Source<'a> {
    /// `-` or `@-` is stdin, `@path` a file, anything else the text itself.
    pub fn of(raw: &'a str) -> Self {
        let trimmed = raw.trim();
        match trimmed {
            "-" | "@-" => Source::Stdin,
            _ => match trimmed.strip_prefix('@').filter(|p| !p.is_empty()) {
                Some(path) => Source::File(path),
                None => Source::Inline(raw),
            },
        }
    }

    /// The source's name, as a decode refusal's path gives it.
    pub fn kind(&self) -> &'static str {
        match self {
            Source::Stdin => "stdin",
            Source::File(_) => "file",
            Source::Inline(_) => "inline",
        }
    }

    pub fn read(&self) -> Result<String> {
        match self {
            Source::Stdin => input::stdin(),
            Source::File(path) => input::file(path),
            Source::Inline(text) => Ok((*text).to_string()),
        }
    }
}

/// loadOffboardArgs (src/cli/core/offboard-input.ts): markdown notes inline,
/// `@file` or stdin, or the `{"notes", "continuation"}` object; the
/// continuation reads the same ways, and stdin feeds at most one of them.
fn offboard_args(notes: &str, continuation: Option<&str>) -> Result<OffboardArgs> {
    if notes.trim().is_empty() {
        return Err(
            Failure::input("write your notes on this session", "input").and(
                "hint",
                "junto offboard \"Shipped the parser; next is retry on 429s. Why it matters: ...\"",
            ),
        );
    }
    let source = Source::of(notes);
    if let Some(next) = continuation
        && matches!(source, Source::Stdin)
        && matches!(Source::of(next), Source::Stdin)
    {
        return Err(Failure::input(
            "stdin can feed the notes or the continuation, not both",
            "continue",
        )
        .and("hint", "give one of them inline or as @file"));
    }
    let body = source.read()?;
    let payload = if opens_notes_object(&body) {
        input::decode_text::<OffboardArgs>(&body, source.kind())?
    } else {
        OffboardArgs {
            notes: body,
            continuation: None,
        }
    };
    let Some(next) = continuation else {
        return Ok(payload);
    };
    if payload.continuation.is_some() {
        return Err(
            Failure::input("the continuation is given twice", "continue").and(
                "hint",
                "use --continue or the JSON continuation field, not both",
            ),
        );
    }
    if next.trim().is_empty() {
        return Err(Failure::input(
            "--continue takes the note for your next session: what to pick up and why",
            "continue",
        )
        .and(
            "hint",
            "junto offboard \"<notes>\" --continue \"Pick up the 429 retry in src/import/feed.ts; the nightly sync fails without it.\"",
        ));
    }
    Ok(OffboardArgs {
        continuation: Some(Source::of(next).read()?),
        ..payload
    })
}

/// Markdown never opens with `{"notes":`, so the JSON form is unambiguous.
fn opens_notes_object(body: &str) -> bool {
    body.trim()
        .strip_prefix('{')
        .map(str::trim_start)
        .and_then(|rest| rest.strip_prefix("\"notes\""))
        .is_some_and(|rest| rest.trim_start().starts_with(':'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn knows_the_notes_object_from_markdown() {
        assert!(opens_notes_object("  {\n \"notes\" : \"x\"}"));
        assert!(!opens_notes_object("{notes: 1}"));
        assert!(!opens_notes_object("# Notes {\"notes\":1}"));
    }

    #[test]
    fn reads_a_seat_credential_shape() {
        assert!(seat_credential_shape(&format!(
            "junto-seat-{}",
            "a".repeat(43)
        )));
        assert!(!seat_credential_shape(&format!(
            "junto-seat-{}",
            "a".repeat(42)
        )));
        assert!(!seat_credential_shape("seat-token"));
    }

    #[test]
    fn annotates_connected_grants_in_place() {
        let value = json!({
            "a": 1,
            "connected": [{ "id": "x", "grants": ["seat.wait", "msg.list"] }, { "id": "y", "grants": [] }],
        });
        let out = annotate(value);
        assert_eq!(
            out.to_string(),
            r#"{"a":1,"connected":[{"id":"x","grants":["seat.wait","msg.list"],"invocations":[{"port":"seat.wait","command":"junto seat wait","discover":"junto schema show seat.wait"}]},{"id":"y","grants":[]}]}"#
        );
    }
}
