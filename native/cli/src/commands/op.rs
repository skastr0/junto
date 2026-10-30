//! `op` (src/cli/commands/op.ts): what became of this seat's resource writes,
//! read by the opId each returned. Each request type is its op's schema in
//! src/shared/op-control.ts, keys in the schema's order.

use std::process::ExitCode;

use clap::{Args, Subcommand, ValueEnum};
use serde::Serialize;
use serde_json::{Value, json};

use super::{Run, Timeout};
use crate::envelope::{self, Answer};
use crate::error::{ErrorType, Failure, Result};
use crate::ops;
use crate::wire::{self, OpId};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShowArgs {
    op_id: OpId,
}

/// OpListState: the queued writes, or the refused ones.
#[derive(Serialize, Clone, Copy, ValueEnum)]
#[serde(rename_all = "lowercase")]
enum State {
    Queued,
    Refused,
}

#[derive(Serialize)]
pub struct ListArgs {
    #[serde(skip_serializing_if = "Option::is_none")]
    state: Option<State>,
    #[serde(skip_serializing_if = "Option::is_none")]
    before: Option<OpId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    limit: Option<i64>,
}

ops! {
    ShowArgs => "op.show",
    ListArgs => "op.list",
}

/// What became of this seat's resource writes, by opId.
#[derive(Args)]
pub struct Op {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    Show {
        op_id: String,
        #[command(flatten)]
        timeout: Timeout,
    },
    List {
        #[arg(long)]
        state: Option<State>,
        #[arg(long)]
        limit: Option<i64>,
        #[arg(long)]
        before: Option<String>,
        #[command(flatten)]
        timeout: Timeout,
    },
}

/// An opId as typed, trimmed; anything but a ULID is refused before a call.
fn op_id(text: &str) -> Result<OpId> {
    serde_json::from_value(Value::String(text.trim().to_string())).map_err(|error| {
        Failure::new(ErrorType::InputError, error.to_string())
            .with(json!({ "hint": "junto schema show op.show or op.list shows the input" }))
    })
}

impl Run for Op {
    fn run(self) -> ExitCode {
        let (name, answer): (_, Answer) = match self.command {
            Command::Show { op_id: id, timeout } => (
                "op show",
                op_id(&id)
                    .and_then(|op_id| wire::call(&ShowArgs { op_id }, timeout.into()))
                    .map(Into::into),
            ),
            Command::List {
                state,
                limit,
                before,
                timeout,
            } => (
                "op list",
                before
                    .as_deref()
                    .map(op_id)
                    .transpose()
                    .and_then(|before| {
                        wire::call(
                            &ListArgs {
                                state,
                                before,
                                limit,
                            },
                            timeout.into(),
                        )
                    })
                    .map(Into::into),
            ),
        };
        envelope::print(name, answer)
    }
}
