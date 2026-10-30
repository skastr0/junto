//! The root commands, one module per TypeScript command file
//! (src/cli/commands/*.ts). Each root command is a clap `Args` type that
//! knows how to run itself; a family's subcommands live in its own module.

use std::process::ExitCode;

use clap::{Args, Subcommand};

pub mod artifact;
pub mod authority;
pub mod automation;
pub mod browser;
pub mod discovery;
pub mod docs;
pub mod env;
pub mod logs;
pub mod machine;
pub mod msg;
pub mod op;
pub mod overseer;
pub mod pipes;
pub mod references;
pub mod seat;
pub mod seat_discovery;
pub mod signals;
pub mod task;
pub mod work;

/// A command that runs and prints its own envelope.
pub trait Run {
    fn run(self) -> ExitCode;
}

/// Shared flags: the socket call's bound, and a batch's width.
#[derive(Args, Debug, Clone, Copy, Default)]
pub struct Timeout {
    /// Socket call timeout in ms (default 30000)
    #[arg(long = "timeout")]
    pub ms: Option<i64>,
}

impl From<Timeout> for crate::wire::Timeout {
    fn from(t: Timeout) -> Self {
        t.ms.into()
    }
}

#[derive(Subcommand)]
pub enum Root {
    Machine(machine::Machine),
    Ping(seat_discovery::Ping),
    Doctor(seat_discovery::Doctor),
    Capabilities(seat_discovery::Capabilities),
    Onboard(seat_discovery::Onboard),
    Since(seat_discovery::Since),
    Offboard(seat_discovery::Offboard),
    Schema(discovery::Schema),
    Examples(discovery::Examples),
    Preamble(work::Preamble),
    Escalate(signals::Escalate),
    Blocked(signals::Blocked),
    Feedback(signals::Feedback),
    Signal(signals::Signal),
    Task(task::Task),
    Rulings(work::Rulings),
    Msg(msg::Msg),
    Seat(seat::Seat),
    Env(env::Env),
    Logs(logs::Logs),
    References(references::References),
    Docs(docs::Docs),
    Artifact(artifact::Artifact),
    Overseer(overseer::Overseer),
    Automation(automation::Automation),
    Op(op::Op),
    Authority(authority::Authority),
    Browser(browser::Browser),
}

impl Run for Root {
    fn run(self) -> ExitCode {
        match self {
            Root::Machine(c) => c.run(),
            Root::Ping(c) => c.run(),
            Root::Doctor(c) => c.run(),
            Root::Capabilities(c) => c.run(),
            Root::Onboard(c) => c.run(),
            Root::Since(c) => c.run(),
            Root::Offboard(c) => c.run(),
            Root::Schema(c) => c.run(),
            Root::Examples(c) => c.run(),
            Root::Preamble(c) => c.run(),
            Root::Escalate(c) => c.run(),
            Root::Blocked(c) => c.run(),
            Root::Feedback(c) => c.run(),
            Root::Signal(c) => c.run(),
            Root::Task(c) => c.run(),
            Root::Rulings(c) => c.run(),
            Root::Msg(c) => c.run(),
            Root::Seat(c) => c.run(),
            Root::Env(c) => c.run(),
            Root::Logs(c) => c.run(),
            Root::References(c) => c.run(),
            Root::Docs(c) => c.run(),
            Root::Artifact(c) => c.run(),
            Root::Overseer(c) => c.run(),
            Root::Automation(c) => c.run(),
            Root::Op(c) => c.run(),
            Root::Authority(c) => c.run(),
            Root::Browser(c) => c.run(),
        }
    }
}
