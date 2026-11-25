//! A command's help page, rendered from the tree in the layout `junto` has
//! always printed (Effect CLI's): DESCRIPTION, USAGE, ARGUMENTS, FLAGS,
//! GLOBAL FLAGS and SUBCOMMANDS, each a two-column table, colored on a
//! terminal. The global flags are the three this CLI answers itself.

use super::tree::{Command, Kind};

/// Every character help is written in fills one terminal cell (a cargo test
/// holds the tree to it), so a width is a count of characters.
fn width(text: &str) -> usize {
    text.chars().count()
}

/// Styles for one page: ANSI on a terminal, nothing elsewhere.
#[derive(Clone, Copy)]
pub struct Style {
    colored: bool,
}

impl Style {
    pub const PLAIN: Style = Style { colored: false };
    pub const COLORED: Style = Style { colored: true };

    fn paint(self, code: &str, text: &str) -> String {
        if self.colored {
            format!("\x1b[{code}m{text}\x1b[0m")
        } else {
            text.to_string()
        }
    }

    fn bold(self, text: &str) -> String {
        self.paint("1", text)
    }

    fn dim(self, text: &str) -> String {
        self.paint("2", text)
    }

    fn cyan(self, text: &str) -> String {
        self.paint("36", text)
    }

    fn green(self, text: &str) -> String {
        self.paint("32", text)
    }
}

/// One table row: the left column as printed, its width unstyled, and the right.
struct Row {
    left: String,
    left_width: usize,
    right: String,
}

