//! How `junto escalate|blocked|feedback <input> [--detail <md>]` reads its
//! input (src/cli/core/signal-input.ts). The sentence is plain text, or a
//! JSON object inline, `@file`, or `-` for stdin. `--detail` is markdown,
//! inline, `@file`, or `-`. Stdin feeds one thing only. What is attached is
//! read and uploaded first, and the signal names it by reference.

use serde::{Deserialize, Serialize};

use super::Kind;
use super::signal_attach::{self, Attachment, Item, Live};
use super::signal_form::{self, Form};
use crate::error::{Failure, Result};
use crate::input;
use crate::ops;
use crate::wire::Timeout;

/// AGENT_SIGNAL_MAX_SUGGESTIONS: the most replies a seat pre-bakes.
const MAX_SUGGESTIONS: usize = 2;
/// AGENT_SIGNAL_MAX_DEPENDS_ON: the most signals one names as the ones it comes after.
const MAX_DEPENDS_ON: usize = 8;
/// SIGNAL_BATCH_MAX: the most signals one batch raises.
const MAX_BATCH: usize = 50;

/// isUlid (src/shared/wire/ulid.ts): 26 characters of Crockford base32.
fn is_ulid(text: &str) -> bool {
    text.len() == 26
        && text
            .bytes()
            .all(|byte| b"0123456789ABCDEFGHJKMNPQRSTVWXYZ".contains(&byte))
}

fn not_ulid(path: &str, what: &str) -> Failure {
    Failure::input(
        &format!("{path} takes {what}: a ULID, 26 characters of Crockford base32"),
        path,
    )
    .and(
        "hint",
        "junto thread list and junto signal list print the ids",
    )
}

/// Where a text comes from: `-` or `@-` is stdin, `@path` a file, anything
/// else the text itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Source {
    Stdin,
    File(String),
    Inline(String),
}

impl Source {
    pub fn of(raw: &str) -> Source {
        let trimmed = raw.trim();
        match trimmed {
            "-" | "@-" => Source::Stdin,
            _ => match trimmed.strip_prefix('@').filter(|path| !path.is_empty()) {
                Some(path) => Source::File(path.into()),
                None => Source::Inline(raw.into()),
            },
        }
    }

    /// The name an error's `path` gives it.
    fn kind(&self) -> &'static str {
        match self {
            Source::Stdin => "stdin",
            Source::File(_) => "file",
            Source::Inline(_) => "inline",
        }
    }

    /// readSource: the text, read now.
    pub fn read(&self) -> Result<String> {
        match self {
            Source::Stdin => input::stdin(),
            Source::File(path) => input::file(path),
            Source::Inline(text) => Ok(text.clone()),
        }
    }
}

/// SignalRaiseCliInput: the JSON input. The command names the kind.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CliInput {
    text: String,
    detail: Option<String>,
    #[serde(default, deserialize_with = "signal_attach::strict_items")]
    attach: Option<Vec<Item>>,
    suggest: Option<Vec<String>>,
    form: Option<Form>,
}

/// SignalRaiseArgs, in the order the TypeScript CLI builds it.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RaiseArgs {
    kind: Kind,
    text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    attach: Vec<Attachment>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    suggest: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    form: Option<Form>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    thread: Option<String>,
    #[serde(default, rename = "dependsOn", skip_serializing_if = "Vec::is_empty")]
    depends_on: Vec<String>,
    #[serde(
        default,
        rename = "dependsOnLast",
        skip_serializing_if = "std::ops::Not::not"
    )]
    depends_on_last: bool,
}

/// What a batch item comes after: an earlier item by position from 1, or a signal by id.
#[derive(Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum After {
    Position(i64),
    Id(String),
}

/// SignalBatchItem: a raise with its kind, its thread and what it comes after.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BatchItem {
    kind: Kind,
    text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    attach: Vec<Attachment>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    suggest: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    form: Option<Form>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    thread: Option<String>,
    #[serde(default, rename = "dependsOn", skip_serializing_if = "Option::is_none")]
    depends_on: Option<Vec<After>>,
}

