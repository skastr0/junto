//! Help and shell completions, built in so they answer with nothing running,
//! as the TypeScript CLI's parser reads them: `--help` or `-h` anywhere on the
//! line shows the help of the deepest command the words name, and
//! `--completions <shell>` prints the script for that shell. Help wins when
//! both are given, as it is the first action flag Effect's CLI reads. A group
//! named with no subcommand shows its help and fails as ShowHelp, and a shell
//! outside the choices fails as InvalidValue.

mod completions;
pub mod corpus;
mod page;
pub mod tree;

use std::io::{IsTerminal, Write};
use std::process::ExitCode;

use serde_json::{Value, json};

use crate::envelope;
use crate::error::{ErrorType, Failure};
use page::{SHELLS, Style};
use tree::TREE;

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
            let path = walk(words);
            let group = TREE
                .at(path.iter().copied())
                .is_some_and(|command| command.is_group());
            (path.len() == words.len() && group).then_some(Asked::Group)
        }
    }
}

pub fn asked(words: &[&str]) -> bool {
    asked_for(words).is_some()
}

pub fn show(words: &[&str]) -> ExitCode {
    match asked_for(words) {
        Some(Asked::Help) => {
            print(&page(&walk(words)));
            ExitCode::SUCCESS
        }
        Some(Asked::Completions(shell)) => {
            print(&completions::script(shell, &TREE).unwrap_or_default());
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
            let path = walk(words);
            print(&page(&path));
            let command_path: Vec<&str> = std::iter::once("junto").chain(path).collect();
            let failure = Failure::new(ErrorType::ShowHelp, "Help requested")
                .with(json!({ "commandPath": command_path, "errors": [] }));
            envelope::refuse(None, &failure)
        }
        None => ExitCode::SUCCESS,
    }
}

/// A command line the parser refused, as Effect's CLI answers it: the
/// command's help on stdout, then the error under ERROR and a ShowHelp
/// envelope carrying `error` (its `_tag` and fields) on stderr.
pub fn refuse_usage(words: &[&str], message: &str, error: Value) -> ExitCode {
    let path = walk(words);
    print(&page(&path));
    let _ = write!(std::io::stderr(), "\nERROR\n  {message}\n");
    let command_path: Vec<&str> = std::iter::once("junto").chain(path).collect();
    let failure = Failure::new(ErrorType::ShowHelp, "Help requested")
        .with(json!({ "commandPath": command_path, "errors": [error] }));
    envelope::refuse(None, &failure)
}

/// The command path the words name, as `junto task show`.
pub fn command_line(words: &[&str]) -> String {
    std::iter::once("junto")
        .chain(walk(words))
        .collect::<Vec<_>>()
        .join(" ")
}

/// The help of one command path, colored on a terminal.
fn page(path: &[&str]) -> String {
    let style = if colored() {
        Style::COLORED
    } else {
        Style::PLAIN
    };
    // walk only names paths the tree has, so a command is always found.
    TREE.at(path.iter().copied())
        .map(|command| page::render(command, path, style))
        .unwrap_or_default()
}

fn print(text: &str) {
    // A closed pipe has no one left to tell.
    let _ = std::io::stdout().write_all(text.as_bytes());
}

/// The deepest command path the words name: flags are passed over, and the
/// first word that names no subcommand of this build ends the walk.
fn walk<'a>(words: &[&'a str]) -> Vec<&'a str> {
    let mut command = &*TREE;
    let mut path = Vec::new();
    for &word in words.iter().filter(|w| !w.starts_with('-')) {
        let Some(next) = command.subcommand(word) else {
            break;
        };
        command = next;
        path.push(word);
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
    use corpus::DOCS;

    fn registered() -> Vec<String> {
        Root::augment_subcommands(clap::Command::new("junto"))
            .get_subcommands()
            .map(|c| c.get_name().to_string())
            .collect()
    }

    /// The onboard lock: every root command onboard can teach in this build
    /// (src/contract/docs/published/<features>/taught-roots.json) is one the
    /// command tree has, and so, by every_root_command_is_registered, one
    /// this binary parses. The docs do not vary by the machine build: there
    /// onboard teaches no browser command (commands/seat_discovery.rs), and
    /// main.rs answers one with where the browser runs.
    #[test]
    fn every_taught_root_is_a_command_of_this_build() {
        for root in &DOCS.taught_roots {
            if crate::features::MACHINE_BUILD && root == "browser" {
                continue;
            }
            assert!(
                TREE.subcommand(root).is_some(),
                "onboard teaches junto {root}, which corpus/commands.json does not have in this build"
            );
        }
    }

    /// Help and the parser agree: each root command help names is one clap parses.
    #[test]
    fn every_root_command_is_registered() {
        let registered = registered();
        for root in TREE.subcommands() {
            assert!(
                registered.contains(&root.name),
                "junto {} has help but no command",
                root.name
            );
        }
    }

    #[test]
    fn help_follows_subcommands_past_flags_and_stops_at_an_argument() {
        let path = |words: &[&str]| walk(words).join(" ");
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
