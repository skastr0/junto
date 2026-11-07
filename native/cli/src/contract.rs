//! The work contract's parity harness: each op's Rust args struct against the
//! JSON Schema the TypeScript contract publishes for it
//! (src/contract/work/published/<op>.json, written by
//! src/contract/work/publish.ts). A change to an op's arguments on either side
//! fails `cargo test` until the other side follows.
//!
//! A family adds one line per op to its own file:
//!
//! ```ignore
//! #[cfg(test)]
//! mod contract {
//!     crate::contract::parity! {
//!         list: super::ListArgs => "msg.list",
//!     }
//! }
//! ```
//!
//! For each op the struct must refuse a field the schema does not name
//! (`#[serde(deny_unknown_fields)]`), and every field must agree both ways:
//! each schema field is a struct field and each struct field a schema field,
//! required where the schema requires it, and each field's value as the
//! schema allows it decodes and encodes back unchanged.

use serde::de::value::Error as Refusal;
use serde::de::{self, DeserializeOwned, Visitor};
use serde::{Deserializer, Serialize};
use serde_json::{Map, Value};

/// The published schema of `op` as `include_str!` reads it.
macro_rules! published {
    ($op:literal) => {
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../src/contract/work/published/",
            $op,
            ".json"
        ))
    };
}

/// One `#[test]` per op: `name: ArgsStruct => "op.name"`.
macro_rules! parity {
    ($($name:ident: $args:ty => $op:literal),+ $(,)?) => {$(
        #[test]
        fn $name() {
            $crate::contract::check::<$args>($op, $crate::contract::published!($op));
        }
    )+};
}

pub(crate) use {parity, published};

/// A key no schema names, so a struct that ignores unknown fields takes it.
const UNKNOWN: &str = "juntoNotAField";

/// Patterns the schemas use, each with a value that matches it.
const PATTERN_SAMPLES: &[(&str, &str)] =
    &[("^[0-9A-HJKMNP-TV-Z]{26}$", "01ARZ3NDEKTSV4RRFFQ69G5FAV")];

