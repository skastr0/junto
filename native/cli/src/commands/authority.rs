//! `authority` over the operator socket (src/cli/commands/authority.ts):
//! what this machine knows of each canvas's authority, and the operator's
//! one path to divergence. Owner only; the group is off unless the build
//! carries it (main.rs).

use std::collections::HashSet;
use std::process::ExitCode;

use clap::{Args, Subcommand};
use serde::Serialize;
use serde_json::{Map, Value};

use super::Run;
use crate::envelope::{self, Answer};
use crate::error::{ErrorType, Failure, Result};
use crate::operator;

/// Read, order and break the authority of a canvas this machine holds
#[derive(Args)]
pub struct Authority {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    Status {
        canvas: Option<String>,
    },
    Alone {
        canvas: String,
    },
    List {
        canvas: String,
        #[arg(long)]
        order: String,
    },
}

#[derive(Serialize)]
struct StatusArgs<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    canvas: Option<&'a str>,
}

#[derive(Serialize)]
struct AloneArgs<'a> {
    canvas: &'a str,
}

#[derive(Serialize)]
struct ListArgs<'a> {
    canvas: &'a str,
    order: Vec<&'a str>,
}

impl Run for Authority {
    fn run(self) -> ExitCode {
        match self.command {
            Command::Status { canvas } => {
                envelope::print("authority status", status(canvas.as_deref()))
            }
            Command::Alone { canvas } => envelope::print(
                "authority alone",
                // The warning is printed in full, never cut.
                operator::call("authority.alone", &AloneArgs { canvas: &canvas }, None)
                    .map(Into::into),
            ),
            Command::List { canvas, order } => {
                envelope::print("authority list", list(&canvas, &order))
            }
        }
    }
}

fn data(op: &str, args: &impl Serialize) -> Result<Map<String, Value>> {
    let data = operator::call(op, args, None)?;
    match serde_json::from_str(data.get()) {
        Ok(Value::Object(map)) => Ok(map),
        _ => Err(Failure::new(
            ErrorType::OperatorProtocolError,
            format!("{op} answered outside its contract"),
        )),
    }
}

/// The status as printed: every machine with its state in words.
fn status(canvas: Option<&str>) -> Answer {
    let mut data = data("authority.status", &StatusArgs { canvas })?;
    let mut take = |key: &str| data.remove(key).unwrap_or(Value::Null);
    let (me, machines, canvases) = (take("self"), take("machines"), take("canvases"));
    let mut out = Map::new();
    out.insert("self".into(), with_state(me));
    out.insert("machines".into(), each(machines, with_state));
    out.insert("canvases".into(), each(canvases, canvas_out));
    envelope::ok(&out)
}

/// The list edit: what was named, and the list that rules until the joint entry commits.
fn list(canvas: &str, order: &str) -> Answer {
    let names: Vec<&str> = order
        .split(',')
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .collect();
    let unique = names.iter().collect::<HashSet<_>>().len() == names.len();
    if !(1..=32).contains(&names.len()) || !unique {
        return Err(Failure::input(
            "--order names each machine once, 1 to 32 of them, comma separated",
            "order",
        )
        .and(
            "next_step",
            "junto authority status lists the machines this machine knows by name",
        ));
    }
    let mut data = data(
        "authority.list",
        &ListArgs {
            canvas,
            order: names,
        },
    )?;
    for key in ["named", "committed"] {
        if let Some(machines) = data.get_mut(key) {
            *machines = each(machines.take(), with_state);
        }
    }
    envelope::ok(&data)
}

fn each(value: Value, f: fn(Value) -> Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.into_iter().map(f).collect()),
        other => other,
    }
}

fn canvas_out(canvas: Value) -> Value {
    let Value::Object(mut canvas) = canvas else {
        return canvas;
    };
    if let Some(authority) = canvas.get_mut("authority").filter(|a| !a.is_null()) {
        *authority = with_state(authority.take());
    }
    if let Some(list) = canvas.get_mut("list") {
        *list = each(list.take(), with_state);
    }
    Value::Object(canvas)
}

/// A machine with its state in words, after its facts.
fn with_state(machine: Value) -> Value {
    let Value::Object(mut machine) = machine else {
        return machine;
    };
    let line = state_line(&machine);
    machine.insert("state".into(), Value::String(line));
    Value::Object(machine)
}

/// authorityMachineLine: "Mac mini asleep since 2026-10-30T01:12:00.000Z".
fn state_line(machine: &Map<String, Value>) -> String {
    let label = machine
        .get("label")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match machine.get("reach").and_then(Value::as_str) {
        Some("here") => "this machine".into(),
        Some("asleep") => match machine
            .get("since")
            .and_then(Value::as_i64)
            .and_then(iso_time)
        {
            Some(since) => format!("{label} asleep since {since}"),
            None => format!("{label} asleep"),
        },
        Some("not-linked") => format!("{label} not linked"),
        Some(reach) => format!("{label} {reach}"),
        None => label.into(),
    }
}

/// Epoch milliseconds as toISOString writes them, UTC.
fn iso_time(at: i64) -> Option<String> {
    jiff::Timestamp::from_millisecond(at)
        .ok()
        .map(|t| t.strftime("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn says_each_machine_state_in_words() {
        let machine = |reach: &str, since: Value| json!({ "label": "Mac mini", "reach": reach, "since": since });
        let line = |m: Value| {
            with_state(m)["state"]
                .as_str()
                .unwrap_or_default()
                .to_string()
        };
        assert_eq!(line(machine("here", Value::Null)), "this machine");
        assert_eq!(
            line(machine("asleep", json!(1_793_336_400_000_i64))),
            "Mac mini asleep since 2026-10-30T05:00:00.000Z"
        );
        assert_eq!(line(machine("asleep", Value::Null)), "Mac mini asleep");
        assert_eq!(
            line(machine("not-linked", Value::Null)),
            "Mac mini not linked"
        );
        assert_eq!(
            line(machine("unreachable", Value::Null)),
            "Mac mini unreachable"
        );
    }
}
