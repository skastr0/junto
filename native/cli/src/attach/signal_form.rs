//! The reply form a seat asks for when it raises a signal
//! (src/cli/core/signal-form.ts): what the operator produces right in the
//! signal. One per signal; text, today's reply, is the default and needs
//! none. Main resolves the node in the seat's reach and refuses a secret
//! until the vault.

use std::num::NonZeroU64;

use serde::{Deserialize, Serialize};

use super::Kind;
use crate::error::{Failure, Result};

/// SIGNAL_MAX_MIN_WORDS: the longest artifact form condition.
const MAX_MIN_WORDS: i64 = 100_000;

/// SignalFormRequest: what a signal asks the operator to produce.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Form {
    Text,
    Artifact {
        node: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        labels: Option<Vec<String>>,
        #[serde(
            default,
            rename = "minWords",
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::input::counting"
        )]
        min_words: Option<NonZeroU64>,
    },
    /// An artifact form as the flags build it: the same form, its condition
    /// written ahead of its labels (signal-form.ts planFormFlags).
    #[serde(rename = "artifact", skip_deserializing)]
    ArtifactAsked {
        node: String,
        #[serde(rename = "minWords", skip_serializing_if = "Option::is_none")]
        min_words: Option<NonZeroU64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        labels: Option<Vec<String>>,
    },
    Secret {
        name: String,
    },
    Proof,
}

/// The form flags blocked and escalate take.
#[derive(Debug, Default, Clone, clap::Args)]
pub struct FormFlags {
    /// Ask the operator for a secret by the environment variable you read
    #[arg(long = "ask-secret", allow_hyphen_values = true)]
    pub ask_secret: Option<String>,
    /// Ask the operator to write a document in the signal, saved in this Artifacts node
    #[arg(long = "ask-artifact", allow_hyphen_values = true)]
    pub ask_artifact: Option<String>,
    /// With --ask-artifact: the answer counts once the document has at least this many words
    #[arg(long = "min-words", allow_negative_numbers = true)]
    pub min_words: Option<i64>,
    /// With --ask-artifact: a label for the document; repeat for each
    #[arg(long, allow_hyphen_values = true)]
    pub label: Vec<String>,
    /// Ask the operator for proof of work: text with links or files
    #[arg(long = "ask-proof")]
    pub ask_proof: bool,
}

fn refuse(message: impl Into<String>, path: impl Into<String>) -> Failure {
    Failure::input(message, path)
}

fn no_form(kind: Kind, path: &str) -> Failure {
    refuse(
        format!("{} asks for no form: only blocked and escalate ask the operator to produce something", kind.name()),
        path,
    )
}

/// SIGNAL_SECRET_NAME_PATTERN: the environment variable the seat reads.
fn is_secret_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    bytes.next().is_some_and(|b| b.is_ascii_alphabetic() || b == b'_')
        && bytes.all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

/// ARTIFACT_LABEL: lowercase, 1 to 40 of `a-z 0-9 - _ /` and space, no `/` or
/// space at either end, no `//`.
fn is_label(label: &str) -> bool {
    let edge = |b: u8| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-';
    let inner = |b: u8| edge(b) || b == b' ' || b == b'/';
    let bytes = label.as_bytes();
    match bytes {
        [] => false,
        [one] => edge(*one),
        [first, middle @ .., last] => {
            bytes.len() <= 40 && edge(*first) && edge(*last) && middle.iter().all(|b| inner(*b)) && !label.contains("//")
        }
    }
}

/// foldArtifactLabels: trimmed, lowered, unique and sorted, at most 20; the
/// first that cannot be one is refused where it was typed.
fn fold_labels(labels: &[String], at: impl Fn(usize) -> String) -> Result<Vec<String>> {
    let mut folded = labels
        .iter()
        .enumerate()
        .map(|(index, raw)| {
            let label = raw.trim().to_lowercase();
            if is_label(&label) {
                Ok(label)
            } else {
                let shown = serde_json::to_string(raw).unwrap_or_default();
                Err(refuse(
                    format!("{shown} is not a label: a label is 1 to 40 characters of a-z 0-9 - _ / and space, no leading or trailing / or space, no //"),
                    at(index),
                ))
            }
        })
        .collect::<Result<Vec<_>>>()?;
    folded.sort();
    folded.dedup();
    if folded.len() > 20 {
        return Err(refuse("an artifact holds at most 20 labels", at(0)));
    }
    Ok(folded)
}