/// Checks `T` against the op's published file, panicking with every disagreement.
pub fn check<T: DeserializeOwned + Serialize>(op: &str, published: &str) {
    let document: Value = serde_json::from_str(published).expect("a published file is JSON");
    assert_eq!(document["op"], op, "the published file names its op");
    let payload = &document["payload"];
    let definitions = &payload["definitions"];
    let schema = resolve(&payload["schema"], definitions);
    let empty = Map::new();
    let properties = schema["properties"].as_object().unwrap_or(&empty);
    let required: Vec<&str> = schema["required"]
        .as_array()
        .map(|r| r.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let fields = struct_fields::<T>(op);
    let mut wrong = Vec::new();

    if schema["additionalProperties"] != Value::Bool(false) {
        wrong.push(
            "the schema admits fields it does not name: decode it with onExcessProperty \"error\""
                .into(),
        );
    }
    for name in properties.keys() {
        if !fields.contains(&name.as_str()) {
            wrong.push(format!("schema field `{name}` is not in the struct"));
        }
    }
    for name in &fields {
        if !properties.contains_key(*name) {
            wrong.push(format!("struct field `{name}` is not in the schema"));
        }
    }

    let base: Map<String, Value> = required
        .iter()
        .filter_map(|&name| Some((name.to_owned(), sample(properties.get(name)?, definitions))))
        .collect();

    let mut unknown = Map::from_iter([(UNKNOWN.to_owned(), Value::from(0))]);
    unknown.extend(base.clone());
    match serde_json::from_value::<T>(Value::Object(unknown)) {
        Err(e) if e.to_string().contains("unknown field") => {}
        Err(e) => wrong.push(format!(
            "an unknown field is refused for the wrong reason: {e}"
        )),
        Ok(_) => wrong.push("an unknown field is taken: add #[serde(deny_unknown_fields)]".into()),
    }

    if let Err(e) = serde_json::from_value::<T>(Value::Object(base.clone())) {
        wrong.push(format!(
            "the schema's required fields alone are refused: {e}"
        ));
    }

    // One case per schema field: its value decodes, and encodes back as it was.
    for (name, property) in properties {
        if !fields.contains(&name.as_str()) {
            continue;
        }
        let value = sample(property, definitions);
        let mut object = base.clone();
        object.insert(name.clone(), value.clone());
        match serde_json::from_value::<T>(Value::Object(object)) {
            Err(e) => wrong.push(format!(
                "field `{name}`: {value} as the schema allows it is refused: {e}"
            )),
            Ok(args) => {
                let back = serde_json::to_value(&args).expect("args encode");
                if back.get(name) != Some(&value) {
                    wrong.push(format!(
                        "field `{name}`: {value} encodes back as {}",
                        back.get(name).map_or("nothing".into(), Value::to_string)
                    ));
                }
            }
        }
        if required.contains(&name.as_str()) {
            let mut object = base.clone();
            object.remove(name);
            if serde_json::from_value::<T>(Value::Object(object)).is_ok() {
                wrong.push(format!(
                    "field `{name}` is required by the schema, optional in the struct"
                ));
            }
        }
    }

    assert!(
        wrong.is_empty(),
        "{op} disagrees with its published schema:\n  {}",
        wrong.join("\n  ")
    );
}

/// A `$ref` followed into the document's definitions.
fn resolve<'a>(schema: &'a Value, definitions: &'a Value) -> &'a Value {
    match schema["$ref"].as_str() {
        Some(reference) => {
            let name = reference.rsplit('/').next().unwrap_or(reference);
            resolve(&definitions[name], definitions)
        }
        None => schema,
    }
}

/// A value the schema allows: its first literal or branch, the least number, every required key.
fn sample(schema: &Value, definitions: &Value) -> Value {
    let schema = resolve(schema, definitions);
    if let Some(value) = schema.get("const") {
        return value.clone();
    }
    if let Some(first) = schema["enum"].get(0) {
        return first.clone();
    }
    for union in ["anyOf", "oneOf"] {
        if let Some(first) = schema[union].get(0) {
            return sample(first, definitions);
        }
    }
    match schema["type"].as_str() {
        Some("string") => match schema["pattern"].as_str() {
            Some(pattern) => {
                let (_, value) = PATTERN_SAMPLES
                    .iter()
                    .find(|(p, _)| *p == pattern)
                    .unwrap_or_else(|| {
                        panic!("no sample for pattern {pattern}: add one to PATTERN_SAMPLES")
                    });
                Value::from(*value)
            }
            None => {
                let length = schema["minLength"].as_u64().unwrap_or(1).max(1);
                Value::from("x".repeat(length as usize))
            }
        },
        Some("integer" | "number") => schema["minimum"]
            .as_i64()
            .map_or(Value::from(0), Value::from),
        Some("boolean") => Value::Bool(true),
        Some("array") => Value::Array(vec![sample(&schema["items"], definitions)]),
        Some("object") => {
            let required = schema["required"].as_array().cloned().unwrap_or_default();
            Value::Object(
                required
                    .iter()
                    .filter_map(Value::as_str)
                    .map(|name| {
                        (
                            name.to_owned(),
                            sample(&schema["properties"][name], definitions),
                        )
                    })
                    .collect(),
            )
        }
        Some("null") => Value::Null,
        _ => Value::from("x"),
    }
}

/// The struct's field names on the wire, as serde's derive hands them to a deserializer.
fn struct_fields<T: DeserializeOwned>(op: &str) -> Vec<&'static str> {
    struct Fields(Option<&'static [&'static str]>);

    impl<'de> Deserializer<'de> for &mut Fields {
        type Error = Refusal;

        fn deserialize_any<V: Visitor<'de>>(self, _: V) -> Result<V::Value, Refusal> {
            Err(de::Error::custom("not a struct"))
        }

        fn deserialize_struct<V: Visitor<'de>>(
            self,
            _: &'static str,
            fields: &'static [&'static str],
            _: V,
        ) -> Result<V::Value, Refusal> {
            self.0 = Some(fields);
            Err(de::Error::custom("fields read"))
        }

        serde::forward_to_deserialize_any! {
            bool i8 i16 i32 i64 i128 u8 u16 u32 u64 u128 f32 f64 char str string
            bytes byte_buf option unit unit_struct newtype_struct seq tuple
            tuple_struct map enum identifier ignored_any
        }
    }

    let mut fields = Fields(None);
    let _ = T::deserialize(&mut fields);
    fields
        .0
        .unwrap_or_else(|| panic!("{op}: the args type is not a plain struct (a flattened or custom one hides its fields)"))
        .to_vec()
}
