//! `artifact` (src/cli/commands/artifact.ts): the artifacts on the Artifacts
//! nodes in this seat's reach. Writes carry their opId as task's do (minted,
//! or `--op-id`), and create mints the artifact's id. Each request's keys go
//! out in the order artifact.ts builds them.

use std::marker::PhantomData;
use std::process::ExitCode;

use clap::{Args, Subcommand, ValueEnum};
use serde::Serialize;
use serde_json::Value;

use super::task::{Verb, WriteFlags, read, write};
use super::{Run, Timeout};
use crate::envelope;
use crate::error::{Failure, Result};
use crate::ops;

/// ArtifactType (src/shared/wire/artifact.ts).
#[derive(Debug, Clone, Copy, ValueEnum, Serialize)]
#[serde(rename_all = "lowercase")]
enum Type {
    Link,
    Document,
    Pad,
    Sheet,
    File,
}

/// ARTIFACT_LABEL_COLOURS (src/shared/wire/artifact-labels.ts), or none to unset.
#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum, Serialize)]
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

#[derive(Serialize)]
struct ListArgs {
    #[serde(skip_serializing_if = "Option::is_none")]
    node: Option<String>,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    kind: Option<Type>,
    #[serde(skip_serializing_if = "Option::is_none")]
    limit: Option<i64>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    archived: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    labels: Vec<String>,
}

#[derive(Serialize)]
struct ShowArgs {
    artifact: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<i64>,
}

#[derive(Serialize)]
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
#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
enum Body {
    Markdown(String),
    Url(String),
    #[serde(rename = "body")]
    Json(Value),
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CreateArgs {
    artifact_id: String,
    #[serde(rename = "type")]
    kind: Type,
    title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    node: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    body: Option<Body>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    task_ids: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    labels: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EditArgs {
    artifact: String,
    base_version: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    body: Option<Body>,
    #[serde(skip_serializing_if = "Option::is_none")]
    patches: Option<Value>,
}

#[derive(Serialize)]
struct LabelArgs {
    artifact: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    set: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    add: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    remove: Option<Vec<String>>,
}

#[derive(Serialize)]
struct ColourArgs {
    label: String,
    /// null unsets it.
    colour: Option<Colour>,
    #[serde(skip_serializing_if = "Option::is_none")]
    node: Option<String>,
}

#[derive(Serialize)]
struct CommentArgs {
    artifact: String,
    text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    anchor: Option<Value>,
}

/// archive and restore name one artifact.
#[derive(Serialize)]
struct One<M> {
    artifact: String,
    #[serde(skip)]
    op: PhantomData<M>,
}

struct Archive;
struct Restore;

impl Verb for One<Archive> {
    const OP: &'static str = "artifact.archive";
}
impl Verb for One<Restore> {
    const OP: &'static str = "artifact.restore";
}

macro_rules! verbs {
    ($($ty:ty => $op:literal),+ $(,)?) => {
        $(impl Verb for $ty { const OP: &'static str = $op; })+
    };
}

verbs! {
    CreateArgs => "artifact.create",
    EditArgs => "artifact.edit",
    LabelArgs => "artifact.label",
    ColourArgs => "artifact.colour",
    CommentArgs => "artifact.comment",
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
                let create = body(given).map(|body| CreateArgs {
                    artifact_id: ulid::Ulid::new().to_string(),
                    kind,
                    title,
                    node,
                    body,
                    task_ids: task,
                    labels: labels(&label),
                });
                (
                    "artifact create",
                    create.and_then(|create| write(flags, create)),
                )
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
                    Ok(EditArgs {
                        artifact,
                        base_version: base,
                        body,
                        patches,
                    })
                });
                ("artifact edit", edit.and_then(|edit| write(flags, edit)))
            }
            Command::Label {
                artifact,
                set,
                add,
                remove,
                flags,
            } => {
                let label = LabelArgs {
                    artifact,
                    set: whole_set(&set),
                    add: named(&add),
                    remove: named(&remove),
                };
                ("artifact label", write(flags, label))
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
                    write(
                        flags,
                        ColourArgs {
                            label,
                            colour,
                            node,
                        },
                    ),
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
                    .map(|anchor| CommentArgs {
                        artifact,
                        text,
                        anchor,
                    });
                (
                    "artifact comment",
                    comment.and_then(|comment| write(flags, comment)),
                )
            }
            Command::Archive(OneArtifact { artifact, flags }) => (
                "artifact archive",
                write(
                    flags,
                    One::<Archive> {
                        artifact,
                        op: PhantomData,
                    },
                ),
            ),
            Command::Restore(OneArtifact { artifact, flags }) => (
                "artifact restore",
                write(
                    flags,
                    One::<Restore> {
                        artifact,
                        op: PhantomData,
                    },
                ),
            ),
        };
        envelope::print(name, answer)
    }
}
