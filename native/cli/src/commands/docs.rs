//! `docs` (src/cli/commands/docs.ts): the doctrine, the node catalog, the
//! concepts, the overseer's surface and the command surface, answered from
//! the built-in corpus with nothing running.

use std::process::ExitCode;

use clap::{Args, Subcommand};

use super::Run;
use crate::envelope::{self, Answer, Reply};
use crate::error::Failure;
use crate::help::corpus::CORPUS;

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
        let docs = &CORPUS.docs;
        let data = match self {
            Command::List => &docs.list,
            Command::Doctrine => &docs.doctrine,
            Command::Nodes => &docs.nodes,
            Command::Concepts => &docs.concepts,
            Command::Overseer => &docs.overseer,
            Command::Contract => &docs.contract,
            Command::Node { kind } => docs
                .node
                .get(kind)
                .ok_or_else(|| Failure::input(format!("unknown node kind {kind}"), "kind"))?,
            Command::Show { topic } => match topic.as_str() {
                "doctrine" => &docs.doctrine,
                "nodes" => &docs.nodes,
                "concepts" => &docs.concepts,
                "overseer" => &docs.overseer,
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
        Ok(Reply::from(data.clone()))
    }
}

impl Run for Docs {
    fn run(self) -> ExitCode {
        envelope::print(self.command.name(), self.command.answer())
    }
}
