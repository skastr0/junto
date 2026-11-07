//! The work contract's parity harness: each op's Rust args type against the
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
//! A field the CLI forwards as given, for the runtime to rule on (a
//! `serde_json::Value`), is named after the op: `=> "op.name" as given ["anchor"]`.
//! Every value the schema allows there must pass through unchanged.
//!
//! The args type is a struct with `#[serde(deny_unknown_fields)]`, or, for a
//! union payload, an untagged enum of such structs. At every depth (nested
//! objects, array items, each branch of a union):
//!
//! - every schema field is a struct field and every struct field a schema
//!   field, wherever the args decode through plain structs (an enum's own
//!   fields are held by the cases below, one way: schema to struct);
//! - one case per field, per literal and per branch: the value the schema
//!   allows decodes, and encodes back unchanged;
//! - a field the schema does not name is refused, and so is an object
//!   missing a field the schema requires, unless another branch takes it.
//!
//! Only the shape is held: bounds, lengths and patterns stay the runtime's
//! to rule on.

use std::cell::RefCell;
use std::collections::BTreeSet;

use serde::de::{DeserializeOwned, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Error, Map, Value};

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

/// One `#[test]` per op: `name: ArgsType => "op.name"`, with `as given [..]` for forwarded fields.
macro_rules! parity {
    ($($name:ident: $args:ty => $op:literal $(as given [$($given:literal),* $(,)?])?),+ $(,)?) => {$(
        #[test]
        fn $name() {
            $crate::contract::check::<$args>(
                $op,
                $crate::contract::published!($op),
                &[$($($given),*)?],
            );
        }
    )+};
}

pub(crate) use {parity, published};

/// A key no schema names, so a struct that ignores unknown fields takes it.
const UNKNOWN: &str = "juntoNotAField";

/// Patterns the schemas use, each with a value that matches it.
const PATTERN_SAMPLES: &[(&str, &str)] = &[
    ("^[0-9A-HJKMNP-TV-Z]{26}$", "01ARZ3NDEKTSV4RRFFQ69G5FAV"),
    ("^[a-z0-9][a-z0-9._-]{0,47}$", "work"),
    ("^[A-Za-z0-9._-]{1,128}$", "work"),
];

/// Checks `T` against the op's published file, panicking with every disagreement.
pub fn check<T: DeserializeOwned + Serialize>(op: &str, published: &str, given: &[&str]) {
    let document: Value = serde_json::from_str(published).expect("a published file is JSON");
    assert_eq!(document["op"], op, "the published file names its op");
    let mut payload = document["payload"].clone();
    merge_all_of(&mut payload);
    let schema = Schema {
        definitions: &payload["definitions"],
    };
    let root = schema.resolve(&payload["schema"]);
    let mut wrong = BTreeSet::new();

    for branch in schema.branches(root) {
        if branch["additionalProperties"] != Value::Bool(false) {
            wrong.insert(
                "the schema admits fields it does not name: decode it with onExcessProperty \"error\""
                    .to_owned(),
            );
        }
    }

    // Field names both ways, wherever the args decode through plain structs.
    let mut traced_any = false;
    for value in schema.fullest(root) {
        let seen = RefCell::new(Vec::new());
        if let Err(e) = T::deserialize(Traced {
            value: value.clone(),
            path: "args".into(),
            seen: &seen,
        }) {
            wrong.insert(format!(
                "args: {value} as the schema allows it is refused: {e}"
            ));
        }
        for (path, fields) in seen.into_inner() {
            traced_any |= path == "args";
            let Some(properties) = schema
                .at(root, &path)
                .and_then(|n| n["properties"].as_object())
            else {
                wrong.insert(format!("{path}: a struct where the schema names no fields"));
                continue;
            };
            for field in fields {
                if !properties.contains_key(*field) {
                    wrong.insert(format!(
                        "struct field `{path}.{field}` is not in the schema"
                    ));
                }
            }
            for name in properties.keys() {
                if !fields.contains(&name.as_str()) {
                    wrong.insert(format!("schema field `{path}.{name}` is not in the struct"));
                }
            }
        }
    }
    if !traced_any && root.get("anyOf").is_none() && root.get("oneOf").is_none() {
        wrong.insert(
            "args: not a plain struct (a flattened or custom one hides its fields)".to_owned(),
        );
    }

    // One case per field, literal and branch, and each way to refuse.
    for (label, value) in schema.cases(root) {
        let path = format!("args{label}");
        // Under a forwarded field, every value passes as given.
        let forwarded = given.iter().any(|field| {
            label
                .strip_prefix('.')
                .and_then(|l| l.strip_prefix(field))
                .is_some_and(|rest| rest != " missing" && !rest.starts_with(char::is_alphanumeric))
        });
        let allowed = forwarded || schema.allows(root, &value);
        match (serde_json::from_value::<T>(value.clone()), allowed) {
            (Ok(args), true) => {
                let back = serde_json::to_value(&args).expect("args encode");
                if !same(&back, &value) {
                    wrong.insert(format!("{path}: {value} encodes back as {back}"));
                }
            }
            (Err(e), true) => {
                wrong.insert(format!(
                    "{path}: {value} as the schema allows it is refused: {e}"
                ));
            }
            (Ok(_), false) if label.ends_with(UNKNOWN) => {
                wrong.insert(format!(
                    "{path}: an unknown field is taken: add #[serde(deny_unknown_fields)]"
                ));
            }
            (Ok(_), false) => {
                wrong.insert(format!(
                    "{path}: {value} is refused by the schema and taken by the struct (a required field made optional?)"
                ));
            }
            (Err(_), false) => {}
        }
    }

    assert!(
        wrong.is_empty(),
        "{op} disagrees with its published schema:\n  {}",
        wrong.into_iter().collect::<Vec<_>>().join("\n  ")
    );
}

