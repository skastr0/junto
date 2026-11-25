//! Embeds what `junto` answers with nothing running that is published
//! outside this crate, read at build time with no TypeScript run: the schemas
//! corpus/schemas.json names (src/contract/work/published), and the docs for
//! this build's features (src/contract/docs/published/<features>/), each
//! written to OUT_DIR as JSON.

use std::path::{Path, PathBuf};

fn main() {
    schemas();
    docs();
}

fn out_dir() -> PathBuf {
    PathBuf::from(std::env::var_os("OUT_DIR").expect("cargo sets OUT_DIR"))
}

fn read(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

/// src/features.rs: `1` or `true` turns a feature on.
fn on(name: &str) -> bool {
    println!("cargo::rerun-if-env-changed={name}");
    matches!(std::env::var(name).ok().as_deref(), Some("1" | "true"))
}

/// A schema corpus/schemas.json names: a work op's, an overseer operation's,
/// or a file of this crate's.
#[derive(serde::Deserialize)]
#[serde(rename_all = "lowercase")]
enum Source {
    Op(String),
    Overseer(String),
    File(String),
}

#[derive(serde::Deserialize)]
struct Named {
    schema: Source,
}

#[derive(serde::Deserialize)]
struct Payload {
    schema: Box<serde_json::value::RawValue>,
}

#[derive(serde::Deserialize)]
struct WorkOp {
    payload: Payload,
}

#[derive(serde::Deserialize)]
struct OverseerOperation {
    args: Payload,
}

/// Writes OUT_DIR/schemas.json: each schema corpus/schemas.json names, by
/// `op:`, `overseer:` or `file:` and its name, read from where it is
/// published. A name that resolves to nothing fails the build, naming it.
fn schemas() {
    let crate_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let published = crate_dir.join("../../src/contract/work/published");
    let catalog = crate_dir.join("corpus/schemas.json");
    for watched in [
        &catalog,
        &published,
        &published.join("overseer"),
        &crate_dir.join("corpus/schemas"),
    ] {
        println!("cargo::rerun-if-changed={}", watched.display());
    }
    let named: Vec<Named> = serde_json::from_str(&read(&catalog))
        .unwrap_or_else(|e| panic!("corpus/schemas.json: {e}"));
    let mut sources = std::collections::BTreeMap::new();
    for Named { schema } in named {
        let (key, path) = match &schema {
            Source::Op(op) => (format!("op:{op}"), published.join(format!("{op}.json"))),
            Source::Overseer(operation) => (
                format!("overseer:{operation}"),
                published.join(format!("overseer/{operation}.json")),
            ),
            Source::File(name) => (
                format!("file:{name}"),
                crate_dir.join("corpus/schemas").join(name),
            ),
        };
        if sources.contains_key(&key) {
            continue;
        }
        let text = read(&path);
        let parsed = match schema {
            Source::Op(_) => serde_json::from_str::<WorkOp>(&text).map(|op| op.payload.schema),
            Source::Overseer(_) => {
                serde_json::from_str::<OverseerOperation>(&text).map(|op| op.args.schema)
            }
            Source::File(_) => serde_json::from_str(&text),
        };
        let schema = parsed.unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        sources.insert(key, schema);
    }
    let text = serde_json::to_string(&sources).expect("raw schemas serialize");
    std::fs::write(out_dir().join("schemas.json"), text).expect("OUT_DIR is writable");
}

#[derive(serde::Serialize)]
struct Docs {
    topics: Box<serde_json::value::RawValue>,
    doctrine: String,
    nodes: String,
    concepts: String,
    node: std::collections::BTreeMap<String, String>,
    taught_roots: Box<serde_json::value::RawValue>,
}

/// Writes OUT_DIR/docs.json: the docs published for this build's tasks,
/// artifacts, browser and authority features (src/contract/docs/publish.ts
/// names a directory by the ones on, or `none`).
fn docs() {
    let gates = [
        ("tasks", "JUNTO_TASKS_ENABLED"),
        ("artifacts", "JUNTO_ARTIFACTS_ENABLED"),
        ("browser", "JUNTO_BROWSER_ENABLED"),
        ("authority", "JUNTO_AUTHORITY_ENABLED"),
    ];
    let named: Vec<&str> = gates
        .iter()
        .filter(|(_, env)| on(env))
        .map(|(name, _)| *name)
        .collect();
    let variant = if named.is_empty() {
        "none".to_string()
    } else {
        named.join("-")
    };
    let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../src/contract/docs/published")
        .join(&variant);
    println!("cargo::rerun-if-changed={}", dir.display());
    let raw = |name: &str| {
        let path = dir.join(name);
        serde_json::from_str(&read(&path)).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
    };
    let node_dir = dir.join("node");
    println!("cargo::rerun-if-changed={}", node_dir.display());
    let node = std::fs::read_dir(&node_dir)
        .unwrap_or_else(|e| panic!("{}: {e}", node_dir.display()))
        .map(|entry| entry.expect("a readable node page").path())
        .filter_map(|path| {
            let kind = path.file_name()?.to_str()?.strip_suffix(".md")?.to_string();
            Some((kind, read(&path)))
        })
        .collect();
    let docs = Docs {
        topics: raw("topics.json"),
        doctrine: read(&dir.join("doctrine.md")),
        nodes: read(&dir.join("nodes.md")),
        concepts: read(&dir.join("concepts.md")),
        node,
        taught_roots: raw("taught-roots.json"),
    };
    let text = serde_json::to_string(&docs).expect("docs serialize");
    std::fs::write(out_dir().join("docs.json"), text).expect("OUT_DIR is writable");
}
