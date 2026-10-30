//! The live verbs: each closed operation is sent as the outer op `overseer`,
//! `{operation, args}`, and the inner OverseerResult is unwrapped. Main
//! decodes every operation's args against its exact schema (decodeOverseerArgs
//! in src/main/junto/work/control.ts), so the args go as given: this side
//! keeps only what it alone can say, before anything is sent.

use std::process::ExitCode;

use clap::error::ErrorKind;
use clap::{Arg, ArgMatches, FromArgMatches, Subcommand, value_parser};
use serde::{Deserialize, Deserializer};
use serde_json::{Map, Value, json};

use super::automation;
use super::catalog::{self, Operation, Shape};
use crate::attach::body_input::{self, BodyRequest};
use crate::attach::secret_input;
use crate::envelope::{self, Answer, Reply};
use crate::error::{ErrorType, Failure, Result};
use crate::input;
use crate::wire::{self, Change, Data, OpId, Timeout};

/// OVERSEER_MAX_REQUEST_BYTES (src/shared/overseer-control.ts).
const MAX_REQUEST_BYTES: usize = 1024 * 1024;
/// OVERSEER_MAX_ERROR_BYTES: the most an inner error's message carries.
const MAX_ERROR_BYTES: usize = 4 * 1024;

/// One live verb as typed: the operation, and what its command line gave.
#[derive(Debug)]
pub struct Call {
    op: &'static Operation,
    input: Option<String>,
    body: Option<String>,
    op_id: Option<String>,
    timeout: Timeout,
}

impl Call {
    pub fn run(self) -> ExitCode {
        envelope::print(&self.op.command(), self.answer())
    }

    fn answer(&self) -> Answer {
        match self.op.shape {
            Shape::Plain => self.send(self.args()?, None).map(Into::into),
            Shape::Report => judged(self.send(self.args()?, None)?, blocks_launch),
            Shape::Rows => judged(self.send(self.args()?, None)?, refused_any),
            Shape::SecretPut => self.send(self.secret()?, None).map(Into::into),
            Shape::Body { empty } => self.send(self.with_body(empty)?, None).map(Into::into),
            Shape::Automation(write) => {
                let given = input::load(self.input.as_deref().unwrap_or("{}"))?;
                let (args, op_id) = automation::args(write, given, self.op_id.as_deref())?;
                self.send(args, Some(&op_id)).map(Into::into)
            }
        }
    }

    /// One call of the outer op, the inner result unwrapped. A mutation that
    /// fails once sent says it may have completed, and how to resend it.
    fn send(&self, args: Value, op_id: Option<&OpId>) -> Result<Data> {
        let request = json!({ "operation": self.op.name, "args": args });
        if serde_json::to_vec(&request).map_or(0, |bytes| bytes.len()) > MAX_REQUEST_BYTES {
            return Err(Failure::input(
                format!("overseer request exceeds {MAX_REQUEST_BYTES} bytes"),
                "args",
            ));
        }
        let data = if self.op.mutation() {
            let change = Change { op_id, mutation: Some(self.op.name) };
            wire::call_changing("overseer", &request, change, self.timeout)?
        } else {
            wire::call_dynamic("overseer", &request, self.timeout)?
        };
        unwrap(&data)
    }

    /// The JSON argument, `{}` when none was given. Main judges its shape;
    /// a seat draft carrying what main works out is refused here, saying
    /// what a seat is made from.
    fn args(&self) -> Result<Value> {
        let raw = self
            .input
            .as_deref()
            .filter(|raw| !raw.trim().is_empty())
            .unwrap_or("{}");
        let args = match input::load(raw)? {
            Value::Null => json!({}),
            args => args,
        };
        let refuse = |message: String| {
            Failure::input(message, "args")
                .and("expected", self.op.name)
                .and("received", args.clone())
                .and(
                    "hint",
                    format!("junto overseer schema show {}", self.op.name),
                )
        };
        if !args.is_object() {
            return Err(refuse("Expected an object".into()));
        }
        match seat_fields_main_works_out(self.op, &args).as_slice() {
            [] => Ok(args),
            fields => Err(refuse(format!(
                "A seat is created from harness, profile, model, effort, mode, permissionMode and cwd; Junto builds its launch. Remove: {}",
                fields.join(", ")
            ))),
        }
    }

    /// withBody: the JSON argument with its prose body, from `--body` or
    /// `"body"`, never both and never empty.
    fn with_body(&self, empty: &str) -> Result<Value> {
        let raw = self.input.as_deref();
        let argument = input::load(raw.filter(|raw| !raw.trim().is_empty()).unwrap_or("{}"))?;
        let request = BodyRequest { input: raw, argument, flag: self.body.as_deref(), empty_message: empty };
        body_input::with_body(request).map(Value::Object)
    }

    /// `secret put`: the argument names the secret, the value comes from stdin.
    fn secret(&self) -> Result<Value> {
        let named = secret_input::decode(self.input.as_deref())?;
        let value = secret_input::read_value()?;
        let mut args = match serde_json::to_value(named) {
            Ok(Value::Object(args)) => args,
            _ => Map::new(),
        };
        args.insert("value".into(), value.into());
        Ok(Value::Object(args))
    }
}

