//! Help and shell completions, built in so they answer with nothing running,
//! as the TypeScript CLI's parser reads them: `--help` or `-h` anywhere on the
//! line shows the help of the deepest command the words name, and
//! `--completions <shell>` prints the script for that shell. Help wins when
//! both are given, as it is the first action flag Effect's CLI reads. A group
//! named with no subcommand shows its help and fails as ShowHelp, and a shell
//! outside the choices fails as InvalidValue.

pub mod corpus;

use std::io::{IsTerminal, Write};
use std::process::ExitCode;

use serde_json::json;

use crate::envelope;
use crate::error::{ErrorType, Failure};
use corpus::CORPUS;

/// The shells `--completions` takes.
const SHELLS: [&str; 4] = ["bash", "zsh", "fish", "sh"];

/// What the words ask for before any command runs.
enum Asked<'a> {
    Help,
    Completions(&'a str),
    UnknownShell(&'a str),
    /// A group and nothing more: `junto`, `junto msg`.
    Group,
}

fn asked_for<'a>(words: &[&'a str]) -> Option<Asked<'a>> {
    if words.iter().any(|w| matches!(*w, "--help" | "-h")) {
        return Some(Asked::Help);
    }
    // A missing shell falls through to the parser's refusal.
    let shell =
        words
            .iter()
            .enumerate()
            .find_map(|(at, word)| match word.strip_prefix("--completions") {
                Some("") => words.get(at + 1).copied(),
                Some(value) => value.strip_prefix('='),
                None => None,
            });
    match shell {
        Some(shell) if SHELLS.contains(&shell) => Some(Asked::Completions(shell)),
        Some(shell) if !shell.is_empty() => Some(Asked::UnknownShell(shell)),
        Some(_) => None,
        None => {
            let (path, named) = walk(words);
            let group = CORPUS
                .help
                .get(path.as_str())
                .is_some_and(|page| !page.subcommands.is_empty());
            (named == words.len() && group).then_some(Asked::Group)
        }
    }
}

pub fn asked(words: &[&str]) -> bool {
    asked_for(words).is_some()
}

pub fn show(words: &[&str]) -> ExitCode {
    match asked_for(words) {
        Some(Asked::Help) => {
            print(page(&walk(words).0));
            ExitCode::SUCCESS
        }
        Some(Asked::Completions(shell)) => {
            print(
                CORPUS
                    .completions
                    .get(shell)
                    .map(String::as_str)
                    .unwrap_or_default(),
            );
            ExitCode::SUCCESS
        }
        Some(Asked::UnknownShell(shell)) => {
            let expected = SHELLS.map(|s| format!("\"{s}\"")).join(" | ");
            let failure = Failure::new(
                ErrorType::InvalidValue,
                format!("Invalid value for flag --completions: \"{shell}\". Expected: {expected}"),
            )
            .with(json!({ "option": "completions", "value": shell, "expected": expected, "kind": "flag" }));
            envelope::refuse(None, &failure)
        }
        Some(Asked::Group) => {
            let path = walk(words).0;
            print(page(&path));
            let command_path: Vec<&str> = std::iter::once("junto")
                .chain(path.split_whitespace())
                .collect();
            let failure = Failure::new(ErrorType::ShowHelp, "Help requested")
                .with(json!({ "commandPath": command_path, "errors": [] }));
            envelope::refuse(None, &failure)
        }
        None => ExitCode::SUCCESS,
    }
}

/// The help of one command path, colored as Effect's formatter would color it here.
fn page(path: &str) -> &'static str {
    // walk only names paths the corpus lists, so a page is always found.
    CORPUS
        .help
        .get(path)
        .map_or("", |page| if colored() { &page.color } else { &page.plain })
}

fn print(text: &str) {
    // A closed pipe has no one left to tell.
    let _ = std::io::stdout().write_all(text.as_bytes());
}

/// The deepest command path the words name, and how many words named it:
/// flags are passed over, and the first word that names no subcommand ends
/// the walk.
fn walk(words: &[&str]) -> (String, usize) {
    let mut path = String::new();
    let mut named = 0;
    for word in words.iter().filter(|w| !w.starts_with('-')) {
        let next = CORPUS
            .help
            .get(path.as_str())
            .is_some_and(|page| page.subcommands.iter().any(|s| s == word));
        if !next {
            break;
        }
        if !path.is_empty() {
            path.push(' ');
        }
        path.push_str(word);
        named += 1;
    }
    (path, named)
}

/// Effect's formatter colors help on a terminal unless NO_COLOR is 1.
fn colored() -> bool {
    std::io::stdout().is_terminal() && std::env::var_os("NO_COLOR").is_none_or(|v| v != "1")
}

#[cfg(test)]
mod tests {
    use clap::Subcommand;

    use super::*;
    use crate::commands::Root;

    fn registered() -> Vec<String> {
        Root::augment_subcommands(clap::Command::new("junto"))
            .get_subcommands()
            .map(|c| c.get_name().to_string())
            .collect()
    }

    /// The onboard lock (tests/seat-onboarding.test.ts): every root command
    /// onboard can teach is one this binary registers.
    #[test]
    fn every_taught_root_is_registered() {
        let registered = registered();
        for root in &CORPUS.taught_roots {
            assert!(
                registered.contains(root),
                "onboard teaches junto {root}, which this binary does not register"
            );
        }
    }

    /// Help and the parser agree: each root command help names is one clap parses.
    #[test]
    fn every_root_command_is_registered() {
        let registered = registered();
        for root in &CORPUS.root_commands {
            assert!(
                registered.contains(root),
                "junto {root} has help but no command"
            );
        }
    }

    #[test]
    fn help_follows_subcommands_past_flags_and_stops_at_an_argument() {
        let path = |words: &[&str]| walk(words).0;
        assert_eq!(path(&["msg", "send", "{}", "--help"]), "msg send");
        assert_eq!(path(&["-h", "docs", "list"]), "docs list");
        assert_eq!(path(&["docs", "--timeout", "5", "list", "-h"]), "docs");
        assert_eq!(path(&["nope", "--help"]), "");
    }

    #[test]
    fn help_wins_over_completions_and_an_unknown_shell_is_not_asked() {
        assert!(matches!(
            asked_for(&["--completions", "zsh", "--help"]),
            Some(Asked::Help)
        ));
        assert!(matches!(
            asked_for(&["--completions=fish"]),
            Some(Asked::Completions("fish"))
        ));
        assert!(matches!(
            asked_for(&["--completions", "nope"]),
            Some(Asked::UnknownShell("nope"))
        ));
        assert!(asked_for(&["--completions"]).is_none());
    }

    #[test]
    fn a_bare_group_asks_for_its_help_and_a_command_does_not() {
        assert!(matches!(asked_for(&[]), Some(Asked::Group)));
        assert!(matches!(asked_for(&["msg"]), Some(Asked::Group)));
        assert!(asked_for(&["msg", "nope"]).is_none());
        assert!(asked_for(&["msg", "--timeout", "5"]).is_none());
        assert!(asked_for(&["docs", "list"]).is_none());
    }
}
