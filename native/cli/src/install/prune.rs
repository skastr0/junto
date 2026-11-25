//! Old build directories under an install, and how they are removed
//! (docs/machines.md, Installing and updating a machine): never
//! the current build, the build it replaced, or a directory a live process runs
//! from. The live set is read from the host's own process table, and a table
//! that cannot be read prunes nothing. The copy is best effort after ready.

use std::fs;
use std::path::Path;
use std::time::Duration;

use super::Refused;
use super::run;

fn is_generation(name: &str) -> bool {
    ["-darwin-arm64", "-linux-x64"]
        .iter()
        .find_map(|suffix| name.strip_suffix(suffix))
        .is_some_and(|hash| {
            hash.len() == 64
                && hash
                    .chars()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&(c as u8)))
        })
}

fn live_commands() -> Option<Vec<String>> {
    let completed = run::bounded(
        "ps",
        &["-axo", "command="],
        &[],
        Duration::from_secs(5),
        4 * 1024 * 1024,
    )
    .ok()?;
    if completed.timed_out || completed.status != Some(0) {
        return None;
    }
    Some(
        completed
            .stdout
            .split('\n')
            .filter(|line| !line.is_empty())
            .map(str::to_string)
            .collect(),
    )
}

/// A kept name as the directory holds it: a caller may pass the selection path
/// ("builds/<name>") or the bare generation name, and both mean the same build.
fn bare(name: &str) -> &str {
    name.strip_prefix("builds/").unwrap_or(name)
}

/// Removes every generation not kept and not running; answers the names removed.
pub fn prune_machine_builds(install_root: &Path, keep: &[String]) -> Result<Vec<String>, Refused> {
    let builds = install_root.join("builds");
    let keep: Vec<&str> = keep.iter().map(|name| bare(name)).collect();
    let entries = match fs::read_dir(&builds) {
        Ok(entries) => entries,
        Err(_) => return Ok(Vec::new()),
    };
    let mut candidates = Vec::new();
    for entry in entries {
        let entry = entry.map_err(Refused::from)?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let metadata = fs::symlink_metadata(entry.path()).ok();
        let is_directory = metadata.is_some_and(|metadata| metadata.is_dir());
        if is_directory && is_generation(&name) && !keep.contains(&name.as_str()) {
            candidates.push(name);
        }
    }
    if candidates.is_empty() {
        return Ok(Vec::new());
    }
    // Unknown processes are not proof a directory is unused: prune nothing.
    let Some(live) = live_commands() else {
        return Ok(Vec::new());
    };
    let mut removed = Vec::new();
    for name in candidates {
        let directory = builds.join(&name);
        let text = directory.to_string_lossy();
        if live.iter().any(|command| command.contains(text.as_ref())) {
            continue;
        }
        let _ = fs::remove_dir_all(&directory);
        removed.push(name);
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;

    fn scratch(name: &str) -> PathBuf {
        let directory =
            super::super::paths::home().join(format!(".junto-prune-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(directory.join("builds")).expect("a builds directory");
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).expect("private");
        directory
    }

    #[test]
    fn only_generations_outside_the_kept_set_are_removed() {
        let root = scratch("keep");
        let current = format!("{}-linux-x64", "a".repeat(64));
        let previous = format!("{}-linux-x64", "b".repeat(64));
        let old = format!("{}-linux-x64", "c".repeat(64));
        for name in [&current, &previous, &old] {
            fs::create_dir(root.join("builds").join(name)).expect("a generation");
        }
        fs::create_dir(root.join("builds").join("not-a-generation")).expect("a directory");
        // The kept set as an install names it: one with the selection path, one
        // bare. Both are that build's own directory name.
        let removed = prune_machine_builds(&root, &[format!("builds/{current}"), previous.clone()])
            .expect("pruned");
        for name in [&current, &previous] {
            assert!(
                root.join("builds").join(name).is_dir(),
                "{name} was removed"
            );
        }
        assert_eq!(removed, vec![old.clone()]);
        assert!(root.join("builds").join("not-a-generation").is_dir());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_generation_a_live_process_names_is_never_removed() {
        let root = scratch("live");
        let running = format!("{}-linux-x64", "d".repeat(64));
        let directory = root.join("builds").join(&running);
        fs::create_dir(&directory).expect("a generation");
        let marker = directory.join("running");
        fs::write(&marker, "x").expect("a file");
        // A process whose command line names the directory, as a core runs from it.
        let mut child = std::process::Command::new("/usr/bin/tail")
            .args(["-f", marker.to_string_lossy().as_ref()])
            .stdout(std::process::Stdio::null())
            .spawn()
            .expect("a live process naming the directory");
        std::thread::sleep(std::time::Duration::from_millis(300));
        let removed = prune_machine_builds(&root, &[]).expect("pruned");
        assert!(!removed.contains(&running), "{removed:?}");
        assert!(directory.is_dir());
        let _ = child.kill();
        let _ = child.wait();
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn generation_names_are_a_build_and_a_target() {
        assert!(is_generation(&format!("{}-darwin-arm64", "f".repeat(64))));
        assert!(!is_generation(&format!("{}-linux-arm64", "f".repeat(64))));
        assert!(!is_generation(&format!("{}-linux-x64", "F".repeat(64))));
        assert!(!is_generation("incoming-1"));
    }
}
