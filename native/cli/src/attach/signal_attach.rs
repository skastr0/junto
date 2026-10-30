//! What an agent attaches to a signal (src/cli/core/signal-attach.ts): one
//! flag per kind, each repeatable, or the same things as objects in the JSON
//! input's `attach` list.
//!
//! ```text
//! --attach   [Caption=]<path>                      any file
//! --code     [Caption=]<language>:<text|@file|->   a code block
//! --diff     [Caption=]<unified diff|@file|->      a diff, no repository needed
//! --compare  [Caption=]<before path>,<after path>  two files read as a change
//! --commit   [Caption=]<rev>                       a commit in this folder
//! --video    [Caption=]<http or https address>     a video somewhere else
//! --task     [Caption=]<ref|#42|id>                a task in this seat's reach
//! --artifact [Caption=]<ref|id>                    an artifact in this seat's reach
//! ```
//!
//! One caption rule for every flag: the whole value is tried first, and if it
//! is valid as written there is no caption. Otherwise the text before the
//! first `=` is the caption, when it has no `=`, `:` or line break and what
//! follows is valid. Everything made of bytes is uploaded before the signal
//! is raised, and nothing is uploaded unless every item passes its check: a
//! path never crosses the socket. Main is the authority; these checks only
//! fail fast.

use std::path::Path;
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};

use super::content_stage::{self, Identity, Label};
use super::media;
use crate::error::{Failure, Result};
use crate::wire::Timeout;

/// Where a text comes from: typed inline, a file, or stdin.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Text {
    Inline(String),
    File(String),
    Stdin,
}

/// One thing to attach, as planned from a flag or a JSON item.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Plan {
    File {
        path: String,
    },
    Code {
        language: String,
        text: Text,
    },
    Diff {
        text: Text,
    },
    Compare {
        before: Text,
        after: Text,
        language: Option<String>,
    },
    Commit {
        rev: String,
    },
    Video {
        url: String,
    },
    Task {
        reference: String,
    },
    Artifact {
        reference: String,
    },
}

/// A plan and the caption it is shown under.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Captioned {
    pub plan: Plan,
    pub caption: Option<String>,
}

/// The attachment flags, in the order they come on the card.
#[derive(Debug, Default, Clone, clap::Args)]
pub struct AttachFlags {
    /// A file to show the operator, of any kind and size: /path or "Caption=/path"
    #[arg(long, allow_hyphen_values = true)]
    pub attach: Vec<String>,
    /// A code block: "ts:const a = 1", where the text may be @file or - for stdin
    #[arg(long, allow_hyphen_values = true)]
    pub code: Vec<String>,
    /// A diff, no repository needed: unified diff text, @file, or - for stdin
    #[arg(long, allow_hyphen_values = true)]
    pub diff: Vec<String>,
    /// Two files read as a change: "before.ts,after.ts"
    #[arg(long, allow_hyphen_values = true)]
    pub compare: Vec<String>,
    /// A commit in this folder: HEAD, a branch, or an id, as "The fix=HEAD"
    #[arg(long, allow_hyphen_values = true)]
    pub commit: Vec<String>,
    /// A video at a web address: "https://host/run.mp4"
    #[arg(long, allow_hyphen_values = true)]
    pub video: Vec<String>,
    /// A task in your reach: its junto:// ref, #42, or its id, as "Stamp this=#42"
    #[arg(long, allow_hyphen_values = true)]
    pub task: Vec<String>,
    /// An artifact in your reach: its junto:// ref or its id, as "The spec=<ref>"
    #[arg(long, allow_hyphen_values = true)]
    pub artifact: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Flag {
    Attach,
    Code,
    Diff,
    Compare,
    Commit,
    Video,
    Task,
    Artifact,
}

impl Flag {
    fn name(self) -> &'static str {
        match self {
            Flag::Attach => "attach",
            Flag::Code => "code",
            Flag::Diff => "diff",
            Flag::Compare => "compare",
            Flag::Commit => "commit",
            Flag::Video => "video",
            Flag::Task => "task",
            Flag::Artifact => "artifact",
        }
    }

