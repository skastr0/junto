//! JSON input as src/cli/core/json.ts loads it: inline, `@file`, or `-` and
//! `@-` for stdin, decoded into the type the command sends. Unknown keys are
//! dropped, as Effect Schema drops them; the runtime decodes again and decides.

use std::io::Read;
use std::num::NonZeroU64;

use serde::de::{DeserializeOwned, Error as _};
use serde::{Deserialize, Deserializer};
use serde_json::Value;

use crate::error::{Failure, Result};

/// The text an input names, and where it came from (the error's `path`).
pub fn read(input: &str) -> Result<(String, String)> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(Failure::input("JSON input is empty", "inline"));
    }
    if trimmed == "-" || trimmed == "@-" {
        return stdin().map(|text| (text, "stdin".into()));
    }
    match trimmed.strip_prefix('@') {
        Some("") => Err(Failure::input("@file input is missing a file path", "@")),
        Some(path) => file(path).map(|text| (text, path.into())),
        None => Ok((trimmed.into(), "inline".into())),
    }
}

/// All of stdin; a leading byte order mark goes, as Response.text() drops it.
pub fn stdin() -> Result<String> {
    let mut bytes = Vec::new();
    std::io::stdin()
        .lock()
        .read_to_end(&mut bytes)
        .map_err(|e| Failure::input(e.to_string(), "stdin"))?;
    let text = String::from_utf8_lossy(&bytes);
    Ok(text.strip_prefix('\u{feff}').unwrap_or(&text).to_string())
}

/// A file's text, or the refusal readFile would give, as Node words it.
pub fn file(path: &str) -> Result<String> {
    std::fs::read(path)
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .map_err(|error| {
            let message = match error.raw_os_error() {
                Some(2) => format!("ENOENT: no such file or directory, open '{path}'"),
                Some(13) => format!("EACCES: permission denied, open '{path}'"),
                Some(21) => "EISDIR: illegal operation on a directory, read".to_string(),
                _ => error.to_string(),
            };
            Failure::input(message, path)
        })
}

/// Text parsed as JSON and decoded as `T`, or the InputError naming `source`.
pub fn decode_text<T: DeserializeOwned>(text: &str, source: &str) -> Result<T> {
    serde_json::from_str(text).map_err(|error| {
        Failure::input(error.to_string(), source).and("hint", "provide valid JSON (object or array)")
    })
}

/// loadJsonInput: the input decoded as `T`.
pub fn load<T: DeserializeOwned>(input: &str) -> Result<T> {
    let (text, source) = read(input)?;
    decode_text(&text, &source)
}

/// loadJsonInput for an optional input: `{}` when absent or blank.
pub fn load_or_empty<T: DeserializeOwned>(input: Option<&str>) -> Result<T> {
    load(input.filter(|i| !i.trim().is_empty()).unwrap_or("{}"))
}

/// loadBatchJsonInput: one object, or an array of items.
pub fn load_batch(input: &str) -> Result<Vec<Value>> {
    match load::<Value>(input)? {
        Value::Array(items) => Ok(items),
        object @ Value::Object(_) => Ok(vec![object]),
        _ => Err(Failure::input(
            "batch input must be a JSON object or array of objects",
            "input",
        )),
    }
}

/// A counting number (a line, a page), written either way JSON allows (`3`
/// or `3.0`), as Schema.Int with a minimum of 1 reads it.
pub fn counting<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<NonZeroU64>, D::Error> {
    let n = f64::deserialize(deserializer)?;
    if n.fract() != 0.0 || n.abs() > 9_007_199_254_740_991.0 {
        return Err(D::Error::custom("Expected an integer"));
    }
    NonZeroU64::new(n.max(0.0) as u64)
        .map(Some)
        .ok_or_else(|| D::Error::custom("Expected a value greater than or equal to 1"))
}