/// SEAT_FIELDS_MAIN_WORKS_OUT (src/shared/model/drafts.ts).
const SEAT_FIELDS_MAIN_WORKS_OUT: [&str; 5] =
    ["agentKey", "bindingId", "launch", "sessionId", "overseer"];

/// seatFieldsMainWorksOut: what a seat being created or reseated may not carry.
fn seat_fields_main_works_out(op: &Operation, args: &Value) -> Vec<&'static str> {
    let seat = |node: &&Map<String, Value>| node.get("kind") == Some(&json!("agent"));
    let seats: Vec<&Map<String, Value>> = match op.name {
        "agent.reseat" => args.as_object().into_iter().collect(),
        "node.create" => args
            .get("node")
            .and_then(Value::as_object)
            .filter(seat)
            .into_iter()
            .collect(),
        "canvas.batch" => args
            .get("steps")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|step| step.get("operation") == Some(&json!("node.create")))
            .filter_map(|step| step.get("node")?.as_object())
            .filter(seat)
            .collect(),
        _ => Vec::new(),
    };
    SEAT_FIELDS_MAIN_WORKS_OUT
        .into_iter()
        .filter(|field| seats.iter().any(|seat| seat.contains_key(*field)))
        .collect()
}

/// The answer printed whole; `unmet` reads it to set the exit code.
fn judged(data: Data, unmet: fn(&Value) -> bool) -> Answer {
    let unmet = serde_json::from_str(data.get()).is_ok_and(|value: Value| unmet(&value));
    Ok(Reply { data, unmet })
}

/// offboardRefusedAny: a row result where any item was refused.
fn refused_any(data: &Value) -> bool {
    data.get("refused")
        .and_then(Value::as_f64)
        .is_some_and(|n| n > 0.0)
}

/// reportBlocksLaunch: a source anywhere in the report that is required and
/// could not be read, so a seat depending on it would be refused at launch.
fn blocks_launch(report: &Value) -> bool {
    match report {
        Value::Array(items) => items.iter().any(blocks_launch),
        Value::Object(record) => {
            let blocking = record.get("sourceId").is_some_and(Value::is_string)
                && record.get("required") == Some(&Value::Bool(true))
                && matches!(
                    record.get("status").and_then(Value::as_str),
                    Some("missing" | "error")
                );
            blocking || record.values().any(blocks_launch)
        }
        _ => false,
    }
}

/// OverseerResult: `{ok:true, operation, data}` or `{ok:false, operation, error}`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Inner {
    ok: bool,
    operation: String,
    #[serde(default, deserialize_with = "present")]
    data: Option<Data>,
    error: Option<InnerError>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct InnerError {
    #[serde(rename = "type")]
    kind: InnerType,
    message: String,
    #[serde(default, deserialize_with = "present")]
    details: Option<Value>,
}

/// OverseerErrorType.
#[derive(Deserialize)]
enum InnerType {
    Forbidden,
    InvalidArguments,
    NotFound,
    Conflict,
    Unsupported,
    RuntimeDown,
    NeedsUpdate,
    InternalError,
}

impl From<InnerType> for ErrorType {
    fn from(kind: InnerType) -> Self {
        match kind {
            InnerType::Forbidden => ErrorType::Forbidden,
            InnerType::InvalidArguments => ErrorType::InvalidArguments,
            InnerType::NotFound => ErrorType::NotFound,
            InnerType::Conflict => ErrorType::Conflict,
            InnerType::Unsupported => ErrorType::Unsupported,
            InnerType::RuntimeDown => ErrorType::RuntimeDown,
            InnerType::NeedsUpdate => ErrorType::NeedsUpdate,
            InnerType::InternalError => ErrorType::InternalError,
        }
    }
}

/// A key that is there, even as `null`, as an optionalKey of Unknown reads it.
fn present<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> Result<Option<T>, D::Error> {
    T::deserialize(deserializer).map(Some)
}

/// unwrapOverseerSocketData: the inner data, or the inner refusal as the
/// command's error; anything else is a ProtocolError.
fn unwrap(data: &Data) -> Result<Data> {
    let malformed = |why: String| {
        Failure::new(
            ErrorType::ProtocolError,
            "overseer result was not a valid OverseerResult",
        )
        .with(json!({ "hint": why }))
    };
    let inner: Inner =
        serde_json::from_str(data.get()).map_err(|error| malformed(error.to_string()))?;
    if catalog::named(&inner.operation).is_none() {
        return Err(malformed(format!("unknown operation {}", inner.operation)));
    }
    match inner {
        Inner {
            ok: true,
            data: Some(data),
            error: None,
            ..
        } => Ok(data),
        Inner {
            ok: false,
            data: None,
            error: Some(error),
            ..
        } => {
            if error.message.is_empty() || error.message.len() > MAX_ERROR_BYTES {
                return Err(malformed(format!(
                    "error message is empty or exceeds {MAX_ERROR_BYTES} UTF-8 bytes"
                )));
            }
            let failure = Failure::new(error.kind.into(), error.message);
            Err(match error.details {
                Some(details) => failure.with(details),
                None => failure,
            })
        }
        _ => Err(malformed("ok does not match data and error".into())),
    }
}

