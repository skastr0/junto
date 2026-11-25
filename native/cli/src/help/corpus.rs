//! The docs `junto docs` answers with nothing running. The doctrine, the node
//! catalog, the concepts and each node kind's page are the core's, published
//! per feature combination (src/contract/docs/published); build.rs embeds the
//! one this build's features name. The contract table is this crate's own
//! (corpus/contract.json), a row per command, gated as the command tree is.

use std::collections::HashMap;
use std::sync::LazyLock;

use serde::Deserialize;
use serde_json::value::RawValue;
use serde_json::{Value, json};

use super::tree::{Gate, Text};

/// Parsed on first use: build.rs wrote it, so docs that do not parse are a
/// broken build, not input.
pub static DOCS: LazyLock<Docs> = LazyLock::new(|| {
    serde_json::from_str(include_str!(concat!(env!("OUT_DIR"), "/docs.json")))
        .expect("the docs build.rs wrote parse")
});

static CONTRACT: LazyLock<Vec<Row>> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../corpus/contract.json"))
        .expect("corpus/contract.json parses")
});

#[derive(Deserialize)]
pub struct Docs {
    topics: Box<RawValue>,
    doctrine: String,
    nodes: String,
    concepts: String,
    node: HashMap<String, String>,
    /// Every root command onboard can teach in this build.
    #[cfg(test)]
    pub taught_roots: Vec<String>,
}

/// One command of the contract table.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Row {
    command: String,
    #[serde(default)]
    when: Vec<Gate>,
    category: String,
    description: Text,
}

/// A topic's answer, as `docs <topic>` prints it.
fn topic(name: &str, content: &str) -> Value {
    json!({ "topic": name, "content": content })
}

impl Docs {
    pub fn list(&self) -> Value {
        json!({ "topics": self.topics })
    }

    pub fn doctrine(&self) -> Value {
        topic("doctrine", &self.doctrine)
    }

    pub fn nodes(&self) -> Value {
        topic("nodes", &self.nodes)
    }

    pub fn concepts(&self) -> Value {
        topic("concepts", &self.concepts)
    }

    /// A node kind's page, when this build has the kind.
    pub fn node(&self, kind: &str) -> Option<Value> {
        let content = self.node.get(kind)?;
        Some(json!({ "topic": "node", "kind": kind, "content": content }))
    }

    /// The command surface: a row per command this build has.
    pub fn contract(&self) -> Value {
        let mut lines = vec![
            "# CLI contract — full surface".to_string(),
            String::new(),
            "| command | category | description |".into(),
            "|---|---|---|".into(),
        ];
        lines.extend(
            CONTRACT
                .iter()
                .filter(|row| row.when.iter().all(|gate| gate.on()))
                .map(|row| {
                    format!(
                        "| `junto {}` | {} | {} |",
                        row.command,
                        row.category,
                        row.description.said()
                    )
                }),
        );
        topic("contract", &lines.join("\n"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::help::tree::TREE;

    /// The contract table and the command tree agree: each row this build
    /// lists is a command it has.
    #[test]
    fn every_contract_row_of_this_build_is_a_command_it_has() {
        for row in CONTRACT
            .iter()
            .filter(|row| row.when.iter().all(|gate| gate.on()))
        {
            let words = row
                .command
                .split(' ')
                .take_while(|word| !word.starts_with('-'));
            assert!(
                TREE.at(words).is_some(),
                "the contract lists junto {}",
                row.command
            );
        }
    }

    #[test]
    fn the_contract_is_a_table_of_this_builds_commands() {
        let content = DOCS.contract()["content"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        let rows: Vec<&str> = content.lines().skip(4).collect();
        assert_eq!(
            rows.len(),
            CONTRACT
                .iter()
                .filter(|row| row.when.iter().all(|gate| gate.on()))
                .count()
        );
        assert!(
            rows.iter()
                .all(|row| row.starts_with("| `junto ") && row.ends_with(" |"))
        );
        assert_eq!(
            rows.iter().any(|row| row.starts_with("| `junto task ")),
            Gate::Tasks.on()
        );
    }

    #[test]
    fn a_node_kind_is_shown_only_when_this_build_has_it() {
        assert!(DOCS.node("agent").is_some());
        assert_eq!(DOCS.node("task").is_some(), Gate::Tasks.on());
        assert_eq!(DOCS.node("page").is_some(), Gate::Browser.on());
        assert!(DOCS.node("nope").is_none());
    }
}