/// A published document's schemas, with the definitions its `$ref`s name.
struct Schema<'a> {
    definitions: &'a Value,
}

impl<'a> Schema<'a> {
    /// A `$ref` followed into the document's definitions.
    fn resolve(&self, node: &'a Value) -> &'a Value {
        match node["$ref"].as_str() {
            Some(reference) => {
                let name = reference.rsplit('/').next().unwrap_or(reference);
                self.resolve(&self.definitions[name])
            }
            None => node,
        }
    }

    fn union(&self, node: &'a Value) -> Option<&'a Vec<Value>> {
        node["anyOf"]
            .as_array()
            .or_else(|| node["oneOf"].as_array())
    }

    /// The node's alternatives: each branch of a union, or the node itself.
    fn branches(&self, node: &'a Value) -> Vec<&'a Value> {
        let node = self.resolve(node);
        match self.union(node) {
            Some(branches) => branches.iter().flat_map(|b| self.branches(b)).collect(),
            None => vec![node],
        }
    }

    /// The schema at a traced path (`args.a[].b`), through the first branch that has it.
    fn at(&self, root: &'a Value, path: &str) -> Option<&'a Value> {
        let mut node = root;
        let mut rest = path.strip_prefix("args")?;
        while !rest.is_empty() {
            let (step, tail) = if let Some(tail) = rest.strip_prefix("[]") {
                (None, tail)
            } else {
                let tail = rest.strip_prefix('.')?;
                let end = tail.find(['.', '[']).unwrap_or(tail.len());
                (Some(&tail[..end]), &tail[end..])
            };
            node = self.branches(node).into_iter().find_map(|b| match step {
                Some(field) => b["properties"].get(field),
                None => b.get("items"),
            })?;
            rest = tail;
        }
        self.branches(node)
            .into_iter()
            .find(|b| b.get("properties").is_some())
    }

    /// The least value the node allows: its first literal or branch, the least number, only required keys.
    fn minimal(&self, node: &'a Value) -> Value {
        let node = self.resolve(node);
        if let Some(value) = node.get("const") {
            return value.clone();
        }
        if let Some(first) = node["enum"].get(0) {
            return first.clone();
        }
        if let Some(first) = self.union(node).and_then(|b| b.first()) {
            return self.minimal(first);
        }
        match node["type"].as_str() {
            Some("object") => Value::Object(self.required(node)),
            Some("array") => Value::Array(Vec::new()),
            _ => scalar(node),
        }
    }

    fn required(&self, node: &'a Value) -> Map<String, Value> {
        node["required"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(|name| (name.to_owned(), self.minimal(&node["properties"][name])))
            .collect()
    }

    /// Values with every field the node names, one per branch wherever a union offers a choice.
    fn fullest(&self, node: &'a Value) -> Vec<Value> {
        let node = self.resolve(node);
        if node.get("const").is_some() || node.get("enum").is_some() {
            return vec![self.minimal(node)];
        }
        if let Some(branches) = self.union(node) {
            return branches.iter().flat_map(|b| self.fullest(b)).collect();
        }
        match node["type"].as_str() {
            Some("object") => {
                let properties = node["properties"].as_object().cloned().unwrap_or_default();
                let choices: Vec<(String, Vec<Value>)> = properties
                    .iter()
                    .map(|(name, p)| (name.clone(), self.fullest(p)))
                    .collect();
                let first: Map<String, Value> = choices
                    .iter()
                    .map(|(name, values)| (name.clone(), values[0].clone()))
                    .collect();
                let mut all = vec![Value::Object(first.clone())];
                for (name, values) in &choices {
                    for value in &values[1..] {
                        let mut other = first.clone();
                        other.insert(name.clone(), value.clone());
                        all.push(Value::Object(other));
                    }
                }
                all
            }
            Some("array") => self
                .fullest(&node["items"])
                .into_iter()
                .map(|v| Value::Array(vec![v]))
                .collect(),
            _ => vec![scalar(node)],
        }
    }

    /// Each case under the node, labelled by its path below it.
    fn cases(&self, node: &'a Value) -> Vec<(String, Value)> {
        let node = self.resolve(node);
        if let Some(value) = node.get("const") {
            return vec![(String::new(), value.clone())];
        }
        if let Some(literals) = node["enum"].as_array() {
            return literals
                .iter()
                .map(|l| (format!("={l}"), l.clone()))
                .collect();
        }
        if let Some(branches) = self.union(node) {
            return branches
                .iter()
                .enumerate()
                .flat_map(|(i, b)| {
                    self.cases(b)
                        .into_iter()
                        .map(move |(label, value)| (format!("<branch {}>{label}", i + 1), value))
                })
                .collect();
        }
        match node["type"].as_str() {
            Some("object") => {
                let least = self.required(node);
                let mut cases = vec![(String::new(), Value::Object(least.clone()))];
                for (name, property) in node["properties"].as_object().into_iter().flatten() {
                    for (label, value) in self.cases(property) {
                        let mut object = least.clone();
                        object.insert(name.clone(), value);
                        cases.push((format!(".{name}{label}"), Value::Object(object)));
                    }
                }
                if node["additionalProperties"] == Value::Bool(false) {
                    let mut object = least.clone();
                    object.insert(UNKNOWN.to_owned(), Value::from(0));
                    cases.push((format!(".{UNKNOWN}"), Value::Object(object)));
                }
                for name in least.keys() {
                    let mut object = least.clone();
                    object.remove(name);
                    cases.push((format!(".{name} missing"), Value::Object(object)));
                }
                cases
            }
            Some("array") => self
                .cases(&node["items"])
                .into_iter()
                .map(|(label, value)| (format!("[]{label}"), Value::Array(vec![value])))
                .collect(),
            _ => vec![(String::new(), scalar(node))],
        }
    }

    /// Whether the node allows the value's shape: types, literals, branches and keys, never bounds.
    fn allows(&self, node: &'a Value, value: &Value) -> bool {
        let node = self.resolve(node);
        if node.get("const").is_some_and(|c| c != value) {
            return false;
        }
        if node["enum"].as_array().is_some_and(|l| !l.contains(value)) {
            return false;
        }
        if self
            .union(node)
            .is_some_and(|branches| !branches.iter().any(|b| self.allows(b, value)))
        {
            return false;
        }
        let typed = match node["type"].as_str() {
            Some("string") => value.is_string(),
            Some("integer") => value.is_i64() || value.is_u64(),
            Some("number") => value.is_number(),
            Some("boolean") => value.is_boolean(),
            Some("array") => value.is_array(),
            Some("object") => value.is_object(),
            Some("null") => value.is_null(),
            _ => true,
        };
        if !typed {
            return false;
        }
        match value {
            Value::Object(map) => {
                let required = node["required"].as_array().into_iter().flatten();
                if required
                    .filter_map(Value::as_str)
                    .any(|r| !map.contains_key(r))
                {
                    return false;
                }
                map.iter()
                    .all(|(key, v)| match node["properties"].get(key) {
                        Some(property) => self.allows(property, v),
                        None => match &node["additionalProperties"] {
                            Value::Bool(open) => *open,
                            Value::Null => true,
                            extra => self.allows(extra, v),
                        },
                    })
            }
            Value::Array(items) => match node.get("items") {
                Some(item) => items.iter().all(|v| self.allows(item, v)),
                None => true,
            },
            _ => true,
        }
    }
}

/// Every `allOf` at any depth as the one object it means: its members'
/// fields and requirements together, closed when any member is closed.
fn merge_all_of(node: &mut Value) {
    match node {
        Value::Array(items) => items.iter_mut().for_each(merge_all_of),
        Value::Object(map) => {
            map.values_mut().for_each(merge_all_of);
            let Some(Value::Array(members)) = map.remove("allOf") else {
                return;
            };
            for member in members {
                let Value::Object(member) = member else {
                    continue;
                };
                for (key, value) in member {
                    match (key.as_str(), map.get_mut(&key)) {
                        ("properties", Some(Value::Object(fields))) => {
                            if let Value::Object(more) = value {
                                fields.extend(more);
                            }
                        }
                        ("required", Some(Value::Array(names))) => {
                            for name in value.as_array().into_iter().flatten() {
                                if !names.contains(name) {
                                    names.push(name.clone());
                                }
                            }
                        }
                        ("additionalProperties", Some(open)) if value == Value::Bool(false) => {
                            *open = value;
                        }
                        (_, None) => {
                            map.insert(key, value);
                        }
                        _ => {}
                    }
                }
            }
        }
        _ => {}
    }
}

/// A scalar the node allows: a matching pattern sample, the least length or number, true.
fn scalar(node: &Value) -> Value {
    match node["type"].as_str() {
        Some("string") => match node["pattern"].as_str() {
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
                let length = node["minLength"].as_u64().unwrap_or(1).max(1);
                Value::from("x".repeat(length as usize))
            }
        },
        Some("integer" | "number") => node["minimum"].as_i64().map_or(Value::from(0), Value::from),
        Some("boolean") => Value::Bool(true),
        Some("null") => Value::Null,
        _ => Value::from("x"),
    }
}

/// JSON equality with numbers compared by value, so a Rust float encodes back as the integer it read.
fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(x, y)| same(x, y))
        }
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same(v, w)))
        }
        _ => a == b,
    }
}

