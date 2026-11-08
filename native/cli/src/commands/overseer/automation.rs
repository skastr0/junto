//! `overseer automation create|edit|enable|disable|move|archive|run`
//! (src/cli/commands/overseer-automation.ts): the input as given, its labels
//! folded as the store holds them, with the ids this process mints. A
//! create's automation id is its opId, so a resend names the same automation.

use std::path::Path;

use serde_json::{Map, Value, json};

use super::catalog::{CHANGE_FIELDS, CODE_STEPS, Write};
use crate::attach;
use crate::error::{ErrorType, Failure, Result};
use crate::wire::{OpId, Timeout};

/// DEFAULT_AUTOMATION_LIMITS (src/shared/automation.ts).
fn default_limits() -> Value {
    json!({ "minIntervalMs": 60_000, "maxPerHour": 12 })
}

/// The wire args of one write, and the opId they carry. The whole write is
/// checked before a code file is staged: one that would be refused sends no bytes.
pub fn args(write: Write, input: Value, op_id: Option<&str>) -> Result<(Value, OpId)> {
    let Value::Object(input) = input else {
        return Err(Failure::input(
            "an automation write takes a JSON object",
            "input",
        ));
    };
    let mut input = ordered(input, write.fields(), "")?;
    if let Some(Value::Object(change)) = input.remove("change") {
        input.insert(
            "change".into(),
            ordered(change, CHANGE_FIELDS, "change.")?.into(),
        );
    }
    let mut input = folded(write, input)?;
    let files = code_files(write, &input)?;
    let op_id = minted(op_id)?;
    for file in files {
        staged(write, &mut input, file)?;
    }
    input.insert("opId".into(), op_id.as_str().into());
    if write == Write::Create {
        input.insert("automationId".into(), op_id.as_str().into());
        input.entry("enabled").or_insert(Value::Bool(false));
        input.entry("limits").or_insert_with(default_limits);
    }
    Ok((Value::Object(input), op_id))
}

/// The keys in the schema's order, as Effect Schema decodes a struct; a key
/// the strict schema does not name is refused before anything is sent. The
/// write's ids are named with --op-id, never in the object.
fn ordered(mut input: Map<String, Value>, fields: &[&str], at: &str) -> Result<Map<String, Value>> {
    if let Some(key) = input.keys().find(|key| !fields.contains(&key.as_str())) {
        let failure = Failure::input(
            format!("{key} is not part of the input"),
            format!("{at}{key}"),
        );
        return Err(match key.as_str() {
            "opId" | "automationId" => failure.and("hint", "resend a write with --op-id"),
            _ => failure,
        });
    }
    Ok(fields
        .iter()
        .filter_map(|field| input.remove_entry(*field))
        .collect())
}

/// opIdOf: the opId `--op-id` names, or a new one.
fn minted(given: Option<&str>) -> Result<OpId> {
    match given {
        None => Ok(OpId::mint()),
        Some(text) => serde_json::from_value(Value::String(text.trim().into())).map_err(|_| {
            Failure::input("--op-id must be the ULID a write returned", "--op-id")
                .and("received", text)
        }),
    }
}

/// Where a write's fields sit: a create's top level, an edit's `change`.
fn holder(write: Write, input: &Map<String, Value>) -> Option<(&Map<String, Value>, &'static str)> {
    match write {
        Write::Create => Some((input, "")),
        Write::Edit => input
            .get("change")
            .and_then(Value::as_object)
            .map(|change| (change, "change.")),
        Write::One | Write::Move => None,
    }
}

/// A code step that names its program by file: where it sits, and how the
/// content store names its bytes.
struct CodeFile {
    index: usize,
    file: String,
    media_type: &'static str,
}

/// CODE_MEDIA_TYPES: the content store's name for a program, by its language.
fn media_type(language: &Value) -> Option<&'static str> {
    match language.as_str()? {
        "typescript" => Some("text/typescript"),
        "shell" => Some("text/x-shellscript"),
        _ => None,
    }
}

