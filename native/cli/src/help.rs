//! Help and shell completions, built in so they answer with nothing running,
//! as the TypeScript CLI's parser reads them: `--help` or `-h` anywhere on the
//! line shows the help of the deepest command the words name, and
//! `--completions <shell>` prints the script for that shell. Help wins when
//! both are given, as it is the first action flag Effect's CLI reads.

pub mod corpus;

use std::io::{IsTerminal, Write};
use std::process::ExitCode;

use corpus::CORPUS;

/// The shells `--completions` takes.
const SHELLS: [&str; 4] = ["bash", "zsh", "fish", "sh"];

/// What the words ask for before any command runs.
enum Asked<'a> {
    Help,
    Completions(&'a str),
}

fn asked_for<'a>(words: &[&'a str]) -> Option<Asked<'a>> {
    if words.iter().any(|w| matches!(*w, "--help" | "-h")) {
        return Some(Asked::Help);
    }
    // A shell this build does not know falls through to the parser's refusal.
    let shell = words.iter().enumerate().find_map(|(at, word)| {
        match word.strip_prefix("--completions") {
            Some("") => words.get(at + 1).copied(),
            Some(value) => value.strip_prefix('='),
            None => None,
        }
    })?;
    SHELLS.contains(&shell).then_some(Asked::Completions(shell))
}

pub fn asked(words: &[&str]) -> bool {
    asked_for(words).is_some()
}

pub fn show(words: &[&str]) -> ExitCode {
    let text = match asked_for(words) {
        Some(Asked::Completions(shell)) => CORPUS.completions.get(shell).map(String::as_str),
        Some(Asked::Help) => {
            let page = &CORPUS.help[path(words).as_str()];
            Some(if colored() {
                page.color.as_str()
            } else {
                page.plain.as_str()
            })
        }
        None => None,
    };
    // A closed pipe has no one left to tell.
    let _ = std::io::stdout().write_all(text.unwrap_or_default().as_bytes());
    ExitCode::SUCCESS
}

/// The deepest command path the words name: flags are passed over, and the
/// first word that names no subcommand ends the walk.
fn path(words: &[&str]) -> String {
    let mut path = String::new();
    for word in words.iter().filter(|w| !w.starts_with('-')) {
        let named = CORPUS
            .help
            .get(path.as_str())
            .is_some_and(|page| page.subcommands.iter().any(|s| s == word));
        if !named {
            break;
        }
        if !path.is_empty() {
            path.push(' ');
        }
        path.push_str(word);
    }
    path
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
        assert!(asked_for(&["--completions", "nope"]).is_none());
        assert!(asked_for(&["--completions"]).is_none());
    }
}