    /// FLAG_HELP: what a valid value looks like, and one.
    fn help(self) -> (&'static str, &'static str) {
        match self {
            Flag::Attach => (
                "a path to a file that exists",
                r#"--attach "Before=/abs/before.png""#,
            ),
            Flag::Code => (
                "<language>:<text>, where the text may be @file (a file that exists) or - for stdin",
                r#"--code "The guard=ts:if (!user) return;""#,
            ),
            Flag::Diff => (
                "unified diff text (it starts with diff, ---, Index: or @@), @file (a file that exists), or - for stdin",
                r#"git diff | junto feedback "..." --diff "What changed=-""#,
            ),
            Flag::Compare => (
                "<before path>,<after path>, two files that exist",
                r#"--compare "The limit=old.ts,new.ts""#,
            ),
            Flag::Commit => (
                "a commit in this folder: HEAD, a branch, or an id",
                r#"--commit "The fix=HEAD""#,
            ),
            Flag::Video => (
                "an address that starts with http:// or https://",
                r#"--video "The run=https://host/run.mp4""#,
            ),
            Flag::Task => (
                "a task: its junto:// ref, #42, or its id",
                r##"--task "Stamp this=#42""##,
            ),
            Flag::Artifact => (
                "an artifact: its junto:// ref or its id",
                r#"--artifact "The spec=junto://canvas/<canvas>?node=<id>&item=<id>""#,
            ),
        }
    }

    fn of(plan: &Plan) -> Flag {
        match plan {
            Plan::File { .. } => Flag::Attach,
            Plan::Code { .. } => Flag::Code,
            Plan::Diff { .. } => Flag::Diff,
            Plan::Compare { .. } => Flag::Compare,
            Plan::Commit { .. } => Flag::Commit,
            Plan::Video { .. } => Flag::Video,
            Plan::Task { .. } => Flag::Task,
            Plan::Artifact { .. } => Flag::Artifact,
        }
    }
}

impl AttachFlags {
    /// Each flag with its values, in card order.
    fn each(&self) -> [(Flag, &[String]); 8] {
        [
            (Flag::Attach, self.attach.as_slice()),
            (Flag::Code, self.code.as_slice()),
            (Flag::Diff, self.diff.as_slice()),
            (Flag::Compare, self.compare.as_slice()),
            (Flag::Commit, self.commit.as_slice()),
            (Flag::Video, self.video.as_slice()),
            (Flag::Task, self.task.as_slice()),
            (Flag::Artifact, self.artifact.as_slice()),
        ]
    }

    /// The first flag given, as `--name`, when any is.
    pub fn first_given(&self) -> Option<String> {
        self.each()
            .into_iter()
            .find(|(_, values)| !values.is_empty())
            .map(|(flag, _)| format!("--{}", flag.name()))
    }
}

/// What the checks ask of the machine, so the parsing itself stays pure.
pub trait Probe {
    fn is_file(&self, path: &str) -> bool;
    /// A rev as a full commit id in the working folder.
    fn resolve_commit(&self, rev: &str) -> Option<String>;
}

/// The machine itself: the file system, and git in the working folder.
pub struct Live;

fn is_full_sha(text: &str) -> bool {
    text.len() == 40 && text.bytes().all(|b| b.is_ascii_hexdigit())
}

impl Probe for Live {
    fn is_file(&self, path: &str) -> bool {
        // metadata follows a link: what matters is that a regular file is read.
        std::fs::metadata(path).is_ok_and(|m| m.is_file())
    }

    fn resolve_commit(&self, rev: &str) -> Option<String> {
        if rev.trim().is_empty() || rev.chars().any(char::is_whitespace) || rev.starts_with('-') {
            return None;
        }
        let sha = Command::new("git")
            .args([
                "rev-parse",
                "--verify",
                "--quiet",
                &format!("{rev}^{{commit}}"),
                "--",
            ])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .ok()
            .filter(|run| run.status.success())
            .map(|run| String::from_utf8_lossy(&run.stdout).trim().to_lowercase())
            .filter(|sha| is_full_sha(sha));
        // Outside a git folder only a full id is taken as written.
        sha.or_else(|| is_full_sha(rev).then(|| rev.to_lowercase()))
    }
}