/// codeFilesOf: each code step that names a file, checked: a build with code
/// steps, a known language, and `file` or `source`, not both.
fn code_files(write: Write, input: &Map<String, Value>) -> Result<Vec<CodeFile>> {
    let Some((holder, prefix)) = holder(write, input) else {
        return Ok(Vec::new());
    };
    let mut files = Vec::new();
    let steps = holder
        .get("then")
        .and_then(Value::as_array)
        .into_iter()
        .flatten();
    for (index, step) in steps.enumerate() {
        let Some(step) = step
            .as_object()
            .filter(|s| s.get("kind") == Some(&json!("code")))
        else {
            continue;
        };
        let at = format!("{prefix}then[{index}]");
        if !CODE_STEPS {
            return Err(Failure::input(
                "code steps are off in this build: Remove the code step to save; a build with code steps on runs it",
                format!("{at}.kind"),
            ));
        }
        let Some(file) = step.get("file") else {
            continue;
        };
        let file = file
            .as_str()
            .filter(|file| !file.is_empty())
            .ok_or_else(|| {
                Failure::input(
                    "file is the path of the step's program",
                    format!("{at}.file"),
                )
            })?;
        if step.contains_key("source") {
            return Err(Failure::input(
                "a code step names its program by file or by source, not both",
                format!("{at}.file"),
            ));
        }
        let media_type = step.get("language").and_then(media_type).ok_or_else(|| {
            Failure::input(
                "language is one of typescript, shell",
                format!("{at}.language"),
            )
        })?;
        files.push(CodeFile {
            index,
            file: file.to_string(),
            media_type,
        });
    }
    Ok(files)
}

/// withSources: the step's `file` staged into the content store and swapped
/// for `source`, the ref it was staged as, so code never rides the socket as text.
fn staged(write: Write, input: &mut Map<String, Value>, file: CodeFile) -> Result<()> {
    let source = attach::stage_file(
        Path::new(&file.file),
        file.media_type,
        None,
        Timeout::default(),
    )?;
    let source = serde_json::to_value(source)
        .map_err(|e| Failure::new(ErrorType::InternalError, e.to_string()))?;
    let holder = match write {
        Write::Edit => input.get_mut("change").and_then(Value::as_object_mut),
        _ => Some(input),
    };
    let step = holder
        .and_then(|holder| holder.get_mut("then"))
        .and_then(|then| then.get_mut(file.index))
        .and_then(Value::as_object_mut);
    if let Some(step) = step {
        step.shift_remove("file");
        step.insert("source".into(), source);
    }
    Ok(())
}

/// foldedLabels: every label a write names, folded as the store holds it: a
/// watch's label, a create-artifact's labels, a label-artifact's add and remove.
fn folded(write: Write, mut input: Map<String, Value>) -> Result<Map<String, Value>> {
    let prefix = match write {
        Write::Create => "",
        Write::Edit => "change.",
        Write::One | Write::Move => return Ok(input),
    };
    let holder = match write {
        Write::Edit => match input.get_mut("change") {
            Some(Value::Object(change)) => change,
            _ => return Ok(input),
        },
        _ => &mut input,
    };
    let on = holder
        .get_mut("trigger")
        .filter(|t| t.get("kind") == Some(&json!("change")))
        .and_then(|t| t.get_mut("on"))
        .and_then(Value::as_object_mut)
        .filter(|on| on.get("kind") == Some(&json!("artifact")));
    if let Some(label) = on.and_then(|on| on.get_mut("label")) {
        *label = label
            .as_str()
            .and_then(label_of)
            .map(Value::String)
            .ok_or_else(|| {
                Failure::input(not_a_label(label), format!("{prefix}trigger.on.label"))
            })?;
    }
    if let Some(Value::Array(then)) = holder.get_mut("then") {
        for (index, step) in then.iter_mut().enumerate() {
            let at = format!("{prefix}then[{index}]");
            let Some(step) = step.as_object_mut() else {
                continue;
            };
            match step.get("kind").and_then(Value::as_str) {
                Some("create-artifact") => {
                    if let Some(labels) = step.get_mut("labels") {
                        *labels = fold_list(labels, &format!("{at}.labels"))?.into();
                    }
                }
                Some("label-artifact") => {
                    let add = step
                        .get("add")
                        .map(|add| fold_list(add, &format!("{at}.add")))
                        .transpose()?;
                    let remove = step
                        .get("remove")
                        .map(|r| fold_list(r, &format!("{at}.remove")))
                        .transpose()?;
                    if let (Some(add), Some(Value::Array(raw))) = (&add, step.get("remove")) {
                        let both = raw.iter().enumerate().find_map(|(at, one)| {
                            let label = one.as_str().and_then(label_of)?;
                            add.contains(&label).then_some((at, label))
                        });
                        if let Some((both, label)) = both {
                            return Err(Failure::input(
                                format!(
                                    "label {label} is both added and removed; name each label once"
                                ),
                                format!("{at}.remove[{both}]"),
                            ));
                        }
                    }
                    if let Some(add) = add {
                        step.insert("add".into(), add.into());
                    }
                    if let Some(remove) = remove {
                        step.insert("remove".into(), remove.into());
                    }
                }
                _ => {}
            }
        }
    }
    Ok(input)
}