type Seen = RefCell<Vec<(String, &'static [&'static str])>>;

/// A JSON value as a deserializer that writes down each struct's field names
/// at its path as serde's derive hands them over. An enum decodes through
/// serde's own buffer, so the structs inside one go unseen.
struct Traced<'s> {
    value: Value,
    path: String,
    seen: &'s Seen,
}

macro_rules! forward {
    ($($method:ident)*) => {$(
        fn $method<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> {
            self.value.$method(visitor)
        }
    )*};
}

impl<'de> Deserializer<'de> for Traced<'_> {
    type Error = Error;

    forward! {
        deserialize_any deserialize_bool deserialize_i8 deserialize_i16 deserialize_i32
        deserialize_i64 deserialize_i128 deserialize_u8 deserialize_u16 deserialize_u32
        deserialize_u64 deserialize_u128 deserialize_f32 deserialize_f64 deserialize_char
        deserialize_str deserialize_string deserialize_bytes deserialize_byte_buf
        deserialize_unit deserialize_map deserialize_identifier deserialize_ignored_any
    }

    fn deserialize_struct<V: Visitor<'de>>(
        self,
        name: &'static str,
        fields: &'static [&'static str],
        visitor: V,
    ) -> Result<V::Value, Error> {
        self.seen.borrow_mut().push((self.path.clone(), fields));
        match self.value {
            Value::Object(map) => visitor.visit_map(TracedMap {
                entries: map.into_iter(),
                next: None,
                path: self.path,
                seen: self.seen,
            }),
            other => other.deserialize_struct(name, fields, visitor),
        }
    }

    fn deserialize_option<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> {
        match self.value {
            Value::Null => visitor.visit_none(),
            _ => visitor.visit_some(self),
        }
    }

    fn deserialize_seq<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> {
        match self.value {
            Value::Array(items) => visitor.visit_seq(TracedSeq {
                items: items.into_iter(),
                path: format!("{}[]", self.path),
                seen: self.seen,
            }),
            other => other.deserialize_seq(visitor),
        }
    }

    fn deserialize_newtype_struct<V: Visitor<'de>>(
        self,
        _: &'static str,
        visitor: V,
    ) -> Result<V::Value, Error> {
        visitor.visit_newtype_struct(self)
    }

    fn deserialize_unit_struct<V: Visitor<'de>>(
        self,
        name: &'static str,
        visitor: V,
    ) -> Result<V::Value, Error> {
        self.value.deserialize_unit_struct(name, visitor)
    }

    fn deserialize_tuple<V: Visitor<'de>>(self, len: usize, visitor: V) -> Result<V::Value, Error> {
        self.value.deserialize_tuple(len, visitor)
    }

    fn deserialize_tuple_struct<V: Visitor<'de>>(
        self,
        name: &'static str,
        len: usize,
        visitor: V,
    ) -> Result<V::Value, Error> {
        self.value.deserialize_tuple_struct(name, len, visitor)
    }

    fn deserialize_enum<V: Visitor<'de>>(
        self,
        name: &'static str,
        variants: &'static [&'static str],
        visitor: V,
    ) -> Result<V::Value, Error> {
        self.value.deserialize_enum(name, variants, visitor)
    }
}