/// SignalBatchArgs.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BatchArgs {
    signals: Vec<BatchItem>,
}

ops! {
    RaiseArgs => "signal.raise",
    BatchArgs => "signal.batch",
}

#[cfg(test)]
mod contract {
    crate::contract::parity! {
        raise: super::RaiseArgs => "signal.raise",
        batch: super::BatchArgs => "signal.batch",
    }
}

/// `--thread`, `--depends-on` and `--depends-on-last`: where the raise stands.
#[derive(Default)]
pub struct Order {
    pub thread: Option<String>,
    pub depends_on: Vec<String>,
    pub depends_on_last: bool,
}

/// planOrderFlags: each id checked before anything is read or sent.
fn plan_order(order: &Order) -> Result<(Option<String>, Vec<String>)> {
    let thread = order.thread.as_deref().map(str::trim).map(String::from);
    if thread.as_deref().is_some_and(|id| !is_ulid(id)) {
        return Err(not_ulid(
            "--thread",
            "a thread id or the id of any mail in it",
        ));
    }
    let depends_on: Vec<String> = order
        .depends_on
        .iter()
        .map(|id| id.trim().to_string())
        .collect();
    if depends_on.iter().any(|id| !is_ulid(id)) {
        return Err(not_ulid("--depends-on", "a signal id"));
    }
    if depends_on.len() > MAX_DEPENDS_ON {
        return Err(Failure::input(
            &format!("a signal comes after at most {MAX_DEPENDS_ON} others"),
            "--depends-on",
        ));
    }
    Ok((thread, depends_on))
}

/// Everything a raise was given on its command line.
pub struct Raise<'a> {
    pub kind: Kind,
    pub input: &'a str,
    pub detail: Option<&'a str>,
    pub suggest: &'a [String],
    pub attach: &'a signal_attach::AttachFlags,
    pub form: &'a signal_form::FormFlags,
    pub order: &'a Order,
    pub timeout: Timeout,
}

fn twice(message: &str, path: &str, hint: Option<&str>) -> Failure {
    let failure = Failure::input(message, path);
    match hint {
        Some(hint) => failure.and("hint", hint),
        None => failure,
    }
}