/// A value as an error repeats it: whole when it is one line, else its first line.
fn shown(value: &str) -> String {
    let line = value.split('\n').next().unwrap_or_default();
    if line.len() < value.len() || line.chars().count() > 400 {
        format!("{}…", line.chars().take(400).collect::<String>())
    } else {
        line.to_string()
    }
}

fn flag_error(flag: Flag, value: &str, why: Option<&str>) -> Failure {
    let (looks, example) = flag.help();
    let why = why.map_or_else(
        || format!("\"{}\" is not {looks}", shown(value)),
        str::to_string,
    );
    Failure::input(
        format!("--{}: {why}", flag.name()),
        format!("--{}", flag.name()),
    )
    .and(
        "hint",
        format!("a valid value is {looks}, for example {example}"),
    )
}

/// splitCaption: `[Caption=]value` by the one caption rule, or none when
/// neither the whole value nor what follows a caption is valid.
pub fn split_caption(
    raw: &str,
    is_value: impl Fn(&str) -> bool,
) -> Option<(String, Option<String>)> {
    if is_value(raw) {
        return Some((raw.to_string(), None));
    }
    let (caption, value) = raw
        .split_once('=')
        .filter(|(caption, _)| !caption.is_empty())?;
    let caption = caption.trim();
    if caption.is_empty() || caption.contains([':', '\n', '\r']) {
        return None;
    }
    let caption = Some(caption.to_string());
    if is_value(value) {
        Some((value.to_string(), caption))
    } else {
        is_value(value.trim()).then(|| (value.trim().to_string(), caption))
    }
}

/// `@path` names a file only when that file exists: code may well start with `@`.
fn file_named(raw: &str, probe: &impl Probe) -> Option<String> {
    let trimmed = raw.trim();
    let path = trimmed
        .strip_prefix('@')
        .filter(|p| !p.is_empty() && !trimmed.contains('\n'))?;
    probe.is_file(path).then(|| path.to_string())
}

fn text_of(raw: &str, probe: &impl Probe) -> Text {
    match raw.trim() {
        "-" | "@-" => Text::Stdin,
        _ => file_named(raw, probe).map_or_else(|| Text::Inline(raw.to_string()), Text::File),
    }
}

/// CODE_VALUE: `<language>:<text>`, the language 1 to 32 of `A-Za-z0-9.+#_-`.
fn code_value(value: &str) -> Option<(&str, &str)> {
    let (language, text) = value.split_once(':')?;
    let language_ok = (1..=32).contains(&language.len())
        && language
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b".+#_-".contains(&b));
    (language_ok && !text.is_empty()).then_some((language, text))
}

fn is_diff_value(value: &str, probe: &impl Probe) -> bool {
    let start = value.trim_start();
    matches!(value.trim(), "-" | "@-")
        || file_named(value, probe).is_some()
        || ["diff ", "--- ", "Index: ", "@@"]
            .iter()
            .any(|p| start.starts_with(p))
}

/// The one comma at which both sides are files; none when none or several.
fn compare_pair(value: &str, probe: &impl Probe) -> Option<(String, String)> {
    let mut pairs = value.match_indices(',').filter_map(|(at, _)| {
        let (before, after) = (value[..at].trim(), value[at + 1..].trim());
        (!before.is_empty() && !after.is_empty() && probe.is_file(before) && probe.is_file(after))
            .then(|| (before.to_string(), after.to_string()))
    });
    let first = pairs.next()?;
    pairs.next().is_none().then_some(first)
}

fn is_video(value: &str) -> bool {
    let value = value.trim().as_bytes();
    let starts = |prefix: &[u8]| {
        value.len() >= prefix.len() && value[..prefix.len()].eq_ignore_ascii_case(prefix)
    };
    starts(b"http://") || starts(b"https://")
}

/// A task or an artifact as typed: a ref keeps its own `=`s; anything else
/// with an `=` in it is read as `Caption=value`.
fn is_resource_ref(value: &str) -> bool {
    let value = value.trim();
    !value.is_empty()
        && !value.contains(['\n', '\r'])
        && (value.starts_with("junto://") || !value.contains('='))
}

