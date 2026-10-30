//! The overseer's offline surface, answered with nothing running from the
//! built-in corpus (src/help/corpus.rs): its schemas and examples are the
//! root catalog's `overseer.*` entries, and its skill and capabilities the
//! `docs overseer` topic, each as the TypeScript CLI prints it.

use serde_json::{Map, Value, json};

use super::catalog::{self, Operation};
use crate::envelope::{self, Answer, Reply};
use crate::error::{Failure, Result};
use crate::help::corpus::CORPUS;

/// The docs topic's two parts: the capabilities, and the skill's markdown.
fn topic(key: &str) -> Value {
    serde_json::from_str::<Value>(CORPUS.docs.overseer.get())
        .ok()
        .and_then(|mut topic| topic.get_mut(key).map(Value::take))
        .unwrap_or_default()
}

pub fn skill() -> Answer {
    envelope::ok(&json!({
        "name": "overseer",
        "offline": true,
        "daemon_required": false,
        "format": "agent-skill-markdown",
        "content": topic("content"),
    }))
}

pub fn capabilities() -> Answer {
    envelope::ok(&topic("capabilities"))
}

/// matchesOverseerTarget: an operation, its command id or its command, of
/// this build's catalog only.
fn resolve(target: &str) -> Option<&'static Operation> {
    let target = target.trim();
    catalog::enabled().find(|op| {
        target == op.name
            || target.strip_prefix("overseer.") == Some(op.name)
            || target == format!("overseer {}", op.name.replacen('.', " ", 1))
            || (op.name == "status" && target == "overseer status")
    })
}

/// The entries of a root catalog list that are this build's overseer operations.
fn listed(list: &str, key: &str) -> Vec<Map<String, Value>> {
    let entries = serde_json::from_str::<Value>(list)
        .ok()
        .and_then(|mut list| list.get_mut(key).map(Value::take));
    let Some(Value::Array(entries)) = entries else {
        return Vec::new();
    };
    entries
        .into_iter()
        .filter_map(|entry| match entry {
            Value::Object(entry) => Some(entry),
            _ => None,
        })
        .filter(|entry| operation_of(entry).is_some())
        .collect()
}

fn operation_of(entry: &Map<String, Value>) -> Option<&'static Operation> {
    let id = entry
        .get("command_id")?
        .as_str()?
        .strip_prefix("overseer.")?;
    catalog::named(id).filter(|op| op.enabled())
}

pub fn schema_list() -> Answer {
    let schemas: Vec<Value> = listed(CORPUS.schema.list.get(), "schemas")
        .into_iter()
        .map(|entry| {
            let field = |key: &str| entry.get(key).cloned().unwrap_or_default();
            json!({
                "command_id": field("command_id"),
                "command": field("command"),
                "schema_id": field("schema_id"),
                "description": field("description"),
                "operation": operation_of(&entry).map(|op| op.name),
                "accepts_batch": false,
            })
        })
        .collect();
    envelope::ok(&json!({ "schemas": schemas }))
}

/// One operation's input contract, as `junto schema show overseer.<op>` prints it.
pub fn contract(op: &Operation) -> Option<Map<String, Value>> {
    let shown = CORPUS.schema.show(&format!("overseer.{}", op.name))?;
    match serde_json::from_str(shown.get()).ok()? {
        Value::Object(contract) => Some(contract),
        _ => None,
    }
}

pub fn schema_show(target: &str) -> Answer {
    let Some(op) = resolve(target) else {
        return Err(retired(target).unwrap_or_else(|| {
            Failure::input(format!("No overseer schema found for {target}"), "target")
                .and("hint", "junto overseer schema list")
        }));
    };
    let mut contract = contract(op).ok_or_else(|| {
        Failure::input(format!("No overseer schema found for {target}"), "target")
    })?;
    contract.insert("operation".into(), op.name.into());
    envelope::ok(&contract)
}

pub fn examples_list() -> Answer {
    envelope::ok(&json!({ "examples": listed(CORPUS.examples_catalog.list.get(), "examples") }))
}

pub fn examples_show(target: &str) -> Answer {
    resolve(target)
        .and_then(|op| {
            CORPUS
                .examples_catalog
                .show(&format!("overseer.{}", op.name))
        })
        .map(Reply::from)
        .ok_or_else(|| {
            Failure::input(format!("No overseer examples found for {target}"), "target")
                .and("hint", "junto overseer examples list")
        })
}

/// OVERSEER_RETIRED_OPERATIONS: the edge family is now wire.
fn retired(target: &str) -> Option<Failure> {
    let trimmed = target.trim();
    let named = trimmed
        .strip_prefix("overseer.")
        .or_else(|| trimmed.strip_prefix("overseer "))
        .unwrap_or(trimmed)
        .replacen(' ', ".", 1);
    let verb = named.strip_prefix("edge.")?;
    let replacement = format!("wire.{verb}");
    matches!(
        verb,
        "list" | "get" | "verbs" | "connect" | "configure" | "disconnect"
    )
    .then(|| {
        Failure::input(
            format!("{named} is now {replacement}: the edge family is now wire"),
            "operation",
        )
        .and("hint", format!("junto overseer schema show {replacement}"))
    })
}

/// The first key a JSON argument must have and lacks, or has and must not,
/// as the operation's schema says at its top level.
pub fn misfit(op: &Operation, args: &Map<String, Value>) -> Result<(), String> {
    let Some(schema) = contract(op).and_then(|mut contract| contract.remove("schema")) else {
        return Ok(());
    };
    let strings = |key: &str| -> Vec<String> {
        match schema.get(key) {
            Some(Value::Array(names)) => names
                .iter()
                .filter_map(Value::as_str)
                .map(String::from)
                .collect(),
            Some(Value::Object(fields)) => fields.keys().cloned().collect(),
            _ => Vec::new(),
        }
    };
    if let Some(missing) = strings("required")
        .into_iter()
        .find(|key| !args.contains_key(key))
    {
        return Err(format!("{missing} is missing"));
    }
    let closed = schema.get("additionalProperties") == Some(&Value::Bool(false));
    let known = strings("properties");
    match args.keys().find(|key| closed && !known.contains(key)) {
        Some(excess) => Err(format!("{excess} is unexpected")),
        None => Ok(()),
    }
}
