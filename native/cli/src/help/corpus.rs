//! The corpus `junto` answers with nothing running, built by build.rs from
//! the TypeScript that defines it (scripts/native-cli-corpus.ts). Every
//! answer is kept as the TypeScript CLI prints it: help as text, the rest as
//! the JSON its command's `data` is.

use std::collections::HashMap;
use std::sync::LazyLock;

use serde::Deserialize;
use serde_json::value::RawValue;

use crate::wire::Data;

static TEXT: &str = include_str!(concat!(env!("OUT_DIR"), "/corpus.json"));

/// Parsed on first use; the build wrote it, so a corpus that does not parse
/// is a broken build, not input.
pub static CORPUS: LazyLock<Corpus> =
    LazyLock::new(|| serde_json::from_str(TEXT).expect("the corpus build.rs wrote parses"));

#[derive(Deserialize)]
pub struct Corpus {
    /// Every root command the TypeScript CLI registers in this build.
    #[cfg(test)]
    pub root_commands: Vec<String>,
    /// Every root command onboard can teach in this build.
    #[cfg(test)]
    pub taught_roots: Vec<String>,
    /// Help per command path, the words joined by spaces; the root is "".
    pub help: HashMap<String, Page>,
    /// The completion script per shell.
    pub completions: HashMap<String, String>,
    pub schema: Catalog,
    pub examples_catalog: Catalog,
    pub docs: Docs,
}

#[derive(Deserialize)]
pub struct Page {
    pub plain: String,
    pub color: String,
    pub subcommands: Vec<String>,
}

/// A list answer, and the show answer for each target a lookup accepts.
#[derive(Deserialize)]
pub struct Catalog {
    pub list: Box<RawValue>,
    show: Show,
}

#[derive(Deserialize)]
struct Show {
    /// Each answer once, as the JSON text of its `data`.
    answers: Vec<String>,
    keys: HashMap<String, usize>,
}

impl Catalog {
    /// The show answer for a target, as the TypeScript lookup trims it.
    pub fn show(&self, target: &str) -> Option<Data> {
        let at = *self.show.keys.get(target.trim())?;
        RawValue::from_string(self.show.answers.get(at)?.clone()).ok()
    }
}

#[derive(Deserialize)]
pub struct Docs {
    pub list: Box<RawValue>,
    pub doctrine: Box<RawValue>,
    pub nodes: Box<RawValue>,
    pub concepts: Box<RawValue>,
    pub overseer: Box<RawValue>,
    pub contract: Box<RawValue>,
    pub node: HashMap<String, Box<RawValue>>,
}
