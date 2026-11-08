//! `artifact` (src/cli/commands/artifact.ts): the artifacts on the Artifacts
//! nodes in this seat's reach. Writes carry their opId as task's do (minted,
//! or `--op-id`), and create mints the artifact's id. Each request's keys go
//! out in the order artifact.ts builds them, and each request type is its
//! op's schema in src/shared/artifact-control.ts, which refuses any key it
//! does not name.

use std::marker::PhantomData;
use std::process::ExitCode;

use clap::{Args, Subcommand, ValueEnum};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{Run, Timeout};
use crate::envelope::{self, Answer};
use crate::error::{Failure, Result};
use crate::ops;
use crate::wire::{self, OpId, Request};

/// ArtifactType (src/shared/wire/artifact.ts).
#[derive(Debug, Clone, Copy, ValueEnum, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Type {
    Link,
    Document,
    Pad,
    Sheet,
    File,
}

/// ARTIFACT_LABEL_COLOURS (src/shared/wire/artifact-labels.ts), or none to unset.
#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Colour {
    Red,
    Orange,
    Yellow,
    Green,
    Teal,
    Blue,
    Purple,
    Pink,
    None,
}

// --- reads -------------------------------------------------------------------

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ListArgs {
    #[serde(skip_serializing_if = "Option::is_none")]
    node: Option<String>,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    kind: Option<Type>,
    #[serde(skip_serializing_if = "Option::is_none")]
    limit: Option<i64>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    archived: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    labels: Vec<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ShowArgs {
    artifact: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<i64>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct HistoryArgs {
    artifact: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    limit: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    before: Option<i64>,
}

ops! {
    ListArgs => "artifact.list",
    ShowArgs => "artifact.show",
    HistoryArgs => "artifact.history",
}

// --- writes ------------------------------------------------------------------

/// BodyInput: a document's markdown, a link's address, or any type's body as JSON.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Body {
    Markdown(String),
    Url(String),
    #[serde(rename = "body")]
    Json(Value),
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateArgs {
    op_id: OpId,
    artifact_id: String,
    #[serde(rename = "type")]
    kind: Type,
    title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    node: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    body: Option<Body>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    task_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    labels: Vec<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EditArgs {
    op_id: OpId,
    artifact: String,
    base_version: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    body: Option<Body>,
    #[serde(skip_serializing_if = "Option::is_none")]
    patches: Option<Value>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LabelArgs {
    op_id: OpId,
    artifact: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    set: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    add: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    remove: Option<Vec<String>>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ColourArgs {
    op_id: OpId,
    label: String,
    /// null unsets it, and it is never left out.
    #[serde(deserialize_with = "Option::deserialize")]
    colour: Option<Colour>,
    #[serde(skip_serializing_if = "Option::is_none")]
    node: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CommentArgs {
    op_id: OpId,
    artifact: String,
    text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    anchor: Option<Value>,
}

/// archive and restore name one artifact.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct One<M> {
    op_id: OpId,
    artifact: String,
    #[serde(skip)]
    op: PhantomData<M>,
}

/// Names the op of each verb that shares a shape with another.
trait Op {
    const OP: &'static str;
}

struct Archive;
struct Restore;

impl Op for Archive {
    const OP: &'static str = "artifact.archive";
}
impl Op for Restore {
    const OP: &'static str = "artifact.restore";
}

impl<M: Op> Request for One<M> {
    const OP: &'static str = M::OP;
    fn op_id(&self) -> Option<&OpId> {
        Some(&self.op_id)
    }
}

/// A write names its op and carries its opId, so a failed send names it.
macro_rules! writes {
    ($($ty:ty => $op:literal),+ $(,)?) => {
        $(impl Request for $ty {
            const OP: &'static str = $op;
            fn op_id(&self) -> Option<&OpId> {
                Some(&self.op_id)
            }
        })+
    };
}

writes! {
    CreateArgs => "artifact.create",
    EditArgs => "artifact.edit",
    LabelArgs => "artifact.label",
    ColourArgs => "artifact.colour",
    CommentArgs => "artifact.comment",
}

#[cfg(test)]
mod contract {
    crate::contract::parity! {
        list: super::ListArgs => "artifact.list",
        show: super::ShowArgs => "artifact.show",
        history: super::HistoryArgs => "artifact.history",
        create: super::CreateArgs => "artifact.create",
        edit: super::EditArgs => "artifact.edit",
        label: super::LabelArgs => "artifact.label",
        colour: super::ColourArgs => "artifact.colour",
        // An anchor is taken as given and checked in main, against the artifact's type.
        comment: super::CommentArgs => "artifact.comment" as given ["anchor"],
        archive: super::One<super::Archive> => "artifact.archive",
        restore: super::One<super::Restore> => "artifact.restore",
    }
}

// --- the command line --------------------------------------------------------

/// Artifacts in this seat's reach: links, documents, pads, sheets and files, versioned
#[derive(Args)]
pub struct Artifact {
    #[command(subcommand)]
    command: Command,
}

/// At most one of --markdown, --url and --body.
#[derive(Args)]
struct BodyFlags {
    #[arg(long, allow_hyphen_values = true)]
    markdown: Option<String>,
    #[arg(long)]
    url: Option<String>,
    #[arg(long, allow_hyphen_values = true)]
    body: Option<String>,
}

/// What every write takes: the opId to resend under, and the call's bound.
#[derive(Args)]
struct WriteFlags {
    #[arg(long = "op-id")]
    op_id: Option<String>,
    #[command(flatten)]
    timeout: Timeout,
}

#[derive(Args)]
struct OneArtifact {
    artifact: String,
    #[command(flatten)]
    flags: WriteFlags,
}

#[derive(Subcommand)]
enum Command {
    List {
        #[arg(long)]
        node: Option<String>,
        #[arg(long = "type", value_enum)]
        kind: Option<Type>,
        #[arg(long)]
        archived: bool,
        #[arg(long)]
        label: Vec<String>,
        #[arg(long, allow_negative_numbers = true)]
        limit: Option<i64>,
        #[command(flatten)]
        timeout: Timeout,
    },
    Show {
        artifact: String,
        #[arg(long, allow_negative_numbers = true)]
        version: Option<i64>,
        #[command(flatten)]
        timeout: Timeout,
    },
    History {
        artifact: String,
        #[arg(long, allow_negative_numbers = true)]
        limit: Option<i64>,
        #[arg(long, allow_negative_numbers = true)]
        before: Option<i64>,
        #[command(flatten)]
        timeout: Timeout,
    },
    Create {
        title: String,
        #[arg(long = "type", value_enum)]
        kind: Type,
        #[arg(long)]
        node: Option<String>,
        #[arg(long)]
        task: Vec<String>,
        #[arg(long)]
        label: Vec<String>,
        #[command(flatten)]
        body: BodyFlags,
        #[command(flatten)]
        flags: WriteFlags,
    },
    Edit {
        artifact: String,
        #[arg(long, allow_negative_numbers = true)]
        base: i64,
        #[command(flatten)]
        body: BodyFlags,
        #[arg(long)]
        patch: Option<String>,
        #[command(flatten)]
        flags: WriteFlags,
    },
    Label {
        artifact: String,
        #[arg(long, allow_hyphen_values = true)]
        set: Vec<String>,
        #[arg(long)]
        add: Vec<String>,
        #[arg(long)]
        remove: Vec<String>,
        #[command(flatten)]
        flags: WriteFlags,
    },
    Colour {
        label: String,
        #[arg(value_enum)]
        colour: Colour,
        #[arg(long)]
        node: Option<String>,
        #[command(flatten)]
        flags: WriteFlags,
    },
    Comment {
        artifact: String,
        text: String,
        #[arg(long)]
        anchor: Option<String>,
        #[command(flatten)]
        flags: WriteFlags,
    },
    Archive(OneArtifact),
    Restore(OneArtifact),
}

// --- running -------------------------------------------------------------------

fn read<R: Request>(args: &R, timeout: Timeout) -> Answer {
    wire::call(args, timeout.into()).map(Into::into)
}

/// The opId to send under: the one --op-id names, or a fresh one.
fn op_id(given: Option<&str>) -> Result<OpId> {
    match given {
        None => Ok(OpId::mint()),
        Some(text) => serde_json::from_value(Value::from(text.trim())).map_err(|_| {
            Failure::input("--op-id must be the ULID a write returned", "--op-id")
                .and("received", text)
        }),
    }
}

/// A write: its args, made with the opId it carries.
fn write<A: Request>(flags: WriteFlags, args: impl FnOnce(OpId) -> A) -> Answer {
    let args = args(op_id(flags.op_id.as_deref())?);
    wire::call(&args, flags.timeout.into()).map(Into::into)
}

/// A flag's JSON, or the input error that names the flag.
fn json(flag: &str, text: &str) -> Result<Value> {
    serde_json::from_str(text).map_err(|_| {
        Failure::input(format!("--{flag} must be JSON"), format!("--{flag}")).and("received", text)
    })
}

/// Each value split on commas and trimmed. An empty entry stays, so main
/// refuses it by name; only `whole_set` reads an empty flag as none.
fn labels(given: &[String]) -> Vec<String> {
    given
        .iter()
        .flat_map(|one| one.split(','))
        .map(|one| one.trim().to_string())
        .collect()
}

/// `--set` names the whole set, and `--set ''` clears it; None when left out.
fn whole_set(given: &[String]) -> Option<Vec<String>> {
    (!given.is_empty()).then(|| {
        let set = labels(given);
        if set.iter().all(String::is_empty) {
            Vec::new()
        } else {
            set
        }
    })
}

/// A label flag as the args carry it: left out when not given.
fn named(given: &[String]) -> Option<Vec<String>> {
    (!given.is_empty()).then(|| labels(given))
}

/// At most one of --markdown, --url and --body, as main's BodyInput.
fn body(
    BodyFlags {
        markdown,
        url,
        body,
    }: BodyFlags,
) -> Result<Option<Body>> {
    match (markdown, url, body) {
        (None, None, None) => Ok(None),
        (Some(markdown), None, None) => Ok(Some(Body::Markdown(markdown))),
        (None, Some(url), None) => Ok(Some(Body::Url(url))),
        (None, None, Some(body)) => json("body", &body).map(|body| Some(Body::Json(body))),
        _ => Err(Failure::input(
            "name one of --markdown, --url and --body",
            "--body",
        )),
    }
}

impl Run for Artifact {
    fn run(self) -> ExitCode {
        let (name, answer) = match self.command {
            Command::List {
                node,
                kind,
                archived,
                label,
                limit,
                timeout,
            } => (
                "artifact list",
                read(
                    &ListArgs {
                        node,
                        kind,
                        limit,
                        archived,
                        labels: labels(&label),
                    },
                    timeout,
                ),
            ),
            Command::Show {
                artifact,
                version,
                timeout,
            } => (
                "artifact show",
                read(&ShowArgs { artifact, version }, timeout),
            ),
            Command::History {
                artifact,
                limit,
                before,
                timeout,
            } => (
                "artifact history",
                read(
                    &HistoryArgs {
                        artifact,
                        limit,
                        before,
                    },
                    timeout,
                ),
            ),
            Command::Create {
                title,
                kind,
                node,
                task,
                label,
                body: given,
                flags,
            } => {
                let create = body(given).and_then(|body| {
                    write(flags, |op_id| CreateArgs {
                        op_id,
                        artifact_id: ulid::Ulid::new().to_string(),
                        kind,
                        title,
                        node,
                        body,
                        task_ids: task,
                        labels: labels(&label),
                    })
                });
                ("artifact create", create)
            }
            Command::Edit {
                artifact,
                base,
                body: given,
                patch,
                flags,
            } => {
                let edit = body(given).and_then(|body| {
                    let patches = patch
                        .as_deref()
                        .map(|patch| json("patch", patch))
                        .transpose()?;
                    write(flags, |op_id| EditArgs {
                        op_id,
                        artifact,
                        base_version: base,
                        body,
                        patches,
                    })
                });
                ("artifact edit", edit)
            }
            Command::Label {
                artifact,
                set,
                add,
                remove,
                flags,
            } => {
                let label = write(flags, |op_id| LabelArgs {
                    op_id,
                    artifact,
                    set: whole_set(&set),
                    add: named(&add),
                    remove: named(&remove),
                });
                ("artifact label", label)
            }
            Command::Colour {
                label,
                colour,
                node,
                flags,
            } => {
                let colour = (colour != Colour::None).then_some(colour);
                (
                    "artifact colour",
                    write(flags, |op_id| ColourArgs {
                        op_id,
                        label,
                        colour,
                        node,
                    }),
                )
            }
            Command::Comment {
                artifact,
                text,
                anchor,
                flags,
            } => {
                let comment = anchor
                    .as_deref()
                    .map(|anchor| json("anchor", anchor))
                    .transpose()
                    .and_then(|anchor| {
                        write(flags, |op_id| CommentArgs {
                            op_id,
                            artifact,
                            text,
                            anchor,
                        })
                    });
                ("artifact comment", comment)
            }
            Command::Archive(OneArtifact { artifact, flags }) => (
                "artifact archive",
                write(flags, |op_id| One::<Archive> {
                    op_id,
                    artifact,
                    op: PhantomData,
                }),
            ),
            Command::Restore(OneArtifact { artifact, flags }) => (
                "artifact restore",
                write(flags, |op_id| One::<Restore> {
                    op_id,
                    artifact,
                    op: PhantomData,
                }),
            ),
        };
        envelope::print(name, answer)
    }
}
