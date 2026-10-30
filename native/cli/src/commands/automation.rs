//! `automation` (src/cli/commands/automation.ts): list, show and history over
//! the Automations nodes in this seat's reach. Seats read automations; the
//! operator and overseers write them (`overseer automation`). Each request
//! type is its op's schema in src/shared/automation-control.ts, which refuses
//! any key it does not name.

use std::process::ExitCode;

use clap::{Args, Subcommand};
use serde::{Deserialize, Serialize};

use super::{Run, Timeout};
use crate::envelope::{self, Answer};
use crate::wire::{self, Request};
use crate::{input, ops};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ListArgs {
    #[serde(skip_serializing_if = "Option::is_none")]
    target: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ShowArgs {
    target: String,
    automation: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HistoryArgs {
    target: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    automation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    limit: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    before: Option<String>,
}

ops! {
    ListArgs => "automation.list",
    ShowArgs => "automation.show",
    HistoryArgs => "automation.history",
}

/// Read the automations in this seat's reach.
#[derive(Args)]
pub struct Automation {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    List {
        input: Option<String>,
        #[command(flatten)]
        timeout: Timeout,
    },
    Show {
        input: String,
        #[command(flatten)]
        timeout: Timeout,
    },
    History {
        input: String,
        #[command(flatten)]
        timeout: Timeout,
    },
}

/// One read as main answers it; a refusal comes back as main's error.
fn read<R: Request + for<'de> Deserialize<'de>>(input: &str, timeout: Timeout) -> Answer {
    let args: R = input::load(input)?;
    wire::call(&args, timeout.into()).map(Into::into)
}

impl Run for Automation {
    fn run(self) -> ExitCode {
        let (name, answer) = match self.command {
            Command::List { input, timeout } => (
                "automation list",
                read::<ListArgs>(input.as_deref().unwrap_or("{}"), timeout),
            ),
            Command::Show { input, timeout } => {
                ("automation show", read::<ShowArgs>(&input, timeout))
            }
            Command::History { input, timeout } => {
                ("automation history", read::<HistoryArgs>(&input, timeout))
            }
        };
        envelope::print(name, answer)
    }
}