/// loadSignalRaiseArgs: the raise's arguments, its attachments uploaded.
/// Every mix is refused before anything is read, and nothing goes up unless
/// every attachment passes its check.
pub fn load(raise: Raise) -> Result<RaiseArgs> {
    let Raise {
        kind,
        input,
        detail,
        suggest,
        attach,
        form,
        order,
        timeout,
    } = raise;
    let (thread, depends_on) = plan_order(order)?;
    if input.trim().is_empty() {
        return Err(
            Failure::input("say what you need in one sentence", "input").and(
                "hint",
                r#"junto blocked "Need the staging API key to run the deploy check.""#,
            ),
        );
    }
    let source = Source::of(input);
    let json = !matches!(&source, Source::Inline(text) if !text.trim().starts_with('{'));
    let detail_source = detail.map(Source::of);
    if source == Source::Stdin && detail_source == Some(Source::Stdin) {
        return Err(twice(
            "stdin can feed the input or --detail, not both",
            "--detail",
            Some(
                r#"pass the sentence inline and pipe the detail: ... | junto blocked "..." --detail -"#,
            ),
        ));
    }
    // Flags are checked before anything is read, so a bad one costs nothing.
    let from_flags = signal_attach::plan_flags(attach, &Live)?;
    let form_from_flags = signal_form::plan_flags(kind, form)?;

    let body = source.read()?;
    let payload = if json {
        input::decode_text::<CliInput>(&body, source.kind())?
    } else {
        CliInput {
            text: body,
            detail: None,
            attach: None,
            suggest: None,
            form: None,
        }
    };
    if let (Some(flag), Some(_)) = (attach.first_given(), &payload.attach) {
        return Err(twice(
            &format!("attachments given twice: in the JSON input and in {flag}"),
            &flag,
            Some("use the flags or the JSON attach list, not both"),
        ));
    }
    if !suggest.is_empty() && payload.suggest.is_some() {
        return Err(twice(
            "suggested replies given twice: in the JSON input and in --suggest",
            "--suggest",
            Some("use the flags or the JSON suggest list, not both"),
        ));
    }
    if form_from_flags.is_some() && payload.form.is_some() {
        return Err(twice(
            "a form given twice: in the JSON input and in the --ask flags",
            "form",
            Some("use the flags or the JSON form, not both"),
        ));
    }
    let form = match (form_from_flags, payload.form) {
        (Some(form), _) => Some(form),
        (None, Some(form)) => Some(signal_form::fold_input(kind, form)?),
        (None, None) => None,
    };
    let suggest = if suggest.is_empty() {
        payload.suggest.unwrap_or_default()
    } else {
        suggest.to_vec()
    };
    if suggest.len() > MAX_SUGGESTIONS {
        return Err(twice(
            &format!("at most {MAX_SUGGESTIONS} suggested replies"),
            "--suggest",
            Some("pre-bake the two the operator is most likely to send"),
        ));
    }
    let plans = match payload.attach {
        Some(items) => signal_attach::plan_items(items),
        None => from_flags,
    };
    // Stdin feeds one thing only: the sentence, the detail, or one attached text.
    let piped = signal_attach::stdin_uses(&plans);
    let stdin_count = piped
        + usize::from(source == Source::Stdin)
        + usize::from(detail_source == Some(Source::Stdin));
    if stdin_count > 1 {
        return Err(twice(
            "stdin can feed one thing: the sentence, --detail, or one attached text",
            "stdin",
            Some(
                r#"pipe one and write the others inline or from a file: git diff | junto feedback "..." --diff -"#,
            ),
        ));
    }
    let detail_text = detail_source.as_ref().map(Source::read).transpose()?;
    if detail_text.is_some() && payload.detail.is_some() {
        return Err(twice(
            "detail given twice: in the JSON input and in --detail",
            "--detail",
            None,
        ));
    }
    let stdin = if piped > 0 {
        Some(input::stdin()?)
    } else {
        None
    };
    let attach = if plans.is_empty() {
        Vec::new()
    } else {
        signal_attach::stage(&plans, stdin.as_deref(), timeout, &Live)?
    };
    Ok(RaiseArgs {
        kind,
        text: payload.text,
        detail: detail_text.or(payload.detail),
        attach,
        suggest,
        form,
        thread,
        depends_on,
        depends_on_last: order.depends_on_last,
    })
}

/// SignalBatchCliItem: one item of `junto signal batch` as the seat writes it.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CliBatchItem {
    kind: Kind,
    text: String,
    detail: Option<String>,
    #[serde(default, deserialize_with = "signal_attach::strict_items")]
    attach: Option<Vec<Item>>,
    suggest: Option<Vec<String>>,
    form: Option<Form>,
    thread: Option<String>,
    #[serde(rename = "dependsOn")]
    depends_on: Option<Vec<After>>,
}

/// A JSON list of items, or `{"signals": [...]}`.
#[derive(Deserialize)]
#[serde(untagged)]
enum CliBatch {
    List(Vec<CliBatchItem>),
    Wrapped { signals: Vec<CliBatchItem> },
}

