//! escalate, blocked, feedback and `signal`:
//! how a seat raises its hand to the operator. No edge or port is needed; a
//! seat can only speak for itself.

use std::process::ExitCode;

use clap::{Args, Subcommand};
use serde::{Deserialize, Serialize};

use super::{Run, Timeout};
use crate::attach::signal_input::{self, Order, Raise};
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
    /// Raise it in a thread you have with the operator: the thread id or the id of any mail in it. The signal is also your next mail there
    #[arg(long)]
    thread: Option<String>,
    /// A signal of yours this one comes after, by id: the operator meets that one first. Repeat for each
    #[arg(long = "depends-on")]
    depends_on: Vec<String>,
    /// Comes after the signal you raised last on this canvas; after nothing when you raised none
    #[arg(long = "depends-on-last")]
    depends_on_last: bool,
    #[command(flatten)]
    attach: signal_attach::AttachFlags,
    #[command(flatten)]
    timeout: Timeout,
}

impl Common {
    fn raise(self, kind: Kind, form: &signal_form::FormFlags) -> ExitCode {
        let order = Order {
            thread: self.thread,
            depends_on: self.depends_on,
            depends_on_last: self.depends_on_last,
        };
        let raise = Raise {
            kind,
            input: &self.input,
            detail: self.detail.as_deref(),
            suggest: &self.suggest,
            attach: &self.attach,
            form,
            order: &order,
            timeout: self.timeout.into(),
        };
        let answer = signal_input::load(raise)
            .and_then(|args| wire::call(&args, self.timeout.into()))
            .map(Into::into);
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
        self.common
            .raise(Kind::Feedback, &signal_form::FormFlags::default())
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ListArgs {
    #[serde(skip_serializing_if = "Option::is_none")]
    since: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClearArgs {
    #[serde(skip_serializing_if = "Option::is_none")]
    signal_id: Option<String>,
}

ops! {
    ListArgs => "signal.list",
    ClearArgs => "signal.clear",
}

#[cfg(test)]
mod contract {
    crate::contract::parity! {
        list: super::ListArgs => "signal.list",
        clear: super::ClearArgs => "signal.clear",
    }
}

/// Read, raise in order, or withdraw this seat's agent signals
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
    /// Raise several signals in the order to act, all or none: a JSON list of {kind, text, detail, suggest, form, attach, thread, dependsOn}
    Batch {
        /// A JSON list of signals, or {"signals": [...]}: inline, @file, or - for stdin. Each comes after the one before it unless its dependsOn names earlier items by position from 1 or your own signal ids; [] is after nothing
        #[arg(allow_hyphen_values = true)]
        input: String,
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
            Command::List { since, timeout } => (
                "signal list",
                wire::call(&ListArgs { since }, timeout.into()).map(Into::into),
            ),
            Command::Batch { input, timeout } => (
                "signal batch",
                signal_input::load_batch(&input, timeout.into())
                    .and_then(|args| wire::call(&args, timeout.into()))
                    .map(Into::into),
            ),
            Command::Clear { id, timeout } => (
                "signal clear",
                wire::call(&ClearArgs { signal_id: id }, timeout.into()).map(Into::into),
            ),
        };
        envelope::print(name, answer)
    }
}
