//! `schema` and `examples` (src/cli/commands/discovery.ts): the JSON input
//! schemas and the executable examples, answered from the built-in corpus.

use std::process::ExitCode;

use clap::{Args, Subcommand};

use super::Run;
use crate::envelope::{self, Answer, Reply};
use crate::error::Failure;
use crate::help::corpus::{CORPUS, Catalog};

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
    fn answer(&self, catalog: &Catalog, missing: &str) -> Answer {
        match self {
            Lookup::List => Ok(Reply::from(catalog.list.clone())),
            Lookup::Show { target } => catalog.show(target).map(Reply::from).ok_or_else(|| {
                Failure::input(format!("No {missing} found for {target}"), "target")
            }),
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
            self.command.answer(&CORPUS.schema, "schema"),
        )
    }
}

impl Run for Examples {
    fn run(self) -> ExitCode {
        envelope::print(
            &self.command.name("examples"),
            self.command.answer(&CORPUS.examples_catalog, "examples"),
        )
    }
}
