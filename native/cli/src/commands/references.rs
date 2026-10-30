//! `references` (src/cli/commands/references.ts): the operator's references
//! in this seat's scope. The name is a plain argument, not JSON.

use std::process::ExitCode;

use clap::{Args, Subcommand};
use serde::Serialize;

use super::{Run, Timeout};
use crate::{envelope, ops, wire};

#[derive(Serialize)]
pub struct ListArgs {}

#[derive(Serialize)]
pub struct ReadArgs {
    name: String,
}

ops! {
    ListArgs => "references.list",
    ReadArgs => "references.read",
}

/// The operator's references this seat can read
#[derive(Args)]
pub struct References {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    List {
        #[command(flatten)]
        timeout: Timeout,
    },
    Read {
        name: String,
        #[command(flatten)]
        timeout: Timeout,
    },
}

impl Run for References {
    fn run(self) -> ExitCode {
        match self.command {
            Command::List { timeout } => envelope::print(
                "references list",
                wire::call(&ListArgs {}, timeout.into()).map(Into::into),
            ),
            Command::Read { name, timeout } => envelope::print(
                "references read",
                wire::call(&ReadArgs { name }, timeout.into()).map(Into::into),
            ),
        }
    }
}
