//! escalate, blocked, feedback and `signal` (src/cli/commands/signals.ts):
//! how a seat raises its hand to the operator. No edge or port is needed; a
//! seat can only speak for itself.

use std::process::ExitCode;

use clap::{Args, Subcommand};
use serde::Serialize;

use super::{Run, Timeout};
use crate::attach::signal_input::{self, Raise};
use crate::attach::{Kind, signal_attach, signal_form};
use crate::envelope::{self, Answer};
use crate::{ops, wire};

/// What escalate, blocked and feedback all take.
#[derive(Args)]
struct Common {
    /// One sentence, or a JSON object {"text","detail","attach"} inline, @file, or - for stdin
    #[arg(allow_hyphen_values = true)]
    input: String,
    /// Longer markdown for the operator: inline, @file, or - for stdin
    #[arg(long, allow_hyphen_values = true)]
    detail: Option<String>,
    /// A reply the operator can send in one click, ahead of the quick replies. At most two.
    #[arg(long, allow_hyphen_values = true)]
    suggest: Vec<String>,
    #[command(flatten)]
    attach: signal_attach::AttachFlags,
    #[command(flatten)]
    timeout: Timeout,
}

impl Common {
    fn raise(self, kind: Kind, form: &signal_form::FormFlags) -> ExitCode {
        let raise = Raise {
            kind,
            input: &self.input,
            detail: self.detail.as_deref(),
            suggest: &self.suggest,
            attach: &self.attach,
            form,
            timeout: self.timeout.into(),
        };
        let answer = signal_input::load(raise).and_then(|args| wire::call(&args, self.timeout.into())).map(Into::into);
        envelope::print(kind.name(), answer)
    }
}

/// Needs the operator's attention; you keep working
#[derive(Args)]
pub struct Escalate {
    #[command(flatten)]
    common: Common,
    #[command(flatten)]
    form: signal_form::FormFlags,
}

/// Work is entirely blocked on the operator; stop and wait for the answer
#[derive(Args)]
pub struct Blocked {
    #[command(flatten)]
    common: Common,
    #[command(flatten)]
    form: signal_form::FormFlags,
}

/// Not blocked: the work is ready for the operator to review
#[derive(Args)]
pub struct Feedback {
    #[command(flatten)]
    common: Common,
}

impl Run for Escalate {
    fn run(self) -> ExitCode {
        self.common.raise(Kind::Escalate, &self.form)
    }
}

impl Run for Blocked {
    fn run(self) -> ExitCode {
        self.common.raise(Kind::Blocked, &self.form)
    }
}

impl Run for Feedback {
    fn run(self) -> ExitCode {
        self.common.raise(Kind::Feedback, &signal_form::FormFlags::default())
    }
}

#[derive(Serialize)]
pub struct ListArgs {
    #[serde(skip_serializing_if = "Option::is_none")]
    since: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearArgs {
    #[serde(skip_serializing_if = "Option::is_none")]
    signal_id: Option<String>,
}

ops! {
    ListArgs => "signal.list",
    ClearArgs => "signal.clear",
}

/// Read or withdraw this seat's agent signals
#[derive(Args)]
pub struct Signal {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// This seat's signals with the operator's answers, open first
    List {
        /// List every closed signal from here on: an ISO 8601 time or a signal id
        #[arg(long)]
        since: Option<String>,
        #[command(flatten)]
        timeout: Timeout,
    },
    /// Withdraw your own open signal once it no longer applies
    Clear {
        /// Signal id; omit to withdraw every open signal of this seat
        id: Option<String>,
        #[command(flatten)]
        timeout: Timeout,
    },
}

impl Run for Signal {
    fn run(self) -> ExitCode {
        let (name, answer): (&str, Answer) = match self.command {
            Command::List { since, timeout } => ("signal list", wire::call(&ListArgs { since }, timeout.into()).map(Into::into)),
            Command::Clear { id, timeout } => {
                ("signal clear", wire::call(&ClearArgs { signal_id: id }, timeout.into()).map(Into::into))
            }
        };
        envelope::print(name, answer)
    }
}