/// planFormFlags: the form the flags ask for, or why not. At most one form
/// flag; --min-words and --label only with --ask-artifact. Checked before
/// anything is read or sent.
pub fn plan_flags(kind: Kind, flags: &FormFlags) -> Result<Option<Form>> {
    let given: Vec<&str> = [
        flags.ask_secret.as_ref().map(|_| "--ask-secret"),
        flags.ask_artifact.as_ref().map(|_| "--ask-artifact"),
        flags.ask_proof.then_some("--ask-proof"),
    ]
    .into_iter()
    .flatten()
    .collect();
    let artifact_only = || {
        let path = if flags.min_words.is_some() { "--min-words" } else { "--label" };
        refuse("--min-words and --label go with --ask-artifact", path)
    };
    let extras = flags.min_words.is_some() || !flags.label.is_empty();
    match (given.as_slice(), &flags.ask_secret, &flags.ask_artifact) {
        ([], _, _) if flags.min_words.is_some() => Err(refuse("--min-words sets the words an artifact form asks for", "--min-words")
            .and("hint", "add --ask-artifact <Artifacts node>")),
        ([], _, _) if !flags.label.is_empty() => Err(refuse("--label labels the artifact an artifact form makes", "--label")
            .and("hint", "add --ask-artifact <Artifacts node>")),
        ([], _, _) => Ok(None),
        ([first, ..], _, _) if !kind.takes_form() => Err(no_form(kind, first)),
        ([first, second, ..], _, _) => Err(refuse(format!("one form per signal: {first} and {second} given"), *second)
            .and("hint", "ask for one now, and raise another signal for the next")),
        (_, Some(_), _) | (_, None, None) if extras => Err(artifact_only()),
        (_, Some(secret), _) => {
            let name = secret.trim();
            if !is_secret_name(name) {
                let shown = serde_json::to_string(secret).unwrap_or_default();
                return Err(refuse(
                    format!("{shown} is not a secret name: the environment variable you read, letters, digits and _, not starting with a digit"),
                    "--ask-secret",
                )
                .and("hint", r#"junto blocked "Need the Cloudflare token." --ask-secret CLOUDFLARE_API_TOKEN"#));
            }
            Ok(Some(Form::Secret { name: name.into() }))
        }
        (_, None, None) => Ok(Some(Form::Proof)),
        (_, None, Some(node)) => {
            let node = node.trim();
            if node.is_empty() {
                return Err(refuse("--ask-artifact names the Artifacts node the reply is written into", "--ask-artifact"));
            }
            let min_words = match flags.min_words {
                None => None,
                Some(n) => Some(
                    u64::try_from(n)
                        .ok()
                        .filter(|n| *n as i64 <= MAX_MIN_WORDS)
                        .and_then(NonZeroU64::new)
                        .ok_or_else(|| refuse(format!("--min-words is 1 to {MAX_MIN_WORDS}"), "--min-words"))?,
                ),
            };
            let labels = fold_labels(&flags.label, |index| format!("--label[{index}]"))?;
            Ok(Some(Form::ArtifactAsked { node: node.into(), min_words, labels: (!labels.is_empty()).then_some(labels) }))
        }
    }
}

/// foldFormInput: a form from the JSON input, its labels folded as the flags fold them.
pub fn fold_input(kind: Kind, form: Form) -> Result<Form> {
    match form {
        Form::Text => Ok(Form::Text),
        _ if !kind.takes_form() => Err(no_form(kind, "form")),
        Form::Artifact { node, title, labels: Some(labels), min_words } => {
            let folded = fold_labels(&labels, |index| format!("form.labels[{index}]"))?;
            // An empty fold keeps the list as it was given.
            let labels = Some(if folded.is_empty() { labels } else { folded });
            Ok(Form::Artifact { node, title, labels, min_words })
        }
        form => Ok(form),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flags(f: impl FnOnce(&mut FormFlags)) -> FormFlags {
        let mut flags = FormFlags::default();
        f(&mut flags);
        flags
    }

    #[test]
    fn plans_one_form() {
        assert_eq!(plan_flags(Kind::Blocked, &FormFlags::default()).unwrap(), None);
        assert_eq!(
            plan_flags(Kind::Blocked, &flags(|f| f.ask_secret = Some(" CF_TOKEN ".into()))).unwrap(),
            Some(Form::Secret { name: "CF_TOKEN".into() })
        );
        assert_eq!(plan_flags(Kind::Escalate, &flags(|f| f.ask_proof = true)).unwrap(), Some(Form::Proof));
        let artifact = flags(|f| {
            f.ask_artifact = Some("Docs".into());
            f.min_words = Some(50);
            f.label = vec!["B".into(), "a".into(), "b".into()];
        });
        assert_eq!(
            serde_json::to_string(&plan_flags(Kind::Blocked, &artifact).unwrap()).unwrap(),
            r#"{"kind":"artifact","node":"Docs","minWords":50,"labels":["a","b"]}"#
        );
    }

    #[test]
    fn refuses_mixes_and_bad_values() {
        let path = |kind, f: FormFlags| plan_flags(kind, &f).unwrap_err().details.unwrap()["path"].clone();
        assert_eq!(path(Kind::Feedback, flags(|f| f.ask_proof = true)), "--ask-proof");
        assert_eq!(path(Kind::Blocked, flags(|f| f.min_words = Some(3))), "--min-words");
        assert_eq!(path(Kind::Blocked, flags(|f| { f.ask_proof = true; f.ask_secret = Some("A".into()) })), "--ask-proof");
        assert_eq!(path(Kind::Blocked, flags(|f| { f.ask_proof = true; f.label = vec!["x".into()] })), "--label");
        assert_eq!(path(Kind::Blocked, flags(|f| f.ask_secret = Some("1A".into()))), "--ask-secret");
        assert_eq!(path(Kind::Blocked, flags(|f| { f.ask_artifact = Some("D".into()); f.min_words = Some(0) })), "--min-words");
        assert_eq!(path(Kind::Blocked, flags(|f| { f.ask_artifact = Some("D".into()); f.label = vec!["ok".into(), "/no".into()] })), "--label[1]");
    }

    #[test]
    fn reads_labels_by_the_rule() {
        for good in ["a", "project/junto/release", "a b", "x_-1"] {
            assert!(is_label(good), "{good}");
        }
        for bad in ["", " a", "a/", "a//b", "A", &"a".repeat(41), "é"] {
            assert!(!is_label(bad), "{bad}");
        }
    }

    #[test]
    fn folds_the_json_form() {
        let form: Form = serde_json::from_str(r#"{"kind":"artifact","node":"D","labels":["Z","a"],"minWords":2.0}"#).unwrap();
        assert_eq!(
            serde_json::to_string(&fold_input(Kind::Blocked, form).unwrap()).unwrap(),
            r#"{"kind":"artifact","node":"D","labels":["a","z"],"minWords":2}"#
        );
        assert!(fold_input(Kind::Feedback, Form::Proof).is_err());
        assert_eq!(fold_input(Kind::Feedback, Form::Text).unwrap(), Form::Text);
    }
}