struct TracedMap<'s> {
    entries: serde_json::map::IntoIter,
    next: Option<(String, Value)>,
    path: String,
    seen: &'s Seen,
}

impl<'de> MapAccess<'de> for TracedMap<'_> {
    type Error = Error;

    fn next_key_seed<K: serde::de::DeserializeSeed<'de>>(
        &mut self,
        seed: K,
    ) -> Result<Option<K::Value>, Error> {
        let Some((key, value)) = self.entries.next() else {
            return Ok(None);
        };
        let decoded = seed.deserialize(Value::String(key.clone()))?;
        self.next = Some((key, value));
        Ok(Some(decoded))
    }

    fn next_value_seed<S: serde::de::DeserializeSeed<'de>>(
        &mut self,
        seed: S,
    ) -> Result<S::Value, Error> {
        let (key, value) = self.next.take().expect("a value follows its key");
        seed.deserialize(Traced {
            value,
            path: format!("{}.{key}", self.path),
            seen: self.seen,
        })
    }
}

struct TracedSeq<'s> {
    items: std::vec::IntoIter<Value>,
    path: String,
    seen: &'s Seen,
}

impl<'de> SeqAccess<'de> for TracedSeq<'_> {
    type Error = Error;

    fn next_element_seed<S: serde::de::DeserializeSeed<'de>>(
        &mut self,
        seed: S,
    ) -> Result<Option<S::Value>, Error> {
        self.items
            .next()
            .map(|value| {
                seed.deserialize(Traced {
                    value,
                    path: self.path.clone(),
                    seen: self.seen,
                })
            })
            .transpose()
    }
}