// --- the command line, built from the catalog ---------------------------------

/// One verb's command: its JSON argument, and the flags its shape takes.
fn verb_command(op: &'static Operation) -> clap::Command {
    let command = clap::Command::new(op.verb()).arg(Arg::new("input")).arg(
        Arg::new("timeout")
            .long("timeout")
            .value_parser(value_parser!(i64)),
    );
    match op.shape {
        Shape::Body { .. } => command.arg(Arg::new("body").long("body")),
        Shape::Automation(_) => command.arg(Arg::new("op_id").long("op-id")),
        _ => command,
    }
}

/// The operation a command line names: `status`, or a family and its verb.
fn operation(first: &str, verb: Option<&str>) -> Option<&'static Operation> {
    let (family, verb) = verb.map_or(("overseer", first), |verb| (first, verb));
    catalog::enabled().find(|op| op.family() == family && op.verb() == verb)
}

impl Subcommand for Call {
    fn augment_subcommands(command: clap::Command) -> clap::Command {
        catalog::families()
            .into_iter()
            .fold(command, |command, family| {
                let verbs = catalog::enabled()
                    .filter(move |op| op.family() == family)
                    .map(verb_command);
                match family {
                    "overseer" => command.subcommands(verbs),
                    family => command.subcommand(
                        clap::Command::new(family)
                            .subcommand_required(true)
                            .subcommands(verbs),
                    ),
                }
            })
    }

    fn augment_subcommands_for_update(command: clap::Command) -> clap::Command {
        Self::augment_subcommands(command)
    }

    fn has_subcommand(name: &str) -> bool {
        catalog::families().contains(&name) || operation(name, None).is_some()
    }
}

impl FromArgMatches for Call {
    fn from_arg_matches(matches: &ArgMatches) -> Result<Self, clap::Error> {
        let (first, matches) = matches
            .subcommand()
            .ok_or_else(|| clap::Error::new(ErrorKind::MissingSubcommand))?;
        let (verb, matches) = match matches.subcommand() {
            Some((verb, matches)) => (Some(verb), matches),
            None => (None, matches),
        };
        let op =
            operation(first, verb).ok_or_else(|| clap::Error::new(ErrorKind::InvalidSubcommand))?;
        let text = |id: &str| matches.try_get_one::<String>(id).ok().flatten().cloned();
        Ok(Call {
            op,
            input: text("input"),
            body: text("body"),
            op_id: text("op_id"),
            timeout: matches
                .try_get_one::<i64>("timeout")
                .ok()
                .flatten()
                .copied()
                .into(),
        })
    }

    fn update_from_arg_matches(&mut self, matches: &ArgMatches) -> Result<(), clap::Error> {
        *self = Self::from_arg_matches(matches)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(text: &str) -> Data {
        serde_json::from_str(text).unwrap_or_else(|_| serde_json::value::RawValue::NULL.to_owned())
    }

    #[test]
    fn unwraps_the_inner_result() {
        let ok = unwrap(&raw(
            r#"{"ok":true,"operation":"status","data":{"b":1,"a":null}}"#,
        ));
        assert_eq!(
            ok.map(|d| d.get().to_string()).ok(),
            Some(r#"{"b":1,"a":null}"#.into())
        );
        let refused = unwrap(&raw(
            r#"{"ok":false,"operation":"node.get","error":{"type":"NotFound","message":"m","details":null}}"#,
        ));
        assert_eq!(
            refused.err().map(|f| (f.kind, f.details)),
            Some((ErrorType::NotFound, Some(Value::Null)))
        );
        for bad in [
            r#"{"ok":true,"operation":"status"}"#,
            r#"{"ok":true,"operation":"nope","data":1}"#,
            r#"{"ok":false,"operation":"status","error":{"type":"InputError","message":"m"}}"#,
            r#"{"ok":false,"operation":"status","error":{"type":"Conflict","message":""}}"#,
            r#"{"ok":true,"operation":"status","data":1,"x":1}"#,
        ] {
            assert_eq!(
                unwrap(&raw(bad)).err().map(|f| f.kind),
                Some(ErrorType::ProtocolError),
                "{bad}"
            );
        }
    }

    #[test]
    fn finds_seat_fields_main_works_out() {
        let batch = json!({ "steps": [
            { "operation": "node.create", "node": { "kind": "agent", "launch": {}, "overseer": true } },
            { "operation": "node.create", "node": { "kind": "note", "agentKey": "k" } },
        ] });
        let op = catalog::named("canvas.batch").map(|op| seat_fields_main_works_out(op, &batch));
        assert_eq!(op, Some(vec!["launch", "overseer"]));
    }

    #[test]
    fn a_report_blocks_on_a_required_unread_source() {
        let report = json!({ "seats": [{ "sources": [{ "sourceId": "a", "required": true, "status": "missing" }] }] });
        assert!(blocks_launch(&report));
        assert!(!blocks_launch(
            &json!({ "sourceId": "a", "required": false, "status": "error" })
        ));
    }
}
