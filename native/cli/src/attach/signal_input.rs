//! How `junto escalate|blocked|feedback <input> [--detail <md>]` reads its
//! input (src/cli/core/signal-input.ts). The sentence is plain text, or a
//! JSON object inline, `@file`, or `-` for stdin. `--detail` is markdown,
//! inline, `@file`, or `-`. Stdin feeds one thing only. What is attached is
//! read and uploaded first, and the signal names it by reference.

use serde::{Deserialize, Serialize};

use super::signal_attach::{self, Attachment, Item, Live};
use super::signal_form::{self, Form};
use super::Kind;
use crate::error::{Failure, Result};
use crate::input;
use crate::ops;
use crate::wire::Timeout;

/// AGENT_SIGNAL_MAX_SUGGESTIONS: the most replies a seat pre-bakes.
const MAX_SUGGESTIONS: usize = 2;

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
#[derive(Serialize)]
pub struct RaiseArgs {
    kind: Kind,
    text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    attach: Vec<Attachment>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    suggest: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    form: Option<Form>,
}

ops! { RaiseArgs => "signal.raise" }

/// Everything a raise was given on its command line.
pub struct Raise<'a> {
    pub kind: Kind,
    pub input: &'a str,
    pub detail: Option<&'a str>,
    pub suggest: &'a [String],
    pub attach: &'a signal_attach::AttachFlags,
    pub form: &'a signal_form::FormFlags,
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
    let Raise { kind, input, detail, suggest, attach, form, timeout } = raise;
    if input.trim().is_empty() {
        return Err(Failure::input("say what you need in one sentence", "input")
            .and("hint", r#"junto blocked "Need the staging API key to run the deploy check.""#));
    }
    let source = Source::of(input);
    let json = !matches!(&source, Source::Inline(text) if !text.trim().starts_with('{'));
    let detail_source = detail.map(Source::of);
    if source == Source::Stdin && detail_source == Some(Source::Stdin) {
        return Err(twice(
            "stdin can feed the input or --detail, not both",
            "--detail",
            Some(r#"pass the sentence inline and pipe the detail: ... | junto blocked "..." --detail -"#),
        ));
    }
    // Flags are checked before anything is read, so a bad one costs nothing.
    let from_flags = signal_attach::plan_flags(attach, &Live)?;
    let form_from_flags = signal_form::plan_flags(kind, form)?;

    let body = source.read()?;
    let payload = if json {
        input::decode_text::<CliInput>(&body, source.kind())?
    } else {
        CliInput { text: body, detail: None, attach: None, suggest: None, form: None }
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
    let suggest = if suggest.is_empty() { payload.suggest.unwrap_or_default() } else { suggest.to_vec() };
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
    let stdin_count = piped + usize::from(source == Source::Stdin) + usize::from(detail_source == Some(Source::Stdin));
    if stdin_count > 1 {
        return Err(twice(
            "stdin can feed one thing: the sentence, --detail, or one attached text",
            "stdin",
            Some(r#"pipe one and write the others inline or from a file: git diff | junto feedback "..." --diff -"#),
        ));
    }
    let detail_text = detail_source.as_ref().map(Source::read).transpose()?;
    if detail_text.is_some() && payload.detail.is_some() {
        return Err(twice("detail given twice: in the JSON input and in --detail", "--detail", None));
    }
    let stdin = if piped > 0 { Some(input::stdin()?) } else { None };
    let attach = if plans.is_empty() { Vec::new() } else { signal_attach::stage(&plans, stdin.as_deref(), timeout, &Live)? };
    Ok(RaiseArgs { kind, text: payload.text, detail: detail_text.or(payload.detail), attach, suggest, form })
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
        assert_eq!(Source::of(" two words "), Source::Inline(" two words ".into()));
    }

    fn raised(input: &str, suggest: &[String]) -> Result<String> {
        let (attach, form) = (signal_attach::AttachFlags::default(), signal_form::FormFlags::default());
        let raise = Raise { kind: Kind::Blocked, input, detail: None, suggest, attach: &attach, form: &form, timeout: Timeout::default() };
        load(raise).map(|args| serde_json::to_string(&args).unwrap_or_default())
    }

    #[test]
    fn builds_the_wire_args_in_order() {
        assert_eq!(
            raised(r#"{"form":{"kind":"proof"},"suggest":["a"],"detail":"d","text":"t"}"#, &[]).unwrap(),
            r#"{"kind":"blocked","text":"t","detail":"d","suggest":["a"],"form":{"kind":"proof"}}"#
        );
        assert_eq!(raised("Need a key", &[]).unwrap(), r#"{"kind":"blocked","text":"Need a key"}"#);
        assert!(raised(r#"{"text":"t","x":1}"#, &[]).is_err());
        assert!(raised("t", &["a".into(), "b".into(), "c".into()]).is_err());
    }
}
