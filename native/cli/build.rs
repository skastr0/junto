//! Builds the corpus `junto` answers with nothing running (help, completions,
//! schema, examples, docs) from the TypeScript that defines it today, through
//! scripts/native-cli-corpus.ts, under this build's feature set: the shipped
//! profile's defines (scripts/build-features.ts), with each one this crate
//! reads (`JUNTO_<NAME>_ENABLED`, src/features.rs) taken from the build's
//! environment. `JUNTO_NATIVE_CORPUS` names a corpus built elsewhere instead.

use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    let out =
        PathBuf::from(std::env::var_os("OUT_DIR").expect("cargo sets OUT_DIR")).join("corpus.json");
    println!("cargo::rerun-if-env-changed=JUNTO_NATIVE_CORPUS");
    if let Some(given) = std::env::var_os("JUNTO_NATIVE_CORPUS") {
        println!("cargo::rerun-if-changed={}", Path::new(&given).display());
        std::fs::copy(&given, &out)
            .unwrap_or_else(|e| panic!("JUNTO_NATIVE_CORPUS {}: {e}", Path::new(&given).display()));
        return;
    }

    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    for watched in [
        "src/cli",
        "src/shared",
        "scripts/native-cli-corpus.ts",
        "scripts/build-features.ts",
        "package.json",
        "bun.lock",
    ] {
        println!("cargo::rerun-if-changed={}", root.join(watched).display());
    }
    println!("cargo::rerun-if-env-changed=JUNTO_FEATURE_PROFILE");
    println!("cargo::rerun-if-env-changed=JUNTO_MACHINE_BUILD");

    let profile = bun(&root, &["scripts/build-features.ts", "--bun-define-args"]);
    let mut args: Vec<String> = String::from_utf8_lossy(&profile)
        .lines()
        .map(|line| define(line.trim()))
        .collect();
    if on(std::env::var("JUNTO_MACHINE_BUILD").ok().as_deref()) {
        args.push("--define=__JUNTO_MACHINE_BUILD__=true".into());
    }
    args.push("scripts/native-cli-corpus.ts".into());
    args.push(out.display().to_string());
    bun(&root, &args.iter().map(String::as_str).collect::<Vec<_>>());
}

/// One profile define, overridden by this crate's variable of the same name.
fn define(line: &str) -> String {
    let Some((key, _)) = line.trim_start_matches("--define=").split_once('=') else {
        return line.to_string();
    };
    let name = key.trim_matches('_');
    if !name.ends_with("_ENABLED") {
        return line.to_string();
    }
    println!("cargo::rerun-if-env-changed={name}");
    match std::env::var(name) {
        Ok(value) => format!("--define={key}={}", on(Some(&value))),
        Err(_) => line.to_string(),
    }
}

/// src/features.rs: `1` or `true` turns a feature on.
fn on(value: Option<&str>) -> bool {
    matches!(value, Some("1" | "true"))
}

fn bun(root: &Path, args: &[&str]) -> Vec<u8> {
    let run = Command::new("bun")
        .args(args)
        .current_dir(root)
        .output()
        .unwrap_or_else(|e| {
            panic!("the native CLI's corpus needs bun on PATH (or JUNTO_NATIVE_CORPUS): {e}")
        });
    if !run.status.success() {
        panic!(
            "bun {}: {}",
            args.join(" "),
            String::from_utf8_lossy(&run.stderr)
        );
    }
    run.stdout
}
