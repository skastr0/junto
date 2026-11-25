//! `junto schema` and `junto examples` with nothing running: the input
//! schema of each command and the examples an agent can run, this crate's own
//! data (corpus/schemas.json, corpus/examples.json), gated per feature as the
//! command tree is.
//!
//! A schema is named, not copied, when the contract publishes it: a work op's
//! payload (src/contract/work/published/<op>.json) or an overseer operation's
//! args (published/overseer/<operation>.json). One the command takes in a
//! shape of its own, such as positional words or a body read from a file, is
//! a file in corpus/schemas/. build.rs resolves every name at build time, so a
//! schema that names nothing fails the build.

use std::collections::HashMap;
use std::sync::LazyLock;

use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::help::tree::{Gate, Text};

/// Each schema the catalog names, by `op:<op>`, `overseer:<operation>` or `file:<name>`.
static SOURCES: LazyLock<HashMap<String, Value>> = LazyLock::new(|| {
    serde_json::from_str(include_str!(concat!(env!("OUT_DIR"), "/schemas.json")))
        .expect("build.rs writes the schemas as JSON")
});

static SCHEMAS: LazyLock<Vec<Schema>> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../corpus/schemas.json"))
        .expect("corpus/schemas.json parses")
});

static EXAMPLES: LazyLock<Vec<Example>> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../corpus/examples.json"))
        .expect("corpus/examples.json parses")
});

/// How a command reads its JSON input when none other is named.
const INPUT_MODES: [&str; 3] = ["inline-json", "@file", "stdin"];

/// Where a schema's JSON Schema comes from.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase", deny_unknown_fields)]
enum Source {
    Op(String),
    Overseer(String),
    File(String),
}

impl Source {
    fn key(&self) -> String {
        match self {
            Source::Op(op) => format!("op:{op}"),
            Source::Overseer(operation) => format!("overseer:{operation}"),
            Source::File(name) => format!("file:{name}"),
        }
    }
}

/// A command's input contract.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Schema {
    command_id: String,
    command: String,
    schema_id: String,
    #[serde(default)]
    when: Vec<Gate>,
    description: Text,
    #[serde(default)]
    accepts_batch: bool,
    input_modes: Option<Vec<String>>,
    schema: Source,
}

/// A command line an agent can run as it stands.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Example {
    command_id: String,
    command: String,
    name: String,
    #[serde(default)]
    when: Vec<Gate>,
    description: Option<String>,
    args: Option<Vec<String>>,
    input: Option<Value>,
}

fn on(gates: &[Gate]) -> bool {
    gates.iter().all(|gate| gate.on())
}

fn schemas() -> impl Iterator<Item = &'static Schema> {
    SCHEMAS.iter().filter(|schema| on(&schema.when))
}

fn examples() -> impl Iterator<Item = &'static Example> {
    EXAMPLES.iter().filter(|example| on(&example.when))
}

