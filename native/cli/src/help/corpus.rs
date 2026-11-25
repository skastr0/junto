//! The docs `junto` answers with nothing running, built by build.rs from the
//! TypeScript that defines them today (scripts/native-cli-corpus.ts), each as
//! the JSON its command's `data` is. Help, completions, schemas and examples
//! are this crate's own (src/help/tree.rs, src/catalog.rs).

use std::collections::HashMap;
use std::sync::LazyLock;

use serde::Deserialize;
use serde_json::value::RawValue;

static TEXT: &str = include_str!(concat!(env!("OUT_DIR"), "/corpus.json"));

/// Parsed on first use; the build wrote it, so a corpus that does not parse
/// is a broken build, not input.
pub static CORPUS: LazyLock<Corpus> =
    LazyLock::new(|| serde_json::from_str(TEXT).expect("the corpus build.rs wrote parses"));

#[derive(Deserialize)]
pub struct Corpus {
    /// Every root command onboard can teach in this build.
    #[cfg(test)]
    pub taught_roots: Vec<String>,
    pub docs: Docs,
}

#[derive(Deserialize)]
pub struct Docs {
    pub list: Box<RawValue>,
    pub doctrine: Box<RawValue>,
    pub nodes: Box<RawValue>,
    pub concepts: Box<RawValue>,
    pub contract: Box<RawValue>,
    pub node: HashMap<String, Box<RawValue>>,
}