/// loadSignalBatchArgs: every item checked before anything goes up; stdin
/// feeds the list only, so an attached text comes from a file or inline.
pub fn load_batch(input: &str, timeout: Timeout) -> Result<BatchArgs> {
    if input.trim().is_empty() {
        return Err(Failure::input("give the signals as a JSON list", "input").and(
            "hint",
            r#"junto signal batch '[{"kind":"escalate","text":"First topic."},{"kind":"escalate","text":"Second topic."}]'"#,
        ));
    }
    let source = Source::of(input);
    let items = match input::decode_text::<CliBatch>(&source.read()?, source.kind())? {
        CliBatch::List(items) | CliBatch::Wrapped { signals: items } => items,
    };
    if items.is_empty() || items.len() > MAX_BATCH {
        return Err(Failure::input(
            &format!("a batch raises 1 to {MAX_BATCH} signals"),
            "input",
        ));
    }
    let mut planned = Vec::with_capacity(items.len());
    for (index, item) in items.into_iter().enumerate() {
        let path = format!("signals[{index}]");
        if item
            .suggest
            .as_ref()
            .is_some_and(|s| s.len() > MAX_SUGGESTIONS)
        {
            return Err(Failure::input(
                &format!("at most {MAX_SUGGESTIONS} suggested replies"),
                &format!("{path}.suggest"),
            ));
        }
        let form = item
            .form
            .map(|form| signal_form::fold_input(item.kind, form))
            .transpose()?;
        let thread = item.thread.as_deref().map(str::trim).map(String::from);
        if thread.as_deref().is_some_and(|id| !is_ulid(id)) {
            return Err(not_ulid(
                &format!("{path}.thread"),
                "a thread id or the id of any mail in it",
            ));
        }
        let depends_on = item.depends_on.map(|refs| {
            refs.into_iter()
                .map(|after| match after {
                    After::Id(id) => After::Id(id.trim().to_string()),
                    position => position,
                })
                .collect::<Vec<_>>()
        });
        for (at, after) in depends_on.iter().flatten().enumerate() {
            let place = format!("{path}.dependsOn[{at}]");
            match after {
                After::Id(id) if !is_ulid(id) => {
                    return Err(Failure::input(
                        &format!(
                            "{place} is not a signal id: a ULID, as junto signal list prints it"
                        ),
                        &place,
                    ));
                }
                After::Position(position) if *position < 1 || *position > index as i64 => {
                    return Err(Failure::input(
                        &format!(
                            "item {} can come only after an earlier item, counted from 1",
                            index + 1
                        ),
                        &place,
                    ));
                }
                _ => {}
            }
        }
        if depends_on
            .as_ref()
            .is_some_and(|refs| refs.len() > MAX_DEPENDS_ON)
        {
            return Err(Failure::input(
                &format!("a signal comes after at most {MAX_DEPENDS_ON} others"),
                &format!("{path}.dependsOn"),
            ));
        }
        let plans = item
            .attach
            .map(signal_attach::plan_items)
            .unwrap_or_default();
        if signal_attach::stdin_uses(&plans) > 0 {
            return Err(Failure::input(
                "stdin feeds the batch only: attach a text from a file or inline",
                &format!("{path}.attach"),
            ));
        }
        planned.push((
            item.kind,
            item.text,
            item.detail,
            item.suggest,
            form,
            thread,
            depends_on,
            plans,
        ));
    }
    let mut signals = Vec::with_capacity(planned.len());
    for (kind, text, detail, suggest, form, thread, depends_on, plans) in planned {
        let attach = if plans.is_empty() {
            Vec::new()
        } else {
            signal_attach::stage(&plans, None, timeout, &Live)?
        };
        signals.push(BatchItem {
            kind,
            text,
            detail,
            attach,
            suggest: suggest.unwrap_or_default(),
            form,
            thread,
            depends_on,
        });
    }
    Ok(BatchArgs { signals })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_source_rule() {
        assert_eq!(Source::of(" - "), Source::Stdin);
        assert_eq!(Source::of("@-"), Source::Stdin);
        assert_eq!(Source::of("@notes.md"), Source::File("notes.md".into()));
        assert_eq!(Source::of("@"), Source::Inline("@".into()));
        assert_eq!(
            Source::of(" two words "),
            Source::Inline(" two words ".into())
        );
    }

    fn raised(input: &str, suggest: &[String]) -> Result<String> {
        let (attach, form) = (
            signal_attach::AttachFlags::default(),
            signal_form::FormFlags::default(),
        );
        let raise = Raise {
            kind: Kind::Blocked,
            input,
            detail: None,
            suggest,
            attach: &attach,
            form: &form,
            order: &Order::default(),
            timeout: Timeout::default(),
        };
        load(raise).map(|args| serde_json::to_string(&args).unwrap_or_default())
    }

    #[test]
    fn builds_the_wire_args_in_order() {
        assert_eq!(
            raised(
                r#"{"form":{"kind":"proof"},"suggest":["a"],"detail":"d","text":"t"}"#,
                &[]
            )
            .unwrap(),
            r#"{"kind":"blocked","text":"t","detail":"d","suggest":["a"],"form":{"kind":"proof"}}"#
        );
        assert_eq!(
            raised("Need a key", &[]).unwrap(),
            r#"{"kind":"blocked","text":"Need a key"}"#
        );
        assert!(raised(r#"{"text":"t","x":1}"#, &[]).is_err());
        assert!(raised("t", &["a".into(), "b".into(), "c".into()]).is_err());
    }

    const ID: &str = "01M855GV69YVAA8AM3PDJHCJXX";

    fn ordered(order: Order) -> Result<String> {
        let (attach, form) = (
            signal_attach::AttachFlags::default(),
            signal_form::FormFlags::default(),
        );
        let raise = Raise {
            kind: Kind::Escalate,
            input: "t",
            detail: None,
            suggest: &[],
            attach: &attach,
            form: &form,
            order: &order,
            timeout: Timeout::default(),
        };
        load(raise).map(|args| serde_json::to_string(&args).unwrap_or_default())
    }

    #[test]
    fn carries_the_thread_and_what_a_signal_comes_after() {
        assert_eq!(
            ordered(Order {
                thread: Some(ID.into()),
                depends_on: vec![ID.into()],
                depends_on_last: true,
            })
            .unwrap(),
            format!(
                r#"{{"kind":"escalate","text":"t","thread":"{ID}","dependsOn":["{ID}"],"dependsOnLast":true}}"#
            )
        );
        assert_eq!(
            ordered(Order::default()).unwrap(),
            r#"{"kind":"escalate","text":"t"}"#
        );
        let thread = |id: &str| Order {
            thread: Some(id.into()),
            ..Order::default()
        };
        assert!(ordered(thread("thread-1")).is_err());
        let after = |ids: Vec<String>| Order {
            depends_on: ids,
            ..Order::default()
        };
        assert!(ordered(after(vec!["junk".into()])).is_err());
        assert!(ordered(after(vec![ID.into(); MAX_DEPENDS_ON])).is_ok());
        assert!(ordered(after(vec![ID.into(); MAX_DEPENDS_ON + 1])).is_err());
    }

    fn batch(input: &str) -> Result<String> {
        load_batch(input, Timeout::default())
            .map(|args| serde_json::to_string(&args).unwrap_or_default())
    }

    #[test]
    fn loads_a_batch_in_order_and_refuses_it_whole() {
        assert_eq!(
            batch(&format!(
                r#"[{{"kind":"escalate","text":"one"}},{{"kind":"feedback","text":"two","dependsOn":[1,"{ID}"]}},{{"kind":"blocked","text":"three","dependsOn":[]}}]"#
            ))
            .unwrap(),
            format!(
                r#"{{"signals":[{{"kind":"escalate","text":"one"}},{{"kind":"feedback","text":"two","dependsOn":[1,"{ID}"]}},{{"kind":"blocked","text":"three","dependsOn":[]}}]}}"#
            )
        );
        assert!(batch(r#"{"signals":[{"kind":"escalate","text":"one"}]}"#).is_ok());
        assert!(batch("[]").is_err());
        assert!(batch("").is_err());
        // A position its own or later, or below 1.
        assert!(batch(r#"[{"kind":"escalate","text":"one","dependsOn":[1]}]"#).is_err());
        assert!(batch(r#"[{"kind":"escalate","text":"one"},{"kind":"escalate","text":"two","dependsOn":[0]}]"#).is_err());
        assert!(batch(r#"[{"kind":"escalate","text":"one","dependsOn":["junk"]}]"#).is_err());
        assert!(batch(r#"[{"kind":"escalate","text":"one","thread":"thread-1"}]"#).is_err());
        assert!(batch(r#"[{"kind":"escalate","text":"one","x":1}]"#).is_err());
        let many = vec![r#"{"kind":"escalate","text":"t"}"#; MAX_BATCH + 1].join(",");
        assert!(batch(&format!("[{many}]")).is_err());
    }
}
