//! How `junto overseer secret put [json]` reads its two inputs
//! (src/cli/core/secret-input.ts). The JSON argument names the secret (`{}`
//! or `{secretId}`), inline or `@file`. The value comes from stdin and from
//! nowhere else: an argument is visible to every process and stays in shell
//! history, a pipe does not. No error built here repeats what it was given,
//! so a value put in the wrong place is never found again in the output.

use std::io::IsTerminal;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{Failure, Result};
use crate::input;

const HINT: &str = r#"printf %s "$VALUE" | junto overseer secret put '{}'"#;

fn refuse(message: &str, path: &str) -> Failure {
    Failure::input(message, path).and("hint", HINT)
}

/// OverseerSecretPutInput: `{}` or `{secretId}`, and nothing else.
#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SecretPut {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub secret_id: Option<String>,
}

/// decodeSecretPutInput: the JSON argument as typed, or absent.
pub fn decode(inline: Option<&str>) -> Result<SecretPut> {
    let raw = inline
        .map(str::trim)
        .filter(|raw| !raw.is_empty())
        .unwrap_or("{}");
    if matches!(raw, "-" | "@-") {
        return Err(refuse(
            "stdin carries the secret value; give the JSON argument inline or as @file",
            "input",
        ));
    }
    let text = match raw.strip_prefix('@') {
        Some(path) => input::file(path)?,
        None => raw.to_string(),
    };
    // A JSON parse error quotes the text it choked on.
    let value: Value = serde_json::from_str(&text)
        .map_err(|_| refuse("the argument is not valid JSON", "input"))?;
    if value
        .as_object()
        .is_some_and(|object| object.contains_key("value"))
    {
        return Err(refuse(
            "the secret value is read from stdin only, never from the argument",
            "value",
        ));
    }
    serde_json::from_value(value).map_err(|_| {
        refuse(
            "the argument is {} or {secretId}, and nothing else",
            "input",
        )
    })
}

/// Exactly one trailing newline is the shell's, not the secret's.
fn strip_one_newline(text: &str) -> &str {
    text.strip_suffix('\n').unwrap_or(text)
}

/// readSecretValue: the value from stdin. A terminal is refused: it would echo the typing.
pub fn read_value() -> Result<String> {
    if std::io::stdin().is_terminal() {
        return Err(refuse(
            "the secret value is read from stdin; pipe it in, a terminal is refused",
            "stdin",
        ));
    }
    let text = input::stdin().map_err(|_| refuse("stdin could not be read", "stdin"))?;
    match strip_one_newline(&text) {
        "" => Err(refuse("the secret value is empty", "stdin")),
        value => Ok(value.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_the_secret_and_never_holds_its_value() {
        assert_eq!(decode(None).unwrap(), SecretPut { secret_id: None });
        assert_eq!(
            decode(Some(r#"{"secretId":"s"}"#)).unwrap(),
            SecretPut {
                secret_id: Some("s".into())
            }
        );
        for bad in ["-", r#"{"value":"hunter2"}"#, "{not json", r#"{"x":1}"#] {
            let failure = decode(Some(bad)).unwrap_err();
            assert!(
                !serde_json::to_string(&failure).unwrap().contains("hunter2"),
                "{bad}"
            );
        }
        assert_eq!(strip_one_newline("v\n\n"), "v\n");
    }
}