/// planAttachFlags: every flag value as a plan, or the first that is not valid.
pub fn plan_flags(flags: &AttachFlags, probe: &impl Probe) -> Result<Vec<Captioned>> {
    let mut plans = Vec::new();
    for (flag, values) in flags.each() {
        for raw in values {
            let fail = |why: Option<&str>| flag_error(flag, raw, why);
            let planned = match flag {
                Flag::Attach => split_caption(raw, |v| probe.is_file(v))
                    .map(|(path, c)| (Plan::File { path }, c)),
                Flag::Code => {
                    split_caption(raw, |v| code_value(v).is_some()).and_then(|(value, c)| {
                        let (language, text) = code_value(&value)?;
                        Some((
                            Plan::Code {
                                language: language.into(),
                                text: text_of(text, probe),
                            },
                            c,
                        ))
                    })
                }
                Flag::Diff => split_caption(raw, |v| is_diff_value(v, probe)).map(|(value, c)| {
                    (
                        Plan::Diff {
                            text: text_of(&value, probe),
                        },
                        c,
                    )
                }),
                Flag::Compare => {
                    let split = split_caption(raw, |v| compare_pair(v, probe).is_some());
                    match split.and_then(|(value, c)| Some((compare_pair(&value, probe)?, c))) {
                        Some(((before, after), c)) => Some((
                            Plan::Compare {
                                before: Text::File(before),
                                after: Text::File(after),
                                language: None,
                            },
                            c,
                        )),
                        None if raw.contains(',') => return Err(fail(None)),
                        None => {
                            return Err(fail(Some(
                                r#"two files are needed, split by a comma; for two texts typed inline use the JSON form: {"before": "...", "after": "...", "language": "ts"}"#,
                            )));
                        }
                    }
                }
                Flag::Commit => split_caption(raw, |v| probe.resolve_commit(v.trim()).is_some())
                    .map(|(rev, c)| {
                        (
                            Plan::Commit {
                                rev: rev.trim().into(),
                            },
                            c,
                        )
                    }),
                Flag::Video => split_caption(raw, is_video).map(|(url, c)| {
                    (
                        Plan::Video {
                            url: url.trim().into(),
                        },
                        c,
                    )
                }),
                Flag::Task => split_caption(raw, is_resource_ref).map(|(r, c)| {
                    (
                        Plan::Task {
                            reference: r.trim().into(),
                        },
                        c,
                    )
                }),
                Flag::Artifact => split_caption(raw, is_resource_ref).map(|(r, c)| {
                    (
                        Plan::Artifact {
                            reference: r.trim().into(),
                        },
                        c,
                    )
                }),
            };
            let (plan, caption) = planned.ok_or_else(|| fail(None))?;
            plans.push(Captioned { plan, caption });
        }
    }
    Ok(plans)
}

/// A compare side in the JSON list: literal text, or a file by its path.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum Side {
    Text(String),
    Path(PathOnly),
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PathOnly {
    path: String,
}

/// SignalAttachCliItem: one item of the JSON `attach` list, exactly one shape.
/// A string is literal text (no `@file`, no `-`); a file is named with `path`.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum Item {
    File {
        path: String,
        caption: Option<String>,
    },
    Code {
        code: String,
        language: String,
        caption: Option<String>,
    },
    Diff {
        diff: String,
        caption: Option<String>,
    },
    Compare {
        before: Side,
        after: Side,
        language: Option<String>,
        caption: Option<String>,
    },
    Commit {
        commit: String,
        caption: Option<String>,
    },
    Video {
        url: String,
        caption: Option<String>,
    },
    Task {
        task: String,
        caption: Option<String>,
    },
    Artifact {
        artifact: String,
        caption: Option<String>,
    },
}

