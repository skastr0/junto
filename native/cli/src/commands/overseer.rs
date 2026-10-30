//! `overseer` (src/cli/commands/overseer.ts, overseer-automation.ts,
//! overseer-skill.ts): the closed operations of a human-granted overseer
//! seat, sent over the work socket as the op `overseer`, and the offline
//! surface that needs no daemon: skill, schema, examples and capabilities,
//! answered from the built-in corpus.

mod automation;
mod catalog;
mod live;
mod offline;

use std::process::ExitCode;

use clap::{Args, Subcommand};

use super::Run;
use crate::envelope;

/// Agent-native overseer commands (JSON).
#[derive(Args)]
pub struct Overseer {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    Skill,
    Schema {
        #[command(subcommand)]
        lookup: Lookup,
    },
    Examples {
        #[command(subcommand)]
        lookup: Lookup,
    },
    Capabilities,
    #[command(flatten)]
    Live(live::Call),
}

/// Every operation, or the one a target names: an operation, command id or command.
#[derive(Subcommand)]
enum Lookup {
    List,
    Show { target: String },
}

impl Run for Overseer {
    fn run(self) -> ExitCode {
        let (name, answer) = match self.command {
            Command::Skill => ("overseer skill", offline::skill()),
            Command::Schema {
                lookup: Lookup::List,
            } => ("overseer schema list", offline::schema_list()),
            Command::Schema {
                lookup: Lookup::Show { target },
            } => ("overseer schema show", offline::schema_show(&target)),
            Command::Examples {
                lookup: Lookup::List,
            } => ("overseer examples list", offline::examples_list()),
            Command::Examples {
                lookup: Lookup::Show { target },
            } => ("overseer examples show", offline::examples_show(&target)),
            Command::Capabilities => ("overseer capabilities", offline::capabilities()),
            Command::Live(call) => return call.run(),
        };
        envelope::print(name, answer)
    }
}
