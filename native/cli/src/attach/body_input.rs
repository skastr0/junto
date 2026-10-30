//! A prose body for a write command (src/cli/core/body-input.ts). Prose never
//! has to be JSON-escaped: it comes from `--body <text | @file | ->`, the
//! same source rule as `--detail`, or as `"body"` in the JSON argument.
//! Never both, and never empty.

use serde_json::{Map, Value};

use super::signal_input::Source;
use crate::error::{Failure, Result};

/// A body as a command was given it.
pub struct BodyRequest<'a> {
    /// The raw positional argument, when one was typed.
    pub input: Option<&'a str>,
    /// The decoded JSON argument.
    pub argument: Value,
    /// The raw `--body` value, when the flag was given.
    pub flag: Option<&'a str>,
    /// What to say when the body is empty: what the caller should do instead.
    pub empty_message: &'a str,
}

fn is_stdin(raw: Option<&str>) -> bool {
    matches!(raw.map(str::trim), Some("-" | "@-"))
}

/// bodyPlanProblem: the mixes refused before anything is read.
fn planned(request: BodyRequest<'_>) -> Result<(Map<String, Value>, Option<&str>, &str)> {
    let BodyRequest { input, argument, flag, empty_message } = request;
    let Value::Object(argument) = argument else {
        return Err(Failure::input("the argument must be a JSON object", "input"));
    };
    match (argument.contains_key("body"), flag) {
        (true, Some(_)) => Err(Failure::input(r#"the body was given twice: as "body" in the argument and with --body"#, "--body")
            .and("hint", "keep one of them")),
        (false, None) => Err(Failure::input("this command needs a body", "--body")
            .and("hint", r#"--body <text | @file | ->, or "body" in the JSON argument"#)),
        _ if is_stdin(input) && is_stdin(flag) => Err(Failure::input("stdin can feed the argument or --body, not both", "--body").and(
            "hint",
            r#"pass the JSON argument inline and pipe the body: ... | junto overseer references write '{"name":"style"}' --body -"#,
        )),
        _ => Ok((argument, flag, empty_message)),
    }
}

/// withBody: the wire args, the JSON argument with the body in it.
pub fn with_body(request: BodyRequest) -> Result<Map<String, Value>> {
    let (mut argument, flag, empty_message) = planned(request)?;
    let body = match flag {
        Some(flag) => Value::String(Source::of(flag).read()?),
        None => argument.get("body").cloned().unwrap_or(Value::Null),
    };
    let Value::String(text) = &body else {
        return Err(Failure::input("the body must be text", "body"));
    };
    if text.trim().is_empty() {
        return Err(Failure::input(empty_message, "body"));
    }
    argument.insert("body".into(), body);
    Ok(argument)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn body(argument: Value, flag: Option<&str>) -> Result<String> {
        let request = BodyRequest { input: None, argument, flag, empty_message: "say something" };
        with_body(request).map(|args| Value::Object(args).to_string())
    }

    #[test]
    fn takes_one_body() {
        assert_eq!(body(json!({"body": "b", "name": "n"}), None).unwrap(), r#"{"body":"b","name":"n"}"#);
        assert_eq!(body(json!({"name": "n"}), Some("prose")).unwrap(), r#"{"name":"n","body":"prose"}"#);
        for (argument, flag) in [
            (json!({"body": "b"}), Some("x")),
            (json!({}), None),
            (json!([]), None),
            (json!({"body": 1}), None),
            (json!({"body": " "}), None),
        ] {
            assert!(body(argument, flag).is_err());
        }
    }
}
