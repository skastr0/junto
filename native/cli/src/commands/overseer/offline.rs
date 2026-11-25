//! The overseer's offline surface, answered with nothing running. The skill
//! and the capabilities are this crate's own: the skill's markdown is
//! corpus/overseer-skill.md, and both list this build's catalog. Its schemas
//! and examples are the root catalog's `overseer.*` entries in the built-in
//! corpus (src/help/corpus.rs).

use serde_json::{Map, Value, json};

use super::catalog::{self, Operation};
use crate::envelope::{self, Answer};
use crate::error::{Failure, Result};

/// The skill an overseer agent reads, with `{{families}}` where this build's
/// families go.
const SKILL: &str = include_str!("../../../corpus/overseer-skill.md");

/// What an overseer can never do, and why: the offline capabilities'
/// `unavailable`, in the order an agent reads them.
const UNAVAILABLE: &[(&str, &str)] = &[
    (
        "grant or revoke overseer",
        "Human-only toggle. Overseers cannot propagate.",
    ),
    (
        "delete own seat",
        "Direct, indirect, canvas delete, alias, or binding replacement that removes this seat is refused.",
    ),
    (
        "change what an overseer seat runs, remove it, or reseat it",
        "Operator only, for any overseer seat, this one included: agent, session, harness, host and launch. Renaming, moving, resizing and recoloring an overseer seat are allowed.",
    ),
    (
        "operator viewport mutation",
        "No pan, zoom, focus, resize, or switch. Screenshots observe only.",
    ),
    (
        "set a seat's overseer field",
        "Create, copy, configure, and reseat cannot mint or restore the grant: no draft or change carries it.",
    ),
    (
        "pause/play as authority",
        "Pause and play gate automated work only. They have no bearing on overseer command.",
    ),
    (
        "direct database or operator socket",
        "Closed overseer operations over the existing process-bind work socket only.",
    ),
    (
        "caller-supplied principal",
        "Identity is process-bind. No nodeRef or operator seat impersonation.",
    ),
];

/// The skill's markdown for this build: `status` and then each enabled
/// family, in catalog order.
pub fn skill_markdown() -> String {
    let families: Vec<&str> = std::iter::once("status")
        .chain(
            catalog::families()
                .into_iter()
                .filter(|family| *family != "overseer"),
        )
        .collect();
    SKILL.replacen("{{families}}", &families.join(", "), 1)
}

/// The offline surface: what this CLI carries, and what no overseer may do.
pub fn capabilities_data() -> Value {
    let unavailable: Vec<Value> = UNAVAILABLE
        .iter()
        .map(|(capability, reason)| json!({ "capability": capability, "reason": reason }))
        .collect();
    let transport: Vec<&str> = catalog::enabled().map(|op| op.name).collect();
    json!({
        "offline": true,
        "daemon_required": false,
        "transport": {
            "implemented": true,
            "work_op": "overseer",
            "request": { "operation": "OverseerOperation", "args": "optional" },
            "inner_result": "{ok:true,operation,data}|{ok:false,operation,error}",
        },
        "implemented": {
            "cli_transport": transport,
            "offline": ["overseer skill", "overseer schema", "overseer examples", "overseer capabilities"],
        },
        "unavailable": unavailable,
        "handlers": {
            "claimed": false,
            "note": "CLI ships the full catalog. Live handler availability is not claimed offline. Run overseer status under a live granted seat, or treat Unsupported as missing handler.",
        },
        "authority": {
            "grant": "human-only",
            "remote": "supported",
            "edges_required": false,
            "pause_play_has_bearing": false,
            "self_deletion": false,
            "operator_viewport_mutation": false,
            "propagation": false,
        },
    })
}

/// The `docs overseer` topic: the capabilities, and the skill.
pub fn docs_topic() -> Answer {
    envelope::ok(&json!({
        "topic": "overseer",
        "offline": true,
        "daemon_required": false,
        "capabilities": capabilities_data(),
        "content": skill_markdown(),
    }))
}

pub fn skill() -> Answer {
    envelope::ok(&json!({
        "name": "overseer",
        "offline": true,
        "daemon_required": false,
        "format": "agent-skill-markdown",
        "content": skill_markdown(),
    }))
}

pub fn capabilities() -> Answer {
    envelope::ok(&capabilities_data())
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
fn listed(mut list: Value, key: &str) -> Vec<Map<String, Value>> {
    let entries = list.get_mut(key).map(Value::take);
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
    let schemas: Vec<Value> = listed(crate::catalog::schema_list(), "schemas")
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
    match crate::catalog::schema_show(&format!("overseer.{}", op.name))? {
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
    envelope::ok(&json!({ "examples": listed(crate::catalog::examples_list(), "examples") }))
}

pub fn examples_show(target: &str) -> Answer {
    match resolve(target)
        .and_then(|op| crate::catalog::examples_show(&format!("overseer.{}", op.name)))
    {
        Some(shown) => envelope::ok(&shown),
        None => Err(
            Failure::input(format!("No overseer examples found for {target}"), "target")
                .and("hint", "junto overseer examples list"),
        ),
    }
}

/// retiredOverseerInvocation (src/cli/commands/overseer-retired.ts):
/// `junto overseer edge <rest>`, typed by an agent that still holds the old
/// skill, refused before parsing.
pub fn retired_edge(rest: &[&str]) -> Failure {
    rest.first()
        .filter(|verb| !verb.starts_with('-'))
        .and_then(|verb| retired(&format!("edge.{verb}")))
        .unwrap_or_else(|| {
            Failure::input(
                "the edge family is now wire: junto overseer wire --help",
                "family",
            )
            .and("hint", "junto overseer schema list")
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

/// The first key a JSON argument has and must not, or must have and lacks,
/// as the operation's schema says at its top level, in the words and order
/// of the TypeScript decode (Effect Schema reads excess keys first).
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
    let at = |key: &str| Value::from(key).to_string();
    let closed = schema.get("additionalProperties") == Some(&Value::Bool(false));
    let known = strings("properties");
    if let Some(excess) = args.keys().find(|key| closed && !known.contains(key)) {
        return Err(format!(
            "Expected no excess property\n  at [{}]",
            at(excess)
        ));
    }
    match strings("required")
        .into_iter()
        .find(|key| !args.contains_key(key))
    {
        Some(missing) => Err(format!("Missing key\n  at [{}]", at(&missing))),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{catalog, misfit};

    #[test]
    fn a_misfit_is_worded_as_the_typescript_decode_words_it() {
        let configure = catalog::named("agent.offboard-configure").expect("in the catalog");
        let args = |value: serde_json::Value| value.as_object().cloned().unwrap_or_default();
        assert_eq!(
            misfit(configure, &args(json!({ "nudge": { "minutes": 60 } }))),
            Err("Expected no excess property\n  at [\"nudge\"]".into())
        );
        let get = catalog::named("agent.get").expect("in the catalog");
        assert_eq!(
            misfit(get, &args(json!({}))),
            Err("Missing key\n  at [\"nodeId\"]".into())
        );
        // An excess key is read before a missing one, as Effect Schema reads them.
        assert_eq!(
            misfit(get, &args(json!({ "x": 1 }))),
            Err("Expected no excess property\n  at [\"x\"]".into())
        );
    }
}
