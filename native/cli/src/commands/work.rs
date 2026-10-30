//! `preamble` and `rulings` (src/cli/commands/work.ts).

use std::process::ExitCode;

use clap::Args;
use serde::{Deserialize, Serialize};

use super::{Run, Timeout};
use crate::{envelope, input, ops, wire};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PreambleArgs {
    text: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RulingsArgs {
    #[serde(skip_serializing_if = "Option::is_none")]
    target: Option<String>,
}

ops! {
    PreambleArgs => "preamble",
    RulingsArgs => "rulings",
}

/// Show a short-lived preamble above this agent node (about 30 seconds)
#[derive(Args)]
pub struct Preamble {
    input: String,
    #[command(flatten)]
    timeout: Timeout,
}

impl Run for Preamble {
    fn run(self) -> ExitCode {
        let answer = input::load::<PreambleArgs>(&self.input)
            .and_then(|args| wire::call(&args, self.timeout.into()))
            .map(Into::into);
        envelope::print("preamble", answer)
    }
}

/// Pinned rulings for this seat's region stack, or a connected target's
#[derive(Args)]
pub struct Rulings {
    input: Option<String>,
    #[command(flatten)]
    timeout: Timeout,
}

impl Run for Rulings {
    fn run(self) -> ExitCode {
        let answer = input::load_or_empty::<RulingsArgs>(self.input.as_deref())
            .and_then(|args| wire::call(&args, self.timeout.into()))
            .map(Into::into);
        envelope::print("rulings", answer)
    }
}
