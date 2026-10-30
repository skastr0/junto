//! `msg` (src/cli/commands/work.ts): mail between seats. Each request type is
//! its op's schema in src/shared/work-control.ts, keys in the schema's order.

use std::num::NonZeroU64;
use std::process::ExitCode;

use clap::{Args, Subcommand};
use serde::{Deserialize, Serialize};

use super::{Run, Timeout};
use crate::envelope::{self, Answer};
use crate::wire::{self, OpId, Request};
use crate::{batch, input, ops};

/// MailEvidenceRef (src/shared/crew.ts): what a mail points at.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum EvidenceRef {
    Commit {
        sha: String,
    },
    File {
        path: String,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::input::counting"
        )]
        line: Option<NonZeroU64>,
    },
    Task {
        #[serde(rename = "taskId")]
        task_id: String,
    },
    Seat {
        #[serde(rename = "actorRef")]
        actor_ref: String,
    },
    Url {
        url: String,
    },
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListArgs {
    #[serde(skip_serializing_if = "Option::is_none")]
    target: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    task_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    thread_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    from: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    unread: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    since: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    peek: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    limit: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    before: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sent_before: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendArgs {
    target: String,
    text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    task_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    subject: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    refs: Option<Vec<EvidenceRef>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    thread_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    op_id: Option<OpId>,
}

/// A prompt names only what it sends: any other key is refused.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PromptArgs {
    target: String,
    text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    subject: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    refs: Option<Vec<EvidenceRef>>,
}

#[derive(Serialize, Deserialize)]
pub struct SentArgs {
    #[serde(skip_serializing_if = "Option::is_none")]
    target: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadArgs {
    #[serde(skip_serializing_if = "Option::is_none")]
    target: Option<String>,
    message_id: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplyArgs {
    target: String,
    text: String,
    in_reply_to: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    refs: Option<Vec<EvidenceRef>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    op_id: Option<OpId>,
}

#[derive(Serialize, Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
enum Reaction {
    Ack,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReactArgs {
    #[serde(skip_serializing_if = "Option::is_none")]
    target: Option<String>,
    message_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    reaction: Option<Reaction>,
}

ops! {
    ListArgs => "msg.list",
    PromptArgs => "msg.prompt",
    SentArgs => "msg.sent",
    ReadArgs => "msg.read",
    ReactArgs => "msg.react",
}

// A send or reply carries its write id: a timed-out comment sent again is written once.
impl Request for SendArgs {
    const OP: &'static str = "msg.send";
    fn op_id(&self) -> Option<&OpId> {
        self.op_id.as_ref()
    }
}

impl Request for ReplyArgs {
    const OP: &'static str = "msg.reply";
    fn op_id(&self) -> Option<&OpId> {
        self.op_id.as_ref()
    }
}

/// Message ops
#[derive(Args)]
pub struct Msg {
    #[command(subcommand)]
    command: Command,
}

/// Batch flags: the width and the bound of each call.
#[derive(Args, Clone, Copy)]
struct BatchFlags {
    /// Max concurrent mutations (default 5); reject <= 0
    #[arg(long)]
    concurrency: Option<i64>,
    #[command(flatten)]
    timeout: Timeout,
}

#[derive(Subcommand)]
enum Command {
    List {
        input: Option<String>,
        #[command(flatten)]
        timeout: Timeout,
    },
    Send {
        input: String,
        text: Option<String>,
        #[arg(long)]
        prompt: bool,
        #[command(flatten)]
        flags: BatchFlags,
    },
    Sent {
        input: Option<String>,
        #[command(flatten)]
        timeout: Timeout,
    },
    Read {
        input: String,
        #[command(flatten)]
        flags: BatchFlags,
    },
    Reply {
        input: String,
        #[command(flatten)]
        flags: BatchFlags,
    },
    React {
        input: String,
        #[command(flatten)]
        flags: BatchFlags,
    },
}

/// One call of a single item.
fn single<R: Request + for<'de> Deserialize<'de>>(input: Option<&str>, timeout: Timeout) -> Answer {
    let args: R = input::load_or_empty(input)?;
    wire::call(&args, timeout.into()).map(Into::into)
}

impl Run for Msg {
    fn run(self) -> ExitCode {
        let (name, answer) = match self.command {
            Command::List { input, timeout } => {
                ("msg list", single::<ListArgs>(input.as_deref(), timeout))
            }
            Command::Sent { input, timeout } => {
                ("msg sent", single::<SentArgs>(input.as_deref(), timeout))
            }
            Command::Send {
                input,
                text,
                prompt,
                flags,
            } => {
                // `msg send <target> <text>` is shorthand for one JSON item.
                let input = match text {
                    Some(text) => serde_json::json!({ "target": input, "text": text }).to_string(),
                    None => input,
                };
                let BatchFlags {
                    concurrency,
                    timeout,
                } = flags;
                let answer = if prompt {
                    batch::run(&input, concurrency, timeout.into(), |item: PromptArgs| item)
                } else {
                    batch::run(&input, concurrency, timeout.into(), |item: SendArgs| {
                        SendArgs {
                            op_id: item.op_id.clone().or_else(|| Some(OpId::mint())),
                            ..item
                        }
                    })
                };
                ("msg send", answer)
            }
            Command::Read { input, flags } => {
                // A bare message id is shorthand for one item.
                let input = match input.trim_start().chars().next() {
                    Some('[' | '{' | '@' | '-') | None => input,
                    Some(_) => serde_json::json!({ "messageId": input }).to_string(),
                };
                (
                    "msg read",
                    batch::run(
                        &input,
                        flags.concurrency,
                        flags.timeout.into(),
                        |item: ReadArgs| item,
                    ),
                )
            }
            Command::Reply { input, flags } => (
                "msg reply",
                batch::run(
                    &input,
                    flags.concurrency,
                    flags.timeout.into(),
                    |item: ReplyArgs| ReplyArgs {
                        op_id: item.op_id.clone().or_else(|| Some(OpId::mint())),
                        ..item
                    },
                ),
            ),
            Command::React { input, flags } => (
                "msg react",
                batch::run(
                    &input,
                    flags.concurrency,
                    flags.timeout.into(),
                    |item: ReactArgs| item,
                ),
            ),
        };
        envelope::print(name, answer)
    }
}