/// ARTIFACT_LABELS_MAX (src/shared/wire/artifact-labels.ts).
const LABELS_MAX: usize = 20;

/// foldArtifactLabels: trimmed, lowered, unique and sorted, or the first
/// label that breaks the rule refused at its index.
fn fold_list(raw: &Value, at: &str) -> Result<Vec<String>> {
    let Value::Array(raw) = raw else {
        return Err(Failure::input("labels are a list", at));
    };
    let mut labels = raw
        .iter()
        .enumerate()
        .map(|(index, one)| {
            one.as_str()
                .and_then(label_of)
                .ok_or_else(|| Failure::input(not_a_label(one), format!("{at}[{index}]")))
        })
        .collect::<Result<Vec<_>>>()?;
    labels.sort();
    labels.dedup();
    if labels.len() > LABELS_MAX {
        return Err(Failure::input(
            format!("an artifact holds at most {LABELS_MAX} labels"),
            at,
        ));
    }
    Ok(labels)
}

/// artifactLabelOf: one label folded, or none when it breaks the rule: 1 to
/// 40 of `a-z 0-9 - _ /` and space, no `/` or space at either end, no `//`.
fn label_of(raw: &str) -> Option<String> {
    let label = raw.trim().to_lowercase();
    let inner = |b: u8| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'_' | b'-');
    let bytes = label.as_bytes();
    let fits = (1..=40).contains(&bytes.len())
        && bytes.first().copied().is_some_and(inner)
        && bytes.last().copied().is_some_and(inner)
        && bytes.iter().all(|&b| inner(b) || b == b' ' || b == b'/')
        && !label.contains("//");
    fits.then_some(label)
}

/// notALabel: the label as typed, and the whole rule.
fn not_a_label(raw: &Value) -> String {
    format!(
        "{raw} is not a label: a label is 1 to 40 characters of a-z 0-9 - _ / and space, no leading or trailing / or space, no //"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folds_labels_as_the_store_holds_them() {
        assert_eq!(label_of("  Release/Junto "), Some("release/junto".into()));
        for bad in ["", "/a", "a/", "a//b", " ", "a\u{e9}", &"x".repeat(41)] {
            assert_eq!(label_of(bad), None, "{bad}");
        }
        assert_eq!(
            fold_list(&json!(["b", "A", "a"]), "x").ok(),
            Some(vec!["a".into(), "b".into()])
        );
    }

    #[test]
    fn refuses_a_label_both_added_and_removed() {
        let input = json!({ "then": [{ "kind": "label-artifact", "add": ["Review"], "remove": ["x", " review"] }] });
        let Value::Object(input) = input else {
            unreachable!()
        };
        let error = folded(Write::Create, input).err().map(|f| f.details);
        assert_eq!(error, Some(Some(json!({ "path": "then[0].remove[1]" }))));
    }

    #[test]
    fn a_create_is_given_its_ids_and_defaults() {
        let args = args(
            Write::Create,
            json!({ "target": "A", "enabled": true }),
            None,
        )
        .map(|(args, _)| args)
        .unwrap_or_default();
        assert_eq!(args["opId"], args["automationId"]);
        assert_eq!(args["enabled"], json!(true));
        assert_eq!(args["limits"], default_limits());
    }
}
