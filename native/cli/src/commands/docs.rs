//! `docs`: the doctrine, the node catalog, the
//! concepts, the overseer's surface and the command surface, answered from
//! the built-in docs with nothing running; the overseer topic is the
//! overseer command's own (commands/overseer/offline.rs).

use std::process::ExitCode;

use clap::{Args, Subcommand};

use super::Run;
use super::overseer::docs_topic;
use crate::envelope::{self, Answer};
use crate::error::Failure;
use crate::help::corpus::DOCS;

/// Junto documentation — the full doctrine and node catalog
#[derive(Args)]
pub struct Docs {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    List,
    Doctrine,
    Nodes,
    Node { kind: String },
    Concepts,
    Overseer,
    Contract,
    Show { topic: String },
}

impl Command {
    fn name(&self) -> &'static str {
        match self {
            Command::List => "docs list",
            Command::Doctrine => "docs doctrine",
            Command::Nodes => "docs nodes",
            Command::Node { .. } => "docs node",
            Command::Concepts => "docs concepts",
            Command::Overseer => "docs overseer",
            Command::Contract => "docs contract",
            Command::Show { .. } => "docs show",
        }
    }

    fn answer(&self) -> Answer {
        let data = match self {
            Command::List => DOCS.list(),
            Command::Doctrine => DOCS.doctrine(),
            Command::Nodes => DOCS.nodes(),
            Command::Concepts => DOCS.concepts(),
            Command::Overseer => return docs_topic(),
            Command::Contract => DOCS.contract(),
            Command::Node { kind } => DOCS
                .node(kind)
                .ok_or_else(|| Failure::input(format!("unknown node kind {kind}"), "kind"))?,
            Command::Show { topic } => match topic.as_str() {
                "doctrine" => DOCS.doctrine(),
                "nodes" => DOCS.nodes(),
                "concepts" => DOCS.concepts(),
                "overseer" => return docs_topic(),
                "contract" => {
                    return Err(Failure::input(
                        "use `docs contract` for the command surface",
                        "topic",
                    ));
                }
                _ => {
                    return Err(Failure::input(
                        format!("unknown topic {topic} — docs list"),
                        "topic",
                    ));
                }
            },
        };
        envelope::ok(&data)
    }
}

impl Run for Docs {
    fn run(self) -> ExitCode {
        envelope::print(self.command.name(), self.command.answer())
    }
}
