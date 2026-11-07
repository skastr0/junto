//! `references` (src/cli/commands/references.ts): the operator's references
//! in this seat's scope. The name is a plain argument, not JSON.

use std::process::ExitCode;

use clap::{Args, Subcommand};
use serde::{Deserialize, Serialize};

use super::{Run, Timeout};
use crate::{envelope, ops, wire};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ListArgs {}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReadArgs {
    name: String,
}

ops! {
    ListArgs => "references.list",
    ReadArgs => "references.read",
}

#[cfg(test)]
mod contract {
    // references.list joins when the harness reads a closed object through allOf:
    // its schema takes no key, which an empty Schema.Struct cannot publish alone.
    crate::contract::parity! {
        read: super::ReadArgs => "references.read",
    }
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