/// Two aligned columns: the left padded to its widest plus four, at most
/// `cap` when given, and always at least one space past its own text.
fn table(rows: &[Row], cap: Option<usize>) -> String {
    let widest = rows.iter().map(|row| row.left_width).max().unwrap_or(0) + 4;
    let column = cap.map_or(widest, |cap| widest.min(cap));
    rows.iter()
        .map(|row| {
            let padding = column.max(row.left_width + 1) - row.left_width;
            format!("  {}{}{}", row.left, " ".repeat(padding), row.right)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// A flag as help lists it: its names, its type unless it is a switch, and
/// what it does, closed by its choices when it has some.
struct FlagLine {
    names: Vec<String>,
    type_name: Option<&'static str>,
    description: String,
}

impl FlagLine {
    fn row(&self, style: Style) -> Row {
        let names = self
            .names
            .iter()
            .map(|name| style.green(name))
            .collect::<Vec<_>>()
            .join(", ");
        let names_width = width(&self.names.join(", "));
        match self.type_name {
            Some(type_name) => Row {
                left: format!("{names} {}", style.dim(type_name)),
                left_width: names_width + 1 + width(type_name),
                right: self.description.clone(),
            },
            None => Row {
                left: names,
                left_width: names_width,
                right: self.description.clone(),
            },
        }
    }
}

/// The shells `--completions` writes a script for.
pub const SHELLS: [&str; 4] = ["bash", "zsh", "fish", "sh"];

fn global_flags() -> Vec<FlagLine> {
    let names = |names: &[&str]| names.iter().map(|name| name.to_string()).collect();
    vec![
        FlagLine {
            names: names(&["--help", "-h"]),
            type_name: None,
            description: "Show help information".into(),
        },
        FlagLine {
            names: names(&["--version", "-v"]),
            type_name: None,
            description: "Show version information".into(),
        },
        FlagLine {
            names: names(&["--completions"]),
            type_name: Some("<bash|zsh|fish|sh>"),
            description: format!(
                "Print shell completion script (choices: {})",
                SHELLS.join(", ")
            ),
        },
    ]
}

fn with_choices(description: String, kind: &Kind) -> String {
    match kind.choices() {
        None => description,
        Some(values) => {
            let choices = format!("(choices: {})", values.join(", "));
            if description.is_empty() {
                choices
            } else {
                format!("{description} {choices}")
            }
        }
    }
}

/// The help page of `command`, found at `path` under the root.
pub fn render(command: &Command, path: &[&str], style: Style) -> String {
    let mut sections: Vec<String> = Vec::new();

    let description = command.description();
    if !description.is_empty() {
        sections.extend([
            style.bold("DESCRIPTION"),
            format!("  {description}"),
            String::new(),
        ]);
    }

    let mut usage = std::iter::once("junto")
        .chain(path.iter().copied())
        .collect::<Vec<_>>()
        .join(" ");
    if command.is_group() {
        usage.push_str(" <subcommand>");
    }
    usage.push_str(" [flags]");
    for arg in &command.args {
        if arg.optional {
            usage.push_str(&format!(" [<{}>]", arg.name));
        } else {
            usage.push_str(&format!(" <{}>", arg.name));
        }
    }
    sections.extend([
        style.bold("USAGE"),
        format!("  {}", style.cyan(&usage)),
        String::new(),
    ]);

    if !command.args.is_empty() {
        let rows: Vec<Row> = command
            .args
            .iter()
            .map(|arg| {
                let type_name = arg.kind.type_name();
                let optional = if arg.optional {
                    style.dim(" (optional)")
                } else {
                    String::new()
                };
                Row {
                    left: format!("{} {}", style.green(&arg.name), style.dim(type_name)),
                    left_width: width(&arg.name) + 1 + width(type_name),
                    right: format!("{}{optional}", arg.description()),
                }
            })
            .collect();
        sections.extend([
            style.bold("ARGUMENTS"),
            table(&rows, Some(25)),
            String::new(),
        ]);
    }

    let flag_section = |title: &str, lines: &[FlagLine], sections: &mut Vec<String>| {
        let rows: Vec<Row> = lines.iter().map(|line| line.row(style)).collect();
        sections.extend([style.bold(title), table(&rows, None), String::new()]);
    };
    if !command.flags.is_empty() {
        let lines: Vec<FlagLine> = command
            .flags
            .iter()
            .map(|flag| FlagLine {
                names: vec![format!("--{}", flag.name)],
                type_name: flag.takes_value().then(|| flag.kind.type_name()),
                description: with_choices(flag.description(), &flag.kind),
            })
            .collect();
        flag_section("FLAGS", &lines, &mut sections);
    }
    flag_section("GLOBAL FLAGS", &global_flags(), &mut sections);

    let subcommands: Vec<Row> = command
        .subcommands()
        .map(|sub| Row {
            left: style.cyan(&sub.name),
            left_width: width(&sub.name),
            right: sub.description(),
        })
        .collect();
    if !subcommands.is_empty() {
        sections.extend([style.bold("SUBCOMMANDS"), table(&subcommands, Some(20))]);
    }

    if sections.last().is_some_and(String::is_empty) {
        sections.pop();
    }
    // Printed as Console.log prints it: one line feed after.
    format!("{}\n", sections.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::help::tree::TREE;

    fn page(path: &[&str], style: Style) -> String {
        render(TREE.at(path.iter().copied()).expect("command"), path, style)
    }

    /// Colored as Effect's formatter colors the same page with this CLI's
    /// global flags (fixtures captured from it): arguments with an optional
    /// one, a switch, valued flags, and the globals.
    #[test]
    fn a_command_page_is_colored_as_it_always_was() {
        assert_eq!(
            page(&["msg", "send"], Style::COLORED),
            include_str!("fixtures/msg-send.color.txt")
        );
    }

    #[test]
    fn a_group_page_lists_its_subcommands_colored_as_it_always_was() {
        assert_eq!(
            page(&["msg"], Style::COLORED),
            include_str!("fixtures/msg.color.txt")
        );
    }

    #[test]
    fn a_plain_page_is_the_colored_one_without_its_escapes() {
        let colored = page(&["msg", "send"], Style::COLORED);
        let mut stripped = String::new();
        let mut rest = colored.as_str();
        while let Some(at) = rest.find('\x1b') {
            stripped.push_str(&rest[..at]);
            rest = &rest[at..];
            rest = &rest[rest.find('m').map_or(rest.len(), |end| end + 1)..];
        }
        stripped.push_str(rest);
        assert_eq!(page(&["msg", "send"], Style::PLAIN), stripped);
    }

    #[test]
    fn a_choice_flag_names_its_choices_after_what_it_does() {
        let help = page(&["thread", "list"], Style::PLAIN);
        let line = help
            .lines()
            .find(|line| line.trim_start().starts_with("--group"))
            .expect("--group");
        assert!(line.ends_with("(choices: with-you, between)"), "{line}");
    }

    #[test]
    fn the_global_flags_are_this_clis_own() {
        let help = page(&[], Style::PLAIN);
        for absent in ["--wizard", "--log-level", "powershell", "pwsh"] {
            assert!(!help.contains(absent), "{absent} is the TypeScript CLI's");
        }
        assert!(help.contains("--completions <bash|zsh|fish|sh>"));
    }
}