/// The JSON `attach` list, strict: an item with a key of no shape is refused,
/// as Effect Schema refuses excess keys on each member of the union.
pub fn strict_items<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<Vec<Item>>, D::Error> {
    use serde::de::Error;
    let raw = Vec::<serde_json::Map<String, serde_json::Value>>::deserialize(deserializer)?;
    raw.into_iter()
        .map(|object| {
            let keys: Vec<&str> = object.keys().map(String::as_str).collect();
            let allowed: &[&str] = match () {
                _ if object.contains_key("path") => &["path", "caption"],
                _ if object.contains_key("code") => &["code", "language", "caption"],
                _ if object.contains_key("diff") => &["diff", "caption"],
                _ if object.contains_key("before") => &["before", "after", "language", "caption"],
                _ if object.contains_key("commit") => &["commit", "caption"],
                _ if object.contains_key("url") => &["url", "caption"],
                _ if object.contains_key("task") => &["task", "caption"],
                _ => &["artifact", "caption"],
            };
            if let Some(extra) = keys.iter().find(|k| !allowed.contains(k)) {
                return Err(D::Error::custom(format!(
                    "attach: \"{extra}\" is not a key of this attachment"
                )));
            }
            serde_json::from_value(serde_json::Value::Object(object)).map_err(D::Error::custom)
        })
        .collect::<std::result::Result<Vec<_>, _>>()
        .map(Some)
}

fn side(value: Side) -> Text {
    match value {
        Side::Text(text) => Text::Inline(text),
        Side::Path(PathOnly { path }) => Text::File(path),
    }
}

/// planAttachItems: the JSON list as plans, in list order.
pub fn plan_items(items: Vec<Item>) -> Vec<Captioned> {
    let trimmed =
        |text: Option<String>| text.map(|t| t.trim().to_string()).filter(|t| !t.is_empty());
    items
        .into_iter()
        .map(|item| {
            let (plan, caption) = match item {
                Item::File { path, caption } => (Plan::File { path }, caption),
                Item::Code {
                    code,
                    language,
                    caption,
                } => (
                    Plan::Code {
                        language,
                        text: Text::Inline(code),
                    },
                    caption,
                ),
                Item::Diff { diff, caption } => (
                    Plan::Diff {
                        text: Text::Inline(diff),
                    },
                    caption,
                ),
                Item::Commit { commit, caption } => (
                    Plan::Commit {
                        rev: commit.trim().into(),
                    },
                    caption,
                ),
                Item::Video { url, caption } => (
                    Plan::Video {
                        url: url.trim().into(),
                    },
                    caption,
                ),
                Item::Task { task, caption } => (
                    Plan::Task {
                        reference: task.trim().into(),
                    },
                    caption,
                ),
                Item::Artifact { artifact, caption } => (
                    Plan::Artifact {
                        reference: artifact.trim().into(),
                    },
                    caption,
                ),
                Item::Compare {
                    before,
                    after,
                    language,
                    caption,
                } => (
                    Plan::Compare {
                        before: side(before),
                        after: side(after),
                        language: trimmed(language),
                    },
                    caption,
                ),
            };
            Captioned {
                plan,
                caption: trimmed(caption),
            }
        })
        .collect()
}

/// stdinUses: how many of the plans read stdin.
pub fn stdin_uses(plans: &[Captioned]) -> usize {
    plans
        .iter()
        .flat_map(|c| match &c.plan {
            Plan::Code { text, .. } | Plan::Diff { text } => vec![text],
            Plan::Compare { before, after, .. } => vec![before, after],
            _ => vec![],
        })
        .filter(|text| **text == Text::Stdin)
        .count()
}

/// languageFileName: `ts` is `snippet.ts`, a name with a dot is itself.
pub fn language_file_name(language: &str, stem: &str) -> String {
    let clean = media::name(language.trim());
    match clean.as_str() {
        _ if clean.contains('.') => clean,
        "" => format!("{stem}.txt"),
        _ => format!("{stem}.{clean}"),
    }
}

/// AgentSignalAttachmentInput: one attachment as the signal names it.
#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum Attachment {
    File {
        #[serde(rename = "ref")]
        reference: Identity,
        #[serde(skip_serializing_if = "Option::is_none")]
        caption: Option<String>,
    },
    Named {
        #[serde(flatten)]
        kind: Named,
        #[serde(skip_serializing_if = "Option::is_none")]
        caption: Option<String>,
    },
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Named {
    Compare {
        before: Identity,
        after: Identity,
        name: String,
    },
    Commit {
        sha: String,
    },
    Link {
        url: String,
    },
    Task {
        #[serde(rename = "ref")]
        reference: String,
    },
    Artifact {
        #[serde(rename = "ref")]
        reference: String,
    },
}

/// What is ready to go up: a file on disk, or text held here.
struct Upload {
    name: String,
    media_type: &'static str,
    bytes: Source,
}

