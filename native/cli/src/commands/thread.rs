//! `thread`: a seat's threads with the
//! operator. No --seat is the caller's own; --seat a connected seat's, on
//! port threads.read. Reading marks nothing read.

use std::process::ExitCode;

use clap::{Args, Subcommand, ValueEnum};
use serde::{Deserialize, Serialize};

use super::{Run, Timeout};
use crate::{envelope, ops, wire};

/// THREAD_GROUPS (src/shared/mail-threads.ts).
#[derive(Clone, Copy, ValueEnum, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Group {
    WithYou,
    Between,
}

/// ThreadListArgs (src/shared/thread-control.ts).
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ListArgs {
    #[serde(skip_serializing_if = "Option::is_none")]
    seat: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    limit: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    after: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    group: Option<Group>,
}

/// ThreadShowArgs (src/shared/thread-control.ts).
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShowArgs {
    thread_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    seat: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    limit: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    before: Option<String>,
}

ops! {
    ListArgs => "thread.list",
    ShowArgs => "thread.show",
}

#[cfg(test)]
mod contract {
    crate::contract::parity! {
        list: super::ListArgs => "thread.list",
        show: super::ShowArgs => "thread.show",
    }
}

/// Your threads, or a connected seat's
#[derive(Args)]
pub struct Thread {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// List a seat's threads, newest activity first
    List {
        /// A connected seat, by name or node id; absent, your own threads
        #[arg(long)]
        seat: Option<String>,
        /// Threads in the page (default 50, max 200)
        #[arg(long)]
        limit: Option<i64>,
        /// The next cursor a previous page answered
        #[arg(long)]
        after: Option<String>,
        /// One list alone: with-you (the operator is in it) or between (seats only)
        #[arg(long, value_enum)]
        group: Option<Group>,
        #[command(flatten)]
        timeout: Timeout,
    },
    /// Read one thread's messages, oldest first in the page
    Show {
        /// Thread id, as junto thread list prints it
        thread_id: String,
        /// A connected seat, by name or node id; absent, your own threads
        #[arg(long)]
        seat: Option<String>,
        /// Messages in the page (default 50, max 200)
        #[arg(long)]
        limit: Option<i64>,
        /// The older cursor a previous page answered
        #[arg(long)]
        before: Option<String>,
        #[command(flatten)]
        timeout: Timeout,
    },
}

impl Run for Thread {
    fn run(self) -> ExitCode {
        match self.command {
            Command::List {
                seat,
                limit,
                after,
                group,
                timeout,
            } => envelope::print(
                "thread list",
                wire::call(
                    &ListArgs {
                        seat,
                        limit,
                        after,
                        group,
                    },
                    timeout.into(),
                )
                .map(Into::into),
            ),
            Command::Show {
                thread_id,
                seat,
                limit,
                before,
                timeout,
            } => envelope::print(
                "thread show",
                wire::call(
                    &ShowArgs {
                        thread_id,
                        seat,
                        limit,
                        before,
                    },
                    timeout.into(),
                )
                .map(Into::into),
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lowers_the_flags_to_the_wire_names() {
        let list = ListArgs {
            seat: Some("planner".into()),
            limit: Some(5),
            after: None,
            group: Some(Group::WithYou),
        };
        assert_eq!(
            serde_json::to_string(&list).ok().as_deref(),
            Some(r#"{"seat":"planner","limit":5,"group":"with-you"}"#)
        );
        let show = ShowArgs {
            thread_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV".into(),
            seat: None,
            limit: None,
            before: Some("1.x".into()),
        };
        assert_eq!(
            serde_json::to_string(&show).ok().as_deref(),
            Some(r#"{"threadId":"01ARZ3NDEKTSV4RRFFQ69G5FAV","before":"1.x"}"#)
        );
    }
}
