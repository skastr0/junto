//! The command tree `junto` documents itself from: corpus/commands.json,
//! this crate's own data. Help pages and completion scripts are rendered from
//! it, so the two always name the same commands, arguments and flags.
//!
//! A command, or a piece of its text, can depend on a product feature: it is
//! there only when every gate it names is on in this build (src/features.rs).

use std::sync::LazyLock;

use serde::Deserialize;

use crate::features;

static SOURCE: &str = include_str!("../../corpus/commands.json");

/// Parsed on first use: the file ships inside the binary, so one that does
/// not parse is a broken build, not input. A cargo test parses it.
pub static TREE: LazyLock<Command> =
    LazyLock::new(|| serde_json::from_str(SOURCE).expect("corpus/commands.json parses"));

/// A product feature a command or a piece of text depends on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Gate {
    Tasks,
    Artifacts,
    Browser,
    Authority,
    Vault,
    CodeSteps,
    /// The desktop's CLI, not a Junto Remote machine's.
    Desktop,
}

impl Gate {
    pub fn on(self) -> bool {
        match self {
            Gate::Tasks => features::TASKS,
            Gate::Artifacts => features::ARTIFACTS,
            Gate::Browser => features::BROWSER,
            Gate::Authority => features::AUTHORITY,
            Gate::Vault => features::VAULT,
            Gate::CodeSteps => features::CODE_STEPS,
            Gate::Desktop => !features::MACHINE_BUILD,
        }
    }
}

fn all_on(gates: &[Gate]) -> bool {
    gates.iter().all(|gate| gate.on())
}

/// Words, whole or in pieces some of which depend on a feature.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum Text {
    Whole(String),
    Pieces(Vec<Piece>),
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum Piece {
    Always(String),
    Gated { text: String, when: Vec<Gate> },
}

impl Text {
    /// The words this build says.
    pub fn said(&self) -> String {
        match self {
            Text::Whole(text) => text.clone(),
            Text::Pieces(pieces) => pieces
                .iter()
                .filter_map(|piece| match piece {
                    Piece::Always(text) => Some(text.as_str()),
                    Piece::Gated { text, when } => all_on(when).then_some(text.as_str()),
                })
                .collect(),
        }
    }

    /// Every piece, said or not: what a check over all the text reads.
    #[cfg(test)]
    pub fn every_piece(&self) -> Vec<&str> {
        match self {
            Text::Whole(text) => vec![text],
            Text::Pieces(pieces) => pieces
                .iter()
                .map(|piece| match piece {
                    Piece::Always(text) | Piece::Gated { text, .. } => text.as_str(),
                })
                .collect(),
        }
    }
}

/// What a value is, as help names its type and a shell completes it.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    String,
    Integer,
    Boolean,
    Choice(Vec<String>),
}

impl Kind {
    /// The type help prints beside a flag or an argument.
    pub fn type_name(&self) -> &'static str {
        match self {
            Kind::String => "string",
            Kind::Integer => "integer",
            Kind::Boolean => "boolean",
            Kind::Choice(_) => "choice",
        }
    }

    pub fn choices(&self) -> Option<&[String]> {
        match self {
            Kind::Choice(values) => Some(values),
            _ => None,
        }
    }
}

/// A positional argument.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Arg {
    pub name: String,
    pub kind: Kind,
    pub description: Option<Text>,
    #[serde(default)]
    pub optional: bool,
}

/// A `--name` flag.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Flag {
    pub name: String,
    pub kind: Kind,
    pub description: Option<Text>,
}

impl Flag {
    /// Whether the flag reads the next word as its value.
    pub fn takes_value(&self) -> bool {
        !matches!(self.kind, Kind::Boolean)
    }

    /// The name that turns a switch off, as `no-prompt` turns off `--prompt`.
    pub fn negation(&self) -> Option<String> {
        (!self.takes_value()).then(|| format!("no-{}", self.name))
    }