enum Source {
    Path(String),
    Text(String),
}

enum Checked {
    File(Upload),
    Compare {
        before: Upload,
        after: Upload,
        name: String,
    },
    Ready(Named),
}

fn kind_error(plan: &Plan, message: String) -> Failure {
    let flag = Flag::of(plan);
    Failure::input(format!("{}: {message}", flag.name()), "attach")
        .and("hint", format!("for example {}", flag.help().1))
}

fn read_head(path: &str, limit: u64) -> std::io::Result<Vec<u8>> {
    use std::io::Read;
    let mut head = Vec::new();
    std::fs::File::open(path)?
        .take(limit)
        .read_to_end(&mut head)?;
    Ok(head)
}

fn file_upload(plan: &Plan, path: &str) -> Result<Upload> {
    let checked = std::fs::metadata(path).and_then(|info| {
        if !info.is_file() {
            return Err(std::io::Error::other("not a regular file"));
        }
        let head = read_head(path, info.len().min(media::HEAD_BYTES as u64))?;
        let name = Some(media::name(path))
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| "file".into());
        let media_type = media::media_type(&name, &head);
        Ok(Upload {
            name,
            media_type,
            bytes: Source::Path(path.into()),
        })
    });
    checked.map_err(|error| kind_error(plan, format!("{path}: {error}")))
}

fn text_upload(plan: &Plan, source: &Text, name: String, stdin: Option<&str>) -> Result<Upload> {
    let text = match source {
        Text::File(path) => {
            let upload = file_upload(plan, path)?;
            let head = read_head(path, media::HEAD_BYTES as u64).unwrap_or_default();
            if !media::is_text_head(&head) {
                return Err(kind_error(plan, format!("{path}: not a text file")));
            }
            return Ok(upload);
        }
        Text::Stdin => stdin.unwrap_or_default(),
        Text::Inline(text) => text.as_str(),
    };
    if text.trim().is_empty() {
        let why = if *source == Text::Stdin {
            "nothing came in on stdin"
        } else {
            "the text is empty"
        };
        return Err(kind_error(plan, why.into()));
    }
    let media_type = media::media_type(&name, media::text_head(text).as_bytes());
    Ok(Upload {
        name,
        media_type,
        bytes: Source::Text(text.into()),
    })
}

fn check(plan: &Plan, probe: &impl Probe, stdin: Option<&str>) -> Result<Checked> {
    Ok(match plan {
        Plan::File { path } => Checked::File(file_upload(plan, path)?),
        Plan::Code { language, text } => Checked::File(text_upload(
            plan,
            text,
            language_file_name(language, "snippet"),
            stdin,
        )?),
        Plan::Diff { text } => {
            Checked::File(text_upload(plan, text, "changes.diff".into(), stdin)?)
        }
        Plan::Compare {
            before,
            after,
            language,
        } => {
            let side_language = language.as_deref().unwrap_or("txt");
            let before = text_upload(
                plan,
                before,
                language_file_name(side_language, "before"),
                stdin,
            )?;
            let after = text_upload(
                plan,
                after,
                language_file_name(side_language, "after"),
                stdin,
            )?;
            // The language, when given; else the after file's own name.
            let name = language
                .as_deref()
                .map_or_else(|| after.name.clone(), |l| language_file_name(l, "snippet"));
            Checked::Compare {
                before,
                after,
                name,
            }
        }
        Plan::Commit { rev } => match probe.resolve_commit(rev) {
            Some(sha) => Checked::Ready(Named::Commit { sha }),
            None => {
                return Err(kind_error(
                    plan,
                    format!("\"{rev}\" is not a commit in this folder"),
                ));
            }
        },
        Plan::Task { reference } | Plan::Artifact { reference } if reference.is_empty() => {
            return Err(kind_error(
                plan,
                format!("name the {}", Flag::of(plan).name()),
            ));
        }
        Plan::Task { reference } => Checked::Ready(Named::Task {
            reference: reference.clone(),
        }),
        Plan::Artifact { reference } => Checked::Ready(Named::Artifact {
            reference: reference.clone(),
        }),
        Plan::Video { url } => match super::link::admit(url) {
            Ok(url) => Checked::Ready(Named::Link { url }),
            Err(reason) => return Err(kind_error(plan, format!("{url}: {reason}"))),
        },
    })
}

