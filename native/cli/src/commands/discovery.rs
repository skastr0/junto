//! `schema` and `examples`: the JSON input
//! schemas and the executable examples, answered from the built-in catalog.

use std::process::ExitCode;

use clap::{Args, Subcommand};

use serde_json::Value;

use super::Run;
use crate::catalog;
use crate::envelope::{self, Answer};
use crate::error::Failure;

/// Schema discovery
#[derive(Args)]
pub struct Schema {
    #[command(subcommand)]
    command: Lookup,
}

/// Example discovery
#[derive(Args)]
pub struct Examples {
    #[command(subcommand)]
    command: Lookup,
}

/// Both families list everything, or show what one target names: a schema
/// id, command id, or command name.
#[derive(Subcommand)]
enum Lookup {
    List,
    Show { target: String },
}

impl Lookup {
    fn answer(
        &self,
        list: fn() -> Value,
        show: fn(&str) -> Option<Value>,
        missing: &str,
    ) -> Answer {
        match self {
            Lookup::List => envelope::ok(&list()),
            Lookup::Show { target } => match show(target) {
                Some(found) => envelope::ok(&found),
                None => Err(Failure::input(
                    format!("No {missing} found for {target}"),
                    "target",
                )),
            },
        }
    }

    fn name(&self, family: &'static str) -> String {
        match self {
            Lookup::List => format!("{family} list"),
            Lookup::Show { .. } => format!("{family} show"),
        }
    }
}

impl Run for Schema {
    fn run(self) -> ExitCode {
        envelope::print(
            &self.command.name("schema"),
            self.command
                .answer(catalog::schema_list, catalog::schema_show, "schema"),
        )
    }
}

impl Run for Examples {
    fn run(self) -> ExitCode {
        envelope::print(
            &self.command.name("examples"),
            self.command
                .answer(catalog::examples_list, catalog::examples_show, "examples"),
        )
    }
}
