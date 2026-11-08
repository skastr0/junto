//! `task` (src/cli/commands/task.ts), with `task rules` (work.ts): tasks on
//! the task nodes in this seat's reach. A task is `#42`, its id or a
//! `junto://` ref; a seat is `@name`, its name or id, or `me`; main resolves
//! both. Every write carries its opId, minted here unless `--op-id` names the
//! one a timed-out write returned. Each request's keys go out in the order
//! task.ts builds them, so the frame matches the TypeScript CLI's. Each op's
//! args are one plain struct that refuses a field it does not name, checked
//! against the op's published schema (crate::contract).

use std::marker::PhantomData;
use std::process::ExitCode;

use clap::{Args, Subcommand, ValueEnum};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{Run, Timeout};
use crate::envelope::{self, Answer};
use crate::error::{Failure, Result};
use crate::wire::{self, OpId, Request};
use crate::{duration, input, ops};

/// CHECK_OUTPUT_TAIL_MAX (src/shared/task-model.ts), in UTF-16 code units.
const CHECK_OUTPUT_TAIL_MAX: usize = 8 * 1024;
/// TASK_HANDOFF_MAX (src/shared/task-model.ts), in UTF-16 code units.
const HANDOFF_MAX: usize = 4096;
/// TASK_WAIT_UNTIL, TASK_WAIT_DEFAULT_MS and TASK_WAIT_MAX_MS (src/shared/task-control.ts).
const WAIT_UNTIL: [&str; 4] = ["done", "input-required", "in-review", "canceled"];
const WAIT_DEFAULT_MS: u64 = 60_000;
const WAIT_MAX_MS: u64 = 600_000;

/// TASK_STATES (src/shared/task-model.ts).
#[derive(Debug, Clone, Copy, ValueEnum, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum State {
    Backlog,
    Assigned,
    Working,
    InputRequired,
    InReview,
    Done,
    Canceled,
    Archived,
}

#[derive(Debug, Clone, Copy, ValueEnum, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Verdict {
    Approve,
    Changes,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Side {
    Outgoing,
    Incoming,
}

// --- reads -------------------------------------------------------------------

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ListArgs {
    #[serde(skip_serializing_if = "Option::is_none")]
    node: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    assignee: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reviewer: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    limit: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    after: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    state: Vec<State>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ShowArgs {
    task: String,
}

/// A bounded wait for a task to reach a state. This CLI always names the
/// bound; the op takes none as its default.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WaitArgs {
    task: String,
    until: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    timeout_ms: Option<u64>,
}

/// The rules where a task sits, or a task node's own.
#[derive(Serialize, Deserialize)]
#[serde(untagged, deny_unknown_fields)]
enum RulesArgs {
    Task { task: String },
    Node { node: String },
}

ops! {
    ListArgs => "task.list",
    ShowArgs => "task.show",
    RulesArgs => "task.rules",
    WaitArgs => "task.wait",
}

// --- writes ------------------------------------------------------------------

/// Names the op of each verb that shares a shape with others.
trait Op {
    const OP: &'static str;
}