// The harness's own checks: the tracer sees nested structs at their paths,
// and a union payload is held branch by branch.
#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Deserialize)]
    #[allow(dead_code)]
    struct Inner {
        b: String,
    }

    #[derive(Deserialize)]
    #[allow(dead_code)]
    struct Outer {
        a: Option<Vec<Inner>>,
        c: Inner,
    }

    #[test]
    fn traces_nested_structs() {
        let seen = RefCell::new(Vec::new());
        let value = serde_json::json!({ "a": [{ "b": "x" }], "c": { "b": "y" } });
        Outer::deserialize(Traced {
            value,
            path: "args".into(),
            seen: &seen,
        })
        .expect("decodes");
        let paths: Vec<String> = seen.into_inner().into_iter().map(|(p, _)| p).collect();
        assert_eq!(paths, ["args", "args.a[]", "args.c"]);
    }

    #[derive(Serialize, Deserialize)]
    #[serde(untagged, deny_unknown_fields)]
    enum Rules {
        Task { task: String },
        Node { node: String },
    }

    #[derive(Serialize, Deserialize)]
    #[serde(untagged, deny_unknown_fields)]
    enum RulesDrifted {
        Task { task: String },
        Node { nodes: String },
    }

    #[test]
    fn holds_a_union_payload_branch_by_branch() {
        check::<Rules>("task.rules", published!("task.rules"), &[]);
        let drifted = std::panic::catch_unwind(|| {
            check::<RulesDrifted>("task.rules", published!("task.rules"), &[]);
        });
        assert!(drifted.is_err(), "a branch's renamed field goes unseen");
    }
}