    /// Every way to write the flag on a command line: `--name`, and `--no-name` for a switch.
    pub fn forms(&self) -> Vec<String> {
        std::iter::once(format!("--{}", self.name))
            .chain(self.negation().map(|negation| format!("--{negation}")))
            .collect()
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Command {
    pub name: String,
    #[serde(default)]
    when: Vec<Gate>,
    description: Option<Text>,
    #[serde(default)]
    pub args: Vec<Arg>,
    #[serde(default)]
    pub flags: Vec<Flag>,
    #[serde(default)]
    commands: Vec<Command>,
}

impl Command {
    /// Whether this build has the command.
    pub fn enabled(&self) -> bool {
        all_on(&self.when)
    }

    /// The command's description in this build; empty when it has none.
    pub fn description(&self) -> String {
        self.description
            .as_ref()
            .map(Text::said)
            .unwrap_or_default()
    }

    /// The subcommands this build has, in order.
    pub fn subcommands(&self) -> impl Iterator<Item = &Command> {
        self.commands.iter().filter(|command| command.enabled())
    }

    pub fn subcommand(&self, name: &str) -> Option<&Command> {
        self.subcommands().find(|command| command.name == name)
    }

    pub fn is_group(&self) -> bool {
        self.subcommands().next().is_some()
    }

    /// The command a path of words names in this build, the root for none.
    pub fn at<'a>(&self, path: impl IntoIterator<Item = &'a str>) -> Option<&Command> {
        path.into_iter()
            .try_fold(self, |command, word| command.subcommand(word))
    }

    /// Every command in the file, enabled or not, with its path: what a
    /// check over the whole tree walks.
    #[cfg(test)]
    pub fn every(&self) -> Vec<(String, &Command)> {
        fn walk<'a>(command: &'a Command, path: String, out: &mut Vec<(String, &'a Command)>) {
            for sub in &command.commands {
                let path = if path.is_empty() {
                    sub.name.clone()
                } else {
                    format!("{path} {}", sub.name)
                };
                out.push((path.clone(), sub));
                walk(sub, path, out);
            }
        }
        let mut out = vec![(String::new(), self)];
        walk(self, String::new(), &mut out);
        out
    }

    #[cfg(test)]
    pub fn texts(&self) -> Vec<&Text> {
        self.description
            .iter()
            .chain(self.args.iter().filter_map(|arg| arg.description.as_ref()))
            .chain(
                self.flags
                    .iter()
                    .filter_map(|flag| flag.description.as_ref()),
            )
            .collect()
    }

    #[cfg(test)]
    pub fn gates(&self) -> &[Gate] {
        &self.when
    }
}

impl Arg {
    pub fn description(&self) -> String {
        self.description
            .as_ref()
            .map(Text::said)
            .unwrap_or_default()
    }
}

impl Flag {
    pub fn description(&self) -> String {
        self.description
            .as_ref()
            .map(Text::said)
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::*;

    #[test]
    fn the_tree_parses_and_is_rooted_at_junto() {
        assert_eq!(TREE.name, "junto");
        assert!(TREE.is_group());
    }

    /// Characters past ASCII that help may say. Each is one terminal cell
    /// as Effect's displayWidth measures it (not a mark, control, default
    /// ignorable or emoji, and outside its full-width ranges), as the page
    /// renderer counts it: check one against CliOutput.ts before adding it.
    const NARROW: [char; 1] = ['—'];

    fn one_cell(c: char) -> bool {
        c == ' ' || c.is_ascii_graphic() || NARROW.contains(&c)
    }

    /// Help pads its columns by counting characters, so every character the
    /// tree says must fill exactly one terminal cell.
    #[test]
    fn every_character_is_one_cell_wide() {
        for (path, command) in TREE.every() {
            for text in command.texts() {
                for piece in text.every_piece() {
                    if let Some(c) = piece.chars().find(|&c| !one_cell(c)) {
                        panic!("junto {path}: {c:?} is not known to be one cell wide");
                    }
                }
            }
        }
    }

    #[test]
    fn names_are_unique_among_siblings_and_flags_of_a_command() {
        for (path, command) in TREE.every() {
            let mut seen = HashSet::new();
            for sub in &command.commands {
                assert!(
                    seen.insert(&sub.name),
                    "junto {path} names {} twice",
                    sub.name
                );
            }
            let mut flags = HashSet::new();
            for flag in &command.flags {
                assert!(
                    flags.insert(&flag.name),
                    "junto {path} has --{} twice",
                    flag.name
                );
            }
        }
    }

    /// A command gated off in this build is not found, nor is anything under
    /// it; one gated on is.
    #[test]
    fn a_gated_command_is_there_exactly_when_its_gates_are_on() {
        for (path, command) in TREE.every().into_iter().skip(1) {
            let words: Vec<&str> = path.split(' ').collect();
            let ancestors_on =
                (1..words.len()).all(|end| TREE.at(words[..end].iter().copied()).is_some());
            let found = TREE.at(words.iter().copied()).is_some();
            assert_eq!(
                found,
                ancestors_on && command.gates().iter().all(|gate| gate.on()),
                "junto {path}"
            );
        }
    }

    #[test]
    fn a_gated_piece_is_said_exactly_when_its_gates_are_on() {
        let text: Text = serde_json::from_value(serde_json::json!([
            "always ",
            { "text": "desktop ", "when": ["desktop"] },
            { "text": "vault ", "when": ["vault"] },
            { "text": "both", "when": ["desktop", "vault"] },
        ]))
        .expect("text");
        let mut want = String::from("always ");
        if Gate::Desktop.on() {
            want.push_str("desktop ");
        }
        if Gate::Vault.on() {
            want.push_str("vault ");
        }
        if Gate::Desktop.on() && Gate::Vault.on() {
            want.push_str("both");
        }
        assert_eq!(text.said(), want);
    }
}