/// Fields in order, each left out when it is None.
fn object(fields: impl IntoIterator<Item = (&'static str, Option<Value>)>) -> Value {
    Value::Object(
        fields
            .into_iter()
            .filter_map(|(key, value)| Some((key.to_string(), value?)))
            .collect::<Map<_, _>>(),
    )
}

impl Schema {
    fn names(&self, target: &str) -> bool {
        [&self.command_id, &self.command, &self.schema_id]
            .iter()
            .any(|key| key.as_str() == target)
    }

    fn listed(&self) -> Value {
        json!({
            "command_id": self.command_id,
            "command": self.command,
            "schema_id": self.schema_id,
            "description": self.description.said(),
            "accepts_batch": self.accepts_batch,
        })
    }

    fn shown(&self) -> Value {
        let modes: Vec<&str> = match &self.input_modes {
            Some(modes) => modes.iter().map(String::as_str).collect(),
            None => INPUT_MODES.to_vec(),
        };
        json!({
            "command_id": self.command_id,
            "command": self.command,
            "schema_id": self.schema_id,
            "description": self.description.said(),
            "accepts_batch": self.accepts_batch,
            "input_modes": modes,
            // build.rs resolved every source, so one is always found.
            "schema": SOURCES.get(&self.schema.key()).cloned().unwrap_or_default(),
        })
    }
}

impl Example {
    fn description(&self) -> Option<Value> {
        self.description.clone().map(Value::from)
    }

    fn listed(&self) -> Value {
        object([
            ("command_id", Some(self.command_id.clone().into())),
            ("command", Some(self.command.clone().into())),
            ("name", Some(self.name.clone().into())),
            ("description", self.description()),
        ])
    }

    fn shown(&self) -> Value {
        object([
            ("name", Some(self.name.clone().into())),
            ("description", self.description()),
            ("args", self.args.clone().map(Value::from)),
            ("input", self.input.clone()),
        ])
    }
}

/// `schema list`: every command's schema in this build, without the schemas.
pub fn schema_list() -> Value {
    json!({ "schemas": schemas().map(Schema::listed).collect::<Vec<_>>() })
}

/// `schema show <target>`: the first schema the target names, by command
/// id, command or schema id, with the JSON Schema itself.
pub fn schema_show(target: &str) -> Option<Value> {
    let target = target.trim();
    schemas()
        .find(|schema| schema.names(target))
        .map(Schema::shown)
}

/// `examples list`: every example in this build, without its command line.
pub fn examples_list() -> Value {
    json!({ "examples": examples().map(Example::listed).collect::<Vec<_>>() })
}

/// `examples show <target>`: every example the target names, by command id
/// or command, under the first one's command.
pub fn examples_show(target: &str) -> Option<Value> {
    let target = target.trim();
    let matched: Vec<&Example> = examples()
        .filter(|example| example.command_id == target || example.command == target)
        .collect();
    let first = matched.first()?;
    Some(json!({
        "command_id": first.command_id,
        "command": first.command,
        "examples": matched.iter().map(|example| example.shown()).collect::<Vec<_>>(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::help::tree::TREE;

    #[test]
    fn every_schema_resolves_to_a_json_schema() {
        for schema in SCHEMAS.iter() {
            let resolved = SOURCES.get(&schema.schema.key());
            assert!(
                resolved.is_some_and(Value::is_object),
                "{} names {}, which is not a JSON Schema",
                schema.schema_id,
                schema.schema.key()
            );
        }
    }

    /// An agent runs an example as it stands: its words name a command this
    /// build has, one that runs rather than a group that only shows its help.
    #[test]
    fn every_example_of_this_build_runs_a_command_it_has() {
        for example in examples() {
            let args = example.args.as_deref().unwrap_or_default();
            let mut command = &*TREE;
            let mut named = 0;
            for word in args {
                let Some(next) = command.subcommand(word) else {
                    break;
                };
                command = next;
                named += 1;
            }
            assert!(
                named > 0 && !command.is_group(),
                "example {:?} of junto {} runs {args:?}, which names no command",
                example.name,
                example.command
            );
        }
    }

    #[test]
    fn an_entry_gated_off_is_neither_listed_nor_shown() {
        for schema in SCHEMAS.iter().filter(|schema| !on(&schema.when)) {
            let listed = schema_list();
            assert!(
                !listed["schemas"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .any(|entry| entry["schema_id"] == schema.schema_id.as_str()),
                "{} is gated off",
                schema.schema_id
            );
            assert!(
                schema_show(&schema.schema_id).is_none(),
                "{} is gated off",
                schema.schema_id
            );
        }
    }

    #[test]
    fn a_schema_is_shown_by_its_command_id_its_command_or_its_schema_id() {
        let shown = |target| schema_show(target).map(|schema| schema["schema_id"].clone());
        assert_eq!(shown("msg.send"), Some("msg.send.input/v1".into()));
        assert_eq!(shown("msg send"), Some("msg.send.input/v1".into()));
        assert_eq!(
            shown(" msg.send.input/v1 "),
            Some("msg.send.input/v1".into())
        );
        assert_eq!(
            shown("msg send --prompt"),
            Some("msg.prompt.input/v1".into())
        );
        assert_eq!(shown("nope"), None);
    }

    #[test]
    fn a_shown_schema_carries_its_input_modes_and_the_published_schema() {
        let shown = schema_show("thread.show").expect("thread show");
        assert_eq!(shown["input_modes"], json!(INPUT_MODES));
        let published: Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../src/contract/work/published/thread.show.json"
        )))
        .expect("published");
        assert_eq!(shown["schema"], published["payload"]["schema"]);
        let stage = schema_show("content.stage").expect("content stage");
        assert_eq!(stage["input_modes"], json!(["inline-json"]));
    }

    #[test]
    fn examples_show_gathers_every_example_of_a_command_in_order() {
        let shown = examples_show("msg.send").expect("msg send examples");
        let names: Vec<&str> = EXAMPLES
            .iter()
            .filter(|example| {
                on(&example.when)
                    && (example.command_id == "msg.send" || example.command == "msg.send")
            })
            .map(|example| example.name.as_str())
            .collect();
        let got: Vec<&str> = shown["examples"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|e| e["name"].as_str())
            .collect();
        assert!(!got.is_empty());
        assert_eq!(got, names);
        assert!(examples_show("nope").is_none());
    }
}