fn upload(item: &Upload, timeout: Timeout) -> Result<Identity> {
    let label = Label {
        media_type: item.media_type,
        display_name: Some(&item.name),
    };
    let staged = match &item.bytes {
        Source::Path(path) => content_stage::file(Path::new(path), label, timeout),
        // Text typed inline goes up from memory: no file is written for it.
        Source::Text(text) => content_stage::bytes(text.as_bytes(), label, timeout),
    };
    staged.map(|staged| staged.identity())
}

/// stageAttachPlans: every plan checked, then what is made of bytes uploaded,
/// in order; nothing goes up unless all of them pass. `stdin` is the piped
/// text, read once by the caller, for the one item that asked for it.
pub fn stage(
    plans: &[Captioned],
    stdin: Option<&str>,
    timeout: Timeout,
    probe: &impl Probe,
) -> Result<Vec<Attachment>> {
    let checked = plans
        .iter()
        .map(|c| check(&c.plan, probe, stdin).map(|checked| (checked, c.caption.clone())))
        .collect::<Result<Vec<_>>>()?;
    checked
        .into_iter()
        .map(|(item, caption)| {
            Ok(match item {
                Checked::File(file) => Attachment::File {
                    reference: upload(&file, timeout)?,
                    caption,
                },
                Checked::Compare {
                    before,
                    after,
                    name,
                } => {
                    let kind = Named::Compare {
                        before: upload(&before, timeout)?,
                        after: upload(&after, timeout)?,
                        name,
                    };
                    Attachment::Named { kind, caption }
                }
                Checked::Ready(kind) => Attachment::Named { kind, caption },
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fake;

    impl Probe for Fake {
        fn is_file(&self, path: &str) -> bool {
            matches!(path, "a.ts" | "b.ts" | "/x.png" | "notes.md")
        }
        fn resolve_commit(&self, rev: &str) -> Option<String> {
            (rev == "HEAD").then(|| "a".repeat(40))
        }
    }

    fn plan(flags: AttachFlags) -> Result<Vec<(Plan, Option<String>)>> {
        plan_flags(&flags, &Fake)
            .map(|plans| plans.into_iter().map(|c| (c.plan, c.caption)).collect())
    }

    #[test]
    fn splits_captions_by_the_one_rule() {
        let code = AttachFlags {
            code: vec!["ts:const a = 1".into(), "The guard=ts:x".into()],
            ..AttachFlags::default()
        };
        assert_eq!(
            plan(code).unwrap(),
            vec![
                (
                    Plan::Code {
                        language: "ts".into(),
                        text: Text::Inline("const a = 1".into())
                    },
                    None
                ),
                (
                    Plan::Code {
                        language: "ts".into(),
                        text: Text::Inline("x".into())
                    },
                    Some("The guard".into())
                ),
            ]
        );
        let attach = AttachFlags {
            attach: vec!["Before= /x.png".into()],
            commit: vec!["The fix=HEAD".into()],
            ..AttachFlags::default()
        };
        assert_eq!(
            plan(attach).unwrap(),
            vec![
                (
                    Plan::File {
                        path: "/x.png".into()
                    },
                    Some("Before".into())
                ),
                (Plan::Commit { rev: "HEAD".into() }, Some("The fix".into())),
            ]
        );
        let task = AttachFlags {
            task: vec!["junto://canvas/c?node=n&item=i".into(), "Stamp=#42".into()],
            ..AttachFlags::default()
        };
        assert_eq!(
            plan(task).unwrap(),
            vec![
                (
                    Plan::Task {
                        reference: "junto://canvas/c?node=n&item=i".into()
                    },
                    None
                ),
                (
                    Plan::Task {
                        reference: "#42".into()
                    },
                    Some("Stamp".into())
                ),
            ]
        );
    }

    #[test]
    fn reads_texts_diffs_and_pairs() {
        let flags = AttachFlags {
            code: vec!["md:@notes.md".into(), "css:@media x".into()],
            diff: vec!["What=-".into(), "--- a\n+++ b".into()],
            compare: vec!["a.ts,b.ts".into()],
            ..AttachFlags::default()
        };
        let plans = plan_flags(&flags, &Fake).unwrap();
        assert_eq!(
            plans[0].plan,
            Plan::Code {
                language: "md".into(),
                text: Text::File("notes.md".into())
            }
        );
        assert_eq!(
            plans[1].plan,
            Plan::Code {
                language: "css".into(),
                text: Text::Inline("@media x".into())
            }
        );
        assert_eq!(plans[2].plan, Plan::Diff { text: Text::Stdin });
        assert_eq!(
            plans[3].plan,
            Plan::Diff {
                text: Text::Inline("--- a\n+++ b".into())
            }
        );
        assert!(
            matches!(&plans[4].plan, Plan::Compare { before: Text::File(b), .. } if b == "a.ts")
        );
        assert_eq!(stdin_uses(&plans), 1);
    }

    #[test]
    fn refuses_what_is_not_a_value() {
        for flags in [
            AttachFlags {
                attach: vec!["/nope".into()],
                ..AttachFlags::default()
            },
            AttachFlags {
                code: vec!["no language".into()],
                ..AttachFlags::default()
            },
            AttachFlags {
                compare: vec!["a.ts".into()],
                ..AttachFlags::default()
            },
            AttachFlags {
                commit: vec!["nope".into()],
                ..AttachFlags::default()
            },
            AttachFlags {
                video: vec!["ftp://x".into()],
                ..AttachFlags::default()
            },
            AttachFlags {
                task: vec!["a=b=c\n".into()],
                ..AttachFlags::default()
            },
        ] {
            let failure = plan_flags(&flags, &Fake).unwrap_err();
            assert_eq!(failure.kind, crate::error::ErrorType::InputError);
        }
    }

    #[test]
    fn names_files_by_language() {
        assert_eq!(language_file_name("ts", "snippet"), "snippet.ts");
        assert_eq!(
            language_file_name("Dockerfile.dev", "snippet"),
            "Dockerfile.dev"
        );
        assert_eq!(language_file_name(" ", "before"), "before.txt");
    }

    #[test]
    fn decodes_json_items_strictly() {
        #[derive(Deserialize)]
        struct List(#[serde(deserialize_with = "strict_items")] Option<Vec<Item>>);
        let List(Some(items)) = serde_json::from_str(
            r#"[{"path":"/x","caption":" A "},{"before":"x","after":{"path":"b"},"language":" ts "},{"url":" https://h "}]"#,
        )
        .unwrap() else {
            panic!("a list")
        };
        let plans = plan_items(items);
        assert_eq!(plans[0].caption.as_deref(), Some("A"));
        assert_eq!(
            plans[1].plan,
            Plan::Compare {
                before: Text::Inline("x".into()),
                after: Text::File("b".into()),
                language: Some("ts".into())
            }
        );
        assert_eq!(
            plans[2].plan,
            Plan::Video {
                url: "https://h".into()
            }
        );
        assert!(serde_json::from_str::<List>(r#"[{"path":"/x","code":"y"}]"#).is_err());
        assert!(
            serde_json::from_str::<List>(r#"[{"before":"x","after":{"path":"b","q":1}}]"#).is_err()
        );
    }

    #[test]
    fn serializes_attachments_in_wire_order() {
        let id = || Identity {
            sha256: "s".into(),
            byte_length: 3,
        };
        let all = vec![
            Attachment::File {
                reference: id(),
                caption: Some("c".into()),
            },
            Attachment::Named {
                kind: Named::Compare {
                    before: id(),
                    after: id(),
                    name: "n.ts".into(),
                },
                caption: None,
            },
            Attachment::Named {
                kind: Named::Task {
                    reference: "#4".into(),
                },
                caption: Some("t".into()),
            },
        ];
        assert_eq!(
            serde_json::to_string(&all).unwrap(),
            r##"[{"ref":{"sha256":"s","byteLength":3},"caption":"c"},{"kind":"compare","before":{"sha256":"s","byteLength":3},"after":{"sha256":"s","byteLength":3},"name":"n.ts"},{"kind":"task","ref":"#4","caption":"t"}]"##
        );
    }
}