macro_rules! markers {
    ($($ty:ident => $op:literal),+ $(,)?) => {
        $(struct $ty; impl Op for $ty { const OP: &'static str = $op; })+
    };
}

markers! {
    Unassign => "task.unassign",
    Start => "task.start",
    Pause => "task.pause",
    Resume => "task.resume",
    Cancel => "task.cancel",
    Archive => "task.archive",
    Depend => "task.depend",
    Undepend => "task.undepend",
    ReviewerAdd => "task.reviewer-add",
    ReviewerRemove => "task.reviewer-remove",
}

/// unassign, start, pause, resume, cancel and archive name one task.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct One<M> {
    op_id: OpId,
    task: String,
    #[serde(skip)]
    op: PhantomData<M>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Dependency<M> {
    op_id: OpId,
    task: String,
    on: String,
    #[serde(skip)]
    op: PhantomData<M>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReviewerArgs<M> {
    op_id: OpId,
    task: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    reviewer: Option<String>,
    #[serde(skip)]
    op: PhantomData<M>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateArgs {
    op_id: OpId,
    task_id: String,
    title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    body: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    node: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stamps: Option<i64>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EditArgs {
    op_id: OpId,
    task: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    body: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AssignArgs {
    op_id: OpId,
    task: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    seat: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ArtifactCite {
    node_id: String,
    artifact_id: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Git {
    commits: Vec<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Claim {
    rule_id: String,
    text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    refs: Option<Vec<String>>,
}

/// A fork waiver for a task rule whose node is no longer reachable.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Waiver {
    rule_id: String,
    reason: String,
}

/// CompletionEvidence (src/shared/work-model.ts), as the finish flags build it.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Evidence {
    artifacts: Vec<ArtifactCite>,
    #[serde(skip_serializing_if = "Option::is_none")]
    git: Option<Git>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    claims: Vec<Claim>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    waivers: Vec<Waiver>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FinishArgs {
    op_id: OpId,
    task: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    next: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    evidence: Option<Evidence>,
    #[serde(skip_serializing_if = "Option::is_none")]
    handoff: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CheckResult {
    check_id: String,
    side: Side,
    exit_code: i64,
    output_tail: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CheckArgs {
    op_id: OpId,
    task: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    next: Option<String>,
    results: Vec<CheckResult>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StampPolicyArgs {
    op_id: OpId,
    task: String,
    required: i64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StampArgs {
    op_id: OpId,
    task: String,
    verdict: Verdict,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    subject_hash: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CommentArgs {
    op_id: OpId,
    task: String,
    text: String,
}

/// Each task write carries its opId, so a failed send names it.
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
    CreateArgs => "task.create",
    EditArgs => "task.edit",
    AssignArgs => "task.assign",
    FinishArgs => "task.finish",
    CheckArgs => "task.check",
    StampPolicyArgs => "task.stamp-policy",
    StampArgs => "task.stamp",
    CommentArgs => "task.comment",
}

macro_rules! shared_writes {
    ($($ty:ident),+ $(,)?) => {
        $(impl<M: Op> Request for $ty<M> {
            const OP: &'static str = M::OP;
            fn op_id(&self) -> Option<&OpId> {
                Some(&self.op_id)
            }
        })+
    };
}

shared_writes!(One, Dependency, ReviewerArgs);

// --- the command line --------------------------------------------------------

/// Tasks on the task nodes in this seat's reach
#[derive(Args)]
pub struct Task {
    #[command(subcommand)]
    command: Command,
}

/// What every write takes: the opId to resend under, and the call's bound.
#[derive(Args)]
pub(super) struct WriteFlags {
    #[arg(long = "op-id")]
    op_id: Option<String>,
    #[command(flatten)]
    timeout: Timeout,
}

#[derive(Args)]
struct OneTask {
    task: String,
    #[command(flatten)]
    flags: WriteFlags,
}

#[derive(Args)]
struct DependFlags {
    task: String,
    #[arg(long)]
    on: String,
    #[command(flatten)]
    flags: WriteFlags,
}

#[derive(Args)]
struct ReviewerFlags {
    task: String,
    reviewer: Option<String>,
    #[command(flatten)]
    flags: WriteFlags,
}

#[derive(Subcommand)]
enum Reviewer {
    Add(ReviewerFlags),
    Remove(ReviewerFlags),
}

#[derive(Subcommand)]
enum Command {
    List {
        #[arg(long)]
        node: Option<String>,
        #[arg(long, value_enum)]
        state: Vec<State>,
        #[arg(long)]
        assignee: Option<String>,
        #[arg(long)]
        reviewer: Option<String>,
        #[arg(long, allow_negative_numbers = true)]
        limit: Option<i64>,
        #[arg(long)]
        after: Option<String>,
        #[command(flatten)]
        timeout: Timeout,
    },
    Show {
        task: String,
        #[command(flatten)]
        timeout: Timeout,
    },
    Create {
        title: String,
        #[arg(long)]
        body: Option<String>,
        #[arg(long)]
        node: Option<String>,
        #[arg(long, allow_negative_numbers = true)]
        stamps: Option<i64>,
        #[command(flatten)]
        flags: WriteFlags,
    },
    Edit {
        task: String,
        #[arg(long)]
        title: Option<String>,
        #[arg(long)]
        body: Option<String>,
        #[command(flatten)]
        flags: WriteFlags,
    },
    Assign {
        task: String,
        seat: Option<String>,
        #[command(flatten)]
        flags: WriteFlags,
    },
    Unassign(OneTask),
    Start(OneTask),
    Pause(OneTask),
    Resume(OneTask),
    Finish {
        task: String,
        #[arg(long)]
        next: Option<String>,
        #[arg(long)]
        artifact: Vec<String>,
        #[arg(long)]
        commit: Vec<String>,
        #[arg(long)]
        claim: Vec<String>,
        #[arg(long, allow_hyphen_values = true)]
        note: Option<String>,
        #[command(flatten)]
        flags: WriteFlags,
    },
    Check {
        task: String,
        #[arg(long)]
        outgoing: Vec<String>,
        #[arg(long)]
        incoming: Vec<String>,
        #[arg(long, allow_hyphen_values = true)]
        results: Option<String>,
        #[arg(long)]
        next: Option<String>,
        #[command(flatten)]
        flags: WriteFlags,
    },
    Cancel(OneTask),
    Archive(OneTask),
    Depend(DependFlags),
    Undepend(DependFlags),
    #[command(subcommand)]
    Reviewer(Reviewer),
    StampPolicy {
        task: String,
        #[arg(allow_negative_numbers = true)]
        required: i64,
        #[command(flatten)]
        flags: WriteFlags,
    },
    Stamp {
        task: String,
        #[arg(value_enum)]
        verdict: Verdict,
        #[arg(long)]
        text: Option<String>,
        #[arg(long = "subject-hash")]
        subject_hash: Option<String>,
        #[command(flatten)]
        flags: WriteFlags,
    },
    Comment {
        task: String,
        text: String,
        #[command(flatten)]
        flags: WriteFlags,
    },
    Rules {
        task: Option<String>,
        #[arg(long)]
        node: Option<String>,
        #[command(flatten)]
        timeout: Timeout,
    },
    Wait {
        task: String,
        #[arg(long)]
        until: String,
        /// A duration ("600s", "10m") or milliseconds.
        #[arg(long)]
        timeout: Option<String>,
    },
}

// --- running -------------------------------------------------------------------

/// The opId `--op-id` names, or a new one (opIdOf).
fn op_id(given: Option<&str>) -> Result<OpId> {
    match given {
        None => Ok(OpId::mint()),
        Some(text) => serde_json::from_value(Value::from(text.trim())).map_err(|_| {
            Failure::input("--op-id must be the ULID a write returned", "--op-id")
                .and("received", text)
        }),
    }
}

pub(super) fn read<R: Request>(args: &R, timeout: Timeout) -> Answer {
    wire::call(args, timeout.into()).map(Into::into)
}

/// A task write: its args, made with the opId it carries.
fn send<A: Request>(flags: WriteFlags, args: impl FnOnce(OpId) -> A) -> Answer {
    let args = args(op_id(flags.op_id.as_deref())?);
    wire::call(&args, flags.timeout.into()).map(Into::into)
}

fn one<M: Op>(OneTask { task, flags }: OneTask) -> Answer {
    send(flags, |op_id| One::<M> {
        op_id,
        task,
        op: PhantomData,
    })
}

fn dependency<M: Op>(DependFlags { task, on, flags }: DependFlags) -> Answer {
    send(flags, |op_id| Dependency::<M> {
        op_id,
        task,
        on,
        op: PhantomData,
    })
}

fn reviewer<M: Op>(
    ReviewerFlags {
        task,
        reviewer,
        flags,
    }: ReviewerFlags,
) -> Answer {
    send(flags, |op_id| ReviewerArgs::<M> {
        op_id,
        task,
        reviewer,
        op: PhantomData,
    })
}

/// A bounded wait (lowerTaskWait): the socket's bound sits above the wait's own.
fn wait(task: String, until: String, timeout: Option<&str>) -> Answer {
    if !WAIT_UNTIL.contains(&until.as_str()) {
        return Err(duration::until_error("until", &until, &WAIT_UNTIL));
    }
    let timeout_ms = duration::bounded_ms("timeout", timeout, WAIT_MAX_MS, WAIT_DEFAULT_MS)?;
    wire::call(
        &WaitArgs {
            task,
            until,
            timeout_ms: Some(timeout_ms),
        },
        duration::socket_timeout_for(timeout_ms),
    )
    .map(Into::into)
}

/// `<left><sep><right>` split at `at`, both sides non-empty (pairOf).
fn pair(flag: &str, shape: &str, value: &str, at: Option<usize>) -> Result<(String, String)> {
    match at {
        Some(at) if at > 0 && at + 1 < value.len() => Ok((
            value[..at].trim().to_string(),
            value[at + 1..].trim().to_string(),
        )),
        _ => Err(Failure::input(
            format!("--{flag} takes {shape}, got {}", Value::from(value)),
            flag,
        )),
    }
}

/// The evidence flags as CompletionEvidence, or nothing when none was given.
fn evidence(
    artifact: &[String],
    commit: Vec<String>,
    claim: &[String],
) -> Result<Option<Evidence>> {
    // An artifact id holds no slash, so the last one ends the node.
    let artifacts = artifact
        .iter()
        .map(|v| pair("artifact", "<node id>/<artifactId>", v, v.rfind('/')))
        .map(|p| {
            p.map(|(node_id, artifact_id)| ArtifactCite {
                node_id,
                artifact_id,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let claims = claim
        .iter()
        .map(|v| pair("claim", "<ruleId>=<text>", v, v.find('=')))
        .map(|p| {
            p.map(|(rule_id, text)| Claim {
                rule_id,
                text,
                refs: None,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    if artifacts.is_empty() && commit.is_empty() && claims.is_empty() {
        return Ok(None);
    }
    let git = (!commit.is_empty()).then_some(Git { commits: commit });
    Ok(Some(Evidence {
        artifacts,
        git,
        claims,
        waivers: Vec::new(),
    }))
}

/// The note `--note` names, inline, from @file or from - (handoffOf). A
/// file's or stdin's last newline is the file's, not the note's.
fn handoff(raw: &str) -> Result<String> {
    let trimmed = raw.trim();
    let read = |text: String| {
        text.strip_suffix('\n')
            .map(|t| t.strip_suffix('\r').unwrap_or(t).to_string())
            .unwrap_or(text)
    };
    let note = match (
        trimmed,
        trimmed.strip_prefix('@').filter(|path| !path.is_empty()),
    ) {
        ("-" | "@-", _) => read(input::stdin()?),
        (_, Some(path)) => read(input::file(path)?),
        _ => raw.to_string(),
    };
    if note.trim().is_empty() {
        return Err(Failure::input("--note is empty", "note"));
    }
    let length = note.encode_utf16().count();
    if length > HANDOFF_MAX {
        return Err(Failure::input(
            format!("--note holds at most {HANDOFF_MAX} characters, got {length}"),
            "note",
        ));
    }
    Ok(note)
}

/// `<checkId>=<exitCode>` as one result on `side`; the flags carry no output.
fn flagged(side: Side, flag: &str, value: &str) -> Result<CheckResult> {
    let (check_id, code) = pair(flag, "<checkId>=<exitCode>", value, value.rfind('='))?;
    let digits = code.strip_prefix('-').unwrap_or(&code);
    let refused = || {
        Failure::input(
            format!(
                "--{flag} takes <checkId>=<exitCode>, got {}",
                Value::from(value)
            ),
            flag,
        )
    };
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return Err(refused());
    }
    let exit_code = code.parse().map_err(|_| refused())?;
    Ok(CheckResult {
        check_id,
        side,
        exit_code,
        output_tail: String::new(),
    })
}

/// The results the flags name, or the JSON `--results` carries: one way or the other.
fn check_results(
    outgoing: &[String],
    incoming: &[String],
    results: Option<&str>,
) -> Result<Vec<CheckResult>> {
    let flags = outgoing
        .iter()
        .map(|v| flagged(Side::Outgoing, "outgoing", v))
        .chain(
            incoming
                .iter()
                .map(|v| flagged(Side::Incoming, "incoming", v)),
        )
        .collect::<Result<Vec<_>>>()?;
    let reported = match results {
        Some(_) if !flags.is_empty() => None,
        Some(json) => Some(input::load::<Vec<CheckResult>>(json)?),
        None if flags.is_empty() => None,
        None => Some(flags),
    };
    let reported = reported.ok_or_else(|| {
        Failure::input(
            "report results with --outgoing and --incoming, or with --results, not both",
            "results",
        )
    })?;
    Ok(reported
        .into_iter()
        .map(|r| CheckResult {
            output_tail: tail(r.output_tail),
            ..r
        })
        .collect())
}

/// The last CHECK_OUTPUT_TAIL_MAX UTF-16 code units, as main counts them.
fn tail(text: String) -> String {
    let mut over = text
        .encode_utf16()
        .count()
        .saturating_sub(CHECK_OUTPUT_TAIL_MAX);
    if over == 0 {
        return text;
    }
    // A pair cut in half loses its high half here, where JavaScript keeps a lone low one.
    let start = text
        .char_indices()
        .find_map(|(at, c)| {
            if over == 0 {
                return Some(at);
            }
            over = over.saturating_sub(c.len_utf16());
            None
        })
        .unwrap_or(text.len());
    text[start..].to_string()
}

impl Run for Task {
    fn run(self) -> ExitCode {
        let (name, answer) = match self.command {
            Command::List {
                node,
                state,
                assignee,
                reviewer,
                limit,
                after,
                timeout,
            } => (
                "task list",
                read(
                    &ListArgs {
                        node,
                        assignee,
                        reviewer,
                        limit,
                        after,
                        state,
                    },
                    timeout,
                ),
            ),
            Command::Show { task, timeout } => ("task show", read(&ShowArgs { task }, timeout)),
            Command::Create {
                title,
                body,
                node,
                stamps,
                flags,
            } => {
                let task_id = ulid::Ulid::new().to_string();
                (
                    "task create",
                    send(flags, |op_id| CreateArgs {
                        op_id,
                        task_id,
                        title,
                        body,
                        node,
                        stamps,
                    }),
                )
            }
            Command::Edit {
                task,
                title,
                body,
                flags,
            } => (
                "task edit",
                send(flags, |op_id| EditArgs {
                    op_id,
                    task,
                    title,
                    body,
                }),
            ),
            Command::Assign { task, seat, flags } => (
                "task assign",
                send(flags, |op_id| AssignArgs { op_id, task, seat }),
            ),
            Command::Unassign(c) => ("task unassign", one::<Unassign>(c)),
            Command::Start(c) => ("task start", one::<Start>(c)),
            Command::Pause(c) => ("task pause", one::<Pause>(c)),
            Command::Resume(c) => ("task resume", one::<Resume>(c)),
            Command::Cancel(c) => ("task cancel", one::<Cancel>(c)),
            Command::Archive(c) => ("task archive", one::<Archive>(c)),
            Command::Finish {
                task,
                next,
                artifact,
                commit,
                claim,
                note,
                flags,
            } => {
                let finish = evidence(&artifact, commit, &claim).and_then(|evidence| {
                    let handoff = note.as_deref().map(handoff).transpose()?;
                    Ok((evidence, handoff))
                });
                (
                    "task finish",
                    finish.and_then(|(evidence, handoff)| {
                        send(flags, |op_id| FinishArgs {
                            op_id,
                            task,
                            next,
                            evidence,
                            handoff,
                        })
                    }),
                )
            }
            Command::Check {
                task,
                outgoing,
                incoming,
                results,
                next,
                flags,
            } => {
                let check = check_results(&outgoing, &incoming, results.as_deref());
                (
                    "task check",
                    check.and_then(|results| {
                        send(flags, |op_id| CheckArgs {
                            op_id,
                            task,
                            next,
                            results,
                        })
                    }),
                )
            }
            Command::Depend(c) => ("task depend", dependency::<Depend>(c)),
            Command::Undepend(c) => ("task undepend", dependency::<Undepend>(c)),
            Command::Reviewer(Reviewer::Add(c)) => {
                ("task reviewer add", reviewer::<ReviewerAdd>(c))
            }
            Command::Reviewer(Reviewer::Remove(c)) => {
                ("task reviewer remove", reviewer::<ReviewerRemove>(c))
            }
            Command::StampPolicy {
                task,
                required,
                flags,
            } => (
                "task stamp-policy",
                send(flags, |op_id| StampPolicyArgs {
                    op_id,
                    task,
                    required,
                }),
            ),
            Command::Stamp {
                task,
                verdict,
                text,
                subject_hash,
                flags,
            } => {
                let answer = match (verdict, &text) {
                    (Verdict::Changes, None) => Err(Failure::input(
                        "changes says what to change: add --text",
                        "text",
                    )),
                    _ => send(flags, |op_id| StampArgs {
                        op_id,
                        task,
                        verdict,
                        text,
                        subject_hash,
                    }),
                };
                ("task stamp", answer)
            }
            Command::Comment { task, text, flags } => (
                "task comment",
                send(flags, |op_id| CommentArgs { op_id, task, text }),
            ),
            Command::Rules {
                task,
                node,
                timeout,
            } => {
                // One of the two: the rules where a task sits, or a task node's own.
                let args = match (task, node) {
                    (Some(task), None) => Ok(RulesArgs::Task { task }),
                    (None, Some(node)) => Ok(RulesArgs::Node { node }),
                    (task, _) => {
                        let path = if task.is_some() { "node" } else { "task" };
                        Err(Failure::input("name a task, or --node, not both", path))
                    }
                };
                ("task rules", args.and_then(|args| read(&args, timeout)))
            }
            Command::Wait {
                task,
                until,
                timeout,
            } => ("task wait", wait(task, until, timeout.as_deref())),
        };
        envelope::print(name, answer)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tail_keeps_the_last_utf16_units() {
        let short = "ok".to_string();
        assert_eq!(tail(short.clone()), short);
        let long = format!(
            "{}{}",
            "é".repeat(10),
            "a".repeat(CHECK_OUTPUT_TAIL_MAX - 1)
        );
        assert_eq!(
            tail(long),
            format!("é{}", "a".repeat(CHECK_OUTPUT_TAIL_MAX - 1))
        );
    }

    #[test]
    fn pairs_split_where_task_ts_does() {
        assert_eq!(
            pair("claim", "s", "tests= a=b", Some(5)).ok(),
            Some(("tests".into(), "a=b".into()))
        );
        assert!(pair("claim", "s", "=x", Some(0)).is_err());
        assert!(pair("claim", "s", "x=", Some(1)).is_err());
        assert!(flagged(Side::Outgoing, "outgoing", "lint=1x").is_err());
        assert_eq!(
            flagged(Side::Incoming, "incoming", "e2e=-2")
                .map(|r| r.exit_code)
                .ok(),
            Some(-2)
        );
    }
}

#[cfg(test)]
mod contract {
    crate::contract::parity! {
        list: super::ListArgs => "task.list",
        show: super::ShowArgs => "task.show",
        wait: super::WaitArgs => "task.wait",
        rules: super::RulesArgs => "task.rules",
        create: super::CreateArgs => "task.create",
        edit: super::EditArgs => "task.edit",
        assign: super::AssignArgs => "task.assign",
        unassign: super::One<super::Unassign> => "task.unassign",
        start: super::One<super::Start> => "task.start",
        pause: super::One<super::Pause> => "task.pause",
        resume: super::One<super::Resume> => "task.resume",
        finish: super::FinishArgs => "task.finish",
        check: super::CheckArgs => "task.check",
        cancel: super::One<super::Cancel> => "task.cancel",
        archive: super::One<super::Archive> => "task.archive",
        depend: super::Dependency<super::Depend> => "task.depend",
        undepend: super::Dependency<super::Undepend> => "task.undepend",
        reviewer_add: super::ReviewerArgs<super::ReviewerAdd> => "task.reviewer-add",
        reviewer_remove: super::ReviewerArgs<super::ReviewerRemove> => "task.reviewer-remove",
        stamp_policy: super::StampPolicyArgs => "task.stamp-policy",
        stamp: super::StampArgs => "task.stamp",
        comment: super::CommentArgs => "task.comment",
        rulings: crate::commands::work::RulingsArgs => "rulings",
    }
}
