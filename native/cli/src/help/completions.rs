//! `junto --completions <shell>`: a static completion script rendered from
//! the tree, in the form `junto` has always printed (Effect CLI's
//! generators). `sh` is the bash script.

use super::tree::{Command, Flag, Kind};

/// The bash helpers every script carries before its functions: word
/// splitting, and completing a choice or a path inside quotes.
const BASH_HELPERS: &str = include_str!("../../corpus/completions/bash-helpers.sh");

/// The script for one shell, or None for a shell this CLI does not write.
pub fn script(shell: &str, root: &Command) -> Option<String> {
    let text = match shell {
        "bash" | "sh" => bash(root),
        "zsh" => zsh(root),
        "fish" => fish(root),
        _ => return None,
    };
    // Printed as Console.log prints it: one line feed after.
    Some(format!("{text}\n"))
}

/// A function name made of a command path: anything but a word character is `_`.
fn function_name(path: &[&str]) -> String {
    let sanitized: Vec<String> = path
        .iter()
        .map(|word| {
            word.chars()
                .map(|c| {
                    if c.is_ascii_alphanumeric() || c == '_' {
                        c
                    } else {
                        '_'
                    }
                })
                .collect()
        })
        .collect();
    format!("_{}", sanitized.join("_"))
}

/// A choice as zsh and fish quote it: anything outside a safe set is escaped with a backslash.
fn escape_choice(value: &str) -> String {
    value
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || "_.,/@%+-".contains(c) {
                c.to_string()
            } else {
                format!("\\{c}")
            }
        })
        .collect()
}

fn described(command: &Command) -> Option<String> {
    Some(command.description()).filter(|text| !text.is_empty())
}

fn flag_described(flag: &Flag) -> Option<String> {
    Some(flag.description()).filter(|text| !text.is_empty())
}

// ---- bash ----------------------------------------------------------------

fn escape_bash(text: &str) -> String {
    text.replace('\'', "'\\''")
}

fn bash_choices(kind: &Kind) -> Option<String> {
    let values = kind.choices()?;
    let quoted: Vec<String> = values
        .iter()
        .map(|value| format!("'{}'", escape_bash(value)))
        .collect();
    Some(format!(
        "_junto--choices \"$cur\" \"$_comp_word\" {}",
        quoted.join(" ")
    ))
}

fn bash(root: &Command) -> String {
    let mut lines: Vec<String> = Vec::new();
    bash_function(root, &[], &mut lines);
    lines.push("complete -F _junto junto".into());
    lines.push("###-end-junto-completions-###".into());
    let header = [
        "###-begin-junto-completions-###",
        "#",
        "# Static completion script for Bash",
        "#",
        "# Installation:",
        "#   junto --completions bash >> ~/.bashrc",
        "#",
        "",
    ];
    format!("{}\n{BASH_HELPERS}{}", header.join("\n"), lines.join("\n"))
}

fn bash_function(command: &Command, parent: &[&str], lines: &mut Vec<String>) {
    let path: Vec<&str> = parent
        .iter()
        .copied()
        .chain([command.name.as_str()])
        .collect();
    let mut push = |line: String| lines.push(line);
    push(format!("{}()", function_name(&path)));
    push("{".into());
    push("  local cur prev words cword i".into());
    push(if parent.is_empty() {
        "  local _command_index=0".into()
    } else {
        "  local _command_index=\"$1\"".into()
    });
    push("  _init_completion -n \"$COMP_WORDBREAKS\" || return".into());
    if parent.is_empty() {
        push("  local _comp_word=\"$2\"".into());
    }
    push(String::new());

    let valued: Vec<&Flag> = command
        .flags
        .iter()
        .filter(|flag| flag.takes_value())
        .collect();
    if !valued.is_empty() {
        push("  # Flag value completions".into());
        push("  case \"$prev\" in".into());
        for flag in &valued {
            if let Some(completion) = bash_choices(&flag.kind) {
                push(format!("    --{})", flag.name));
                push(format!("      {completion}"));
                push("      return".into());
                push("      ;;".into());
            }
        }
        push("  esac".into());
        push(String::new());
    }

    let subcommands: Vec<&Command> = command.subcommands().collect();
    if !subcommands.is_empty() {
        push("  # Subcommand dispatch".into());
        push("  local cmd _skip_next=0".into());
        push("  for ((i = _command_index + 1; i < cword; i++)); do".into());
        push("    if (( _skip_next )); then".into());
        push("      _skip_next=0".into());
        push("      continue".into());
        push("    fi".into());
        push("    case \"${words[i]}\" in".into());
        for flag in &valued {
            push(format!("      --{}) _skip_next=1 ;;", flag.name));
            push(format!("      --{}=*) ;;", flag.name));
        }
        for sub in &subcommands {
            let sub_path: Vec<&str> = path.iter().copied().chain([sub.name.as_str()]).collect();
            push(format!("      {})", sub.name));
            push(format!("        {} \"$i\"", function_name(&sub_path)));
            push("        return".into());
            push("        ;;".into());
        }
        push("    esac".into());
        push("  done".into());
        push(String::new());
    }

    if !command.flags.is_empty() {
        let used: Vec<String> = (0..command.flags.len())
            .map(|at| format!("_used_{at}=\"\""))
            .collect();
        push(format!("  local {}", used.join(" ")));
        push("  for ((i = 1; i < cword; i++)); do".into());
        push("    case \"${words[i]%%=*}\" in".into());
        for (at, flag) in command.flags.iter().enumerate() {
            push(format!("      {}) _used_{at}=1 ;;", flag.forms().join("|")));
        }
        push("    esac".into());
        push("  done".into());
        push("  local _filtered_flags=\"\"".into());
        for (at, flag) in command.flags.iter().enumerate() {
            push(format!(
                "  [[ -n \"$_used_{at}\" ]] || _filtered_flags+=\" {}\"",
                flag.forms().join(" ")
            ));
        }
        push(String::new());
    }

    if !command.flags.is_empty() || !subcommands.is_empty() {
        push("  # Complete flags (filtered) and subcommands".into());
        push("  if [[ \"$cur\" == -* ]]; then".into());
        if !command.flags.is_empty() {
            push("    COMPREPLY=( $(compgen -W \"$_filtered_flags\" -- \"$cur\") )".into());
        }
        push("    return".into());
        push("  fi".into());
        push(String::new());
    }

    let completed: Vec<(usize, String)> = command
        .args
        .iter()
        .enumerate()
        .filter_map(|(at, arg)| bash_choices(&arg.kind).map(|completion| (at, completion)))
        .collect();
    if !completed.is_empty() {
        push("  # Positional argument completions".into());
        push("  local _position=0 _skip_next=0 _end_of_options=0".into());
        push("  for ((i = _command_index + 1; i < cword; i++)); do".into());
        push("    if (( _skip_next )); then".into());
        push("      _skip_next=0".into());
        push("      continue".into());
        push("    fi".into());
        push("    if (( _end_of_options )); then".into());
        push("      ((_position += 1))".into());
        push("      continue".into());
        push("    fi".into());
        push("    case \"${words[i]}\" in".into());
        push("      --) _end_of_options=1 ;;".into());
        for flag in &command.flags {
            if flag.takes_value() {
                push(format!("      --{}) _skip_next=1 ;;", flag.name));
                push(format!("      --{}=*) ;;", flag.name));
            } else {
                push(format!("      {}) ;;", flag.forms().join("|")));
            }
        }
        push("      -*) ;;".into());
        push("      *) ((_position += 1)) ;;".into());
        push("    esac".into());
        push("  done".into());
        push("  case \"$_position\" in".into());
        for (at, completion) in &completed {
            push(format!("    {at})"));
            push(format!("      {completion}"));
            push("      return".into());
            push("      ;;".into());
        }
        push("  esac".into());
    } else if !subcommands.is_empty() {
        let names: Vec<&str> = subcommands.iter().map(|sub| sub.name.as_str()).collect();
        push(format!(
            "  COMPREPLY=( $(compgen -W '{}' -- \"$cur\") )",
            names.join(" ")
        ));
    }

    push("}".into());
    push(String::new());

    for sub in subcommands {
        bash_function(sub, &path, lines);
    }
}

// ---- zsh -----------------------------------------------------------------

fn escape_zsh(text: &str) -> String {
    text.replace('\\', "\\\\")
        .replace('\'', "'\\''")
        .replace(':', "\\:")
}

fn zsh_choices(values: &[String]) -> String {
    values
        .iter()
        .map(|value| escape_choice(value).replace('\'', "'\\''"))
        .collect::<Vec<_>>()
        .join(" ")
}

/// A flag's specs: the flag, then its negation for a switch, each excluding all its forms.
fn zsh_flag_specs(flag: &Flag) -> Vec<String> {
    let description = flag_described(flag)
        .map(|text| format!("[{}]", escape_zsh(&text).replace(']', "\\]")))
        .unwrap_or_default();
    let action = match &flag.kind {
        Kind::Boolean => String::new(),
        Kind::Choice(values) => format!(":value:({})", zsh_choices(values)),
        Kind::Integer => ":integer:".into(),
        Kind::String => ":value:".into(),
    };
    let exclusion = format!("({})", flag.forms().join(" "));
    let mut specs = vec![format!("'{exclusion}--{}{description}{action}'", flag.name)];
    if let Some(negation) = flag.negation() {
        let description = flag_described(flag)
            .map(|_| {
                format!(
                    "[{}]",
                    escape_zsh(&format!("Disable {}", flag.name)).replace(']', "\\]")
                )
            })
            .unwrap_or_default();
        specs.push(format!("'{exclusion}--{negation}{description}'"));
    }
    specs
}

fn zsh_arg_spec(arg: &super::tree::Arg) -> String {
    let description = Some(arg.description())
        .filter(|text| !text.is_empty())
        .map_or_else(|| arg.name.clone(), |text| escape_zsh(&text));
    let action = arg
        .kind
        .choices()
        .map(|values| format!("({})", zsh_choices(values)))
        .unwrap_or_default();
    format!("':{description}:{action}'")
}

fn zsh(root: &Command) -> String {
    let mut lines: Vec<String> = [
        "#compdef junto",
        "###-begin-junto-completions-###",
        "#",
        "# Static completion script for Zsh",
        "#",
        "# Installation:",
        "#   junto --completions zsh > ~/.zsh/completions/_junto",
        "#   then add ~/.zsh/completions to your fpath",
        "#",
        "",
    ]
    .map(String::from)
    .into();
    zsh_function(root, &[], &mut lines);
    lines.extend(
        [
            "# Handle both direct invocation and autoload",
            "if [[ \"${zsh_eval_context[-1]}\" == \"loadautofunc\" ]]; then",
            "  _junto \"$@\"",
            "else",
            "  compdef _junto junto",
            "fi",
            "###-end-junto-completions-###",
        ]
        .map(String::from),
    );
    lines.join("\n")
}

fn zsh_function(command: &Command, parent: &[&str], lines: &mut Vec<String>) {
    let path: Vec<&str> = parent
        .iter()
        .copied()
        .chain([command.name.as_str()])
        .collect();
    lines.push(format!("{}() {{", function_name(&path)));
    let subcommands: Vec<&Command> = command.subcommands().collect();
    if !subcommands.is_empty() {
        lines.extend(
            [
                "  local context state state_descr line",
                "  typeset -A opt_args",
                "",
                "  local -a commands",
                "  commands=(",
            ]
            .map(String::from),
        );
        for sub in &subcommands {
            let description = described(sub)
                .map(|text| escape_zsh(&text))
                .unwrap_or_default();
            lines.push(format!("    '{}:{description}'", sub.name));
        }
        lines.extend(["  )", "", "  local -a specs", "  specs=("].map(String::from));
        for spec in command.flags.iter().flat_map(zsh_flag_specs) {
            lines.push(format!("    {spec}"));
        }
        if !command.args.is_empty() {
            lines.extend(["    -", "    parent-arguments"].map(String::from));
            for arg in &command.args {
                lines.push(format!("    {}", zsh_arg_spec(arg)));
            }
            lines.extend(["    -", "    subcommands"].map(String::from));
        }
        lines.extend(
            [
                "    '1:command:->command'",
                "    '*::arg:->args'",
                "  )",
                "",
                "  _arguments -C \"${specs[@]}\"",
                "",
                "  case \"$state\" in",
                "    command)",
                "      _describe -t commands 'commands' commands",
                "      ;;",
                "    args)",
                "      case \"$words[1]\" in",
            ]
            .map(String::from),
        );
        for sub in &subcommands {
            let sub_path: Vec<&str> = path.iter().copied().chain([sub.name.as_str()]).collect();
            lines.push(format!("        {})", sub.name));
            lines.push(format!("          {}", function_name(&sub_path)));
            lines.push("          ;;".into());
        }
        lines.extend(["      esac", "      ;;", "  esac"].map(String::from));
    } else {
        let specs: Vec<String> = command
            .flags
            .iter()
            .flat_map(zsh_flag_specs)
            .chain(command.args.iter().map(zsh_arg_spec))
            .collect();
        if !specs.is_empty() {
            lines.extend(["  local -a specs", "  specs=("].map(String::from));
            lines.extend(specs.iter().map(|spec| format!("    {spec}")));
            lines.extend(["  )", "  _arguments \"${specs[@]}\""].map(String::from));
        }
    }
    lines.extend(["}", ""].map(String::from));
    for sub in subcommands {
        zsh_function(sub, &path, lines);
    }
}

// ---- fish ----------------------------------------------------------------

fn escape_fish(text: &str) -> String {
    text.replace('\\', "\\\\").replace('\'', "\\'")
}

fn fish_choices(values: &[String]) -> String {
    let escaped: Vec<String> = values
        .iter()
        .map(|value| escape_fish(&escape_choice(value)))
        .collect();
    format!("-r -f -a '{}'", escaped.join(" "))
}

fn fish(root: &Command) -> String {
    let mut lines: Vec<String> = [
        "###-begin-junto-completions-###",
        "#",
        "# Static completion script for Fish",
        "#",
        "# Installation:",
        "#   junto --completions fish > ~/.config/fish/completions/junto.fish",
        "#",
        "",
    ]
    .map(String::from)
    .into();
    fish_completions(root, &[], &mut lines);
    lines.extend(["", "###-end-junto-completions-###"].map(String::from));
    lines.join("\n")
}

/// Where a command's completions apply: under its parents, before any of its subcommands.
fn fish_condition(parent: &[&str], children: &[&str]) -> String {
    if parent.is_empty() {
        return if children.is_empty() {
            String::new()
        } else {
            "__fish_use_subcommand".into()
        };
    }
    let seen = parent
        .iter()
        .map(|word| format!("__fish_seen_subcommand_from {word}"))
        .collect::<Vec<_>>()
        .join("; and ");
    if children.is_empty() {
        seen
    } else {
        format!(
            "{seen}; and not __fish_seen_subcommand_from {}",
            children.join(" ")
        )
    }
}

fn fish_completions(command: &Command, parent: &[&str], lines: &mut Vec<String>) {
    let subcommands: Vec<&Command> = command.subcommands().collect();
    let children: Vec<&str> = subcommands.iter().map(|sub| sub.name.as_str()).collect();
    let condition = fish_condition(parent, &children);
    let condition_arg = (!condition.is_empty()).then(|| format!("-n '{condition}'"));
    let line =
        |parts: Vec<Option<String>>| parts.into_iter().flatten().collect::<Vec<_>>().join(" ");
    let complete = || Some("complete -c junto".to_string());

    lines.push(line(vec![
        complete(),
        condition_arg.clone(),
        Some("-f".into()),
    ]));
    for sub in &subcommands {
        lines.push(line(vec![
            complete(),
            condition_arg.clone(),
            Some(format!("-f -a '{}'", escape_fish(&sub.name))),
            described(sub).map(|text| format!("-d '{}'", escape_fish(&text))),
        ]));
    }

    let not_given = |flag: &Flag| {
        let names: Vec<String> = std::iter::once(flag.name.clone())
            .chain(flag.negation())
            .collect();
        format!("not __fish_contains_opt {}", names.join(" "))
    };
    let disable = |flag: &Flag| {
        flag_described(flag)
            .map(|_| format!("-d '{}'", escape_fish(&format!("Disable {}", flag.name))))
    };
    let and = |first: &str, then: String| {
        if first.is_empty() {
            then
        } else {
            format!("{first}; and {then}")
        }
    };
    for flag in &command.flags {
        let dedup = if flag.takes_value() {
            format!(
                "begin; {}; or contains -- (commandline -poc)[-1] --{}; end",
                not_given(flag),
                flag.name
            )
        } else {
            not_given(flag)
        };
        let value = match &flag.kind {
            Kind::Boolean => None,
            Kind::Choice(values) => Some(fish_choices(values)),
            Kind::String | Kind::Integer => Some("-r -f".into()),
        };
        let given = format!("-n '{}'", and(&condition, dedup));
        lines.push(line(vec![
            complete(),
            Some(given.clone()),
            Some(format!("-l {}", flag.name)),
            flag_described(flag).map(|text| format!("-d '{}'", escape_fish(&text))),
            value,
        ]));
        if let Some(negation) = flag.negation() {
            lines.push(line(vec![
                complete(),
                Some(given),
                Some(format!("-l {negation}")),
                disable(flag),
            ]));
        }
    }
    if !command.flags.is_empty() {
        let bare = and(
            &condition,
            "not string match -q -- \"-*\" (commandline -ct)".into(),
        );
        for flag in &command.flags {
            let shown = format!("-n '{bare}; and {}'", not_given(flag));
            lines.push(line(vec![
                complete(),
                Some(shown.clone()),
                Some(format!("-f -a '--{}'", flag.name)),
                flag_described(flag).map(|text| format!("-d '{}'", escape_fish(&text))),
            ]));
            if let Some(negation) = flag.negation() {
                lines.push(line(vec![
                    complete(),
                    Some(shown),
                    Some(format!("-f -a '--{negation}'")),
                    disable(flag),
                ]));
            }
        }
    }
    for arg in &command.args {
        if let Some(values) = arg.kind.choices() {
            let description = Some(arg.description()).filter(|text| !text.is_empty());
            lines.push(line(vec![
                complete(),
                condition_arg.clone(),
                Some(fish_choices(values)),
                description.map(|text| format!("-d '{}'", escape_fish(&text))),
            ]));
        }
    }

    for sub in subcommands {
        let path: Vec<&str> = parent.iter().copied().chain([sub.name.as_str()]).collect();
        fish_completions(sub, &path, lines);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::help::tree::TREE;

    fn every_shell() -> Vec<(&'static str, String)> {
        ["bash", "zsh", "fish", "sh"]
            .into_iter()
            .map(|shell| {
                (
                    shell,
                    script(shell, &TREE).expect("a shell this CLI writes"),
                )
            })
            .collect()
    }

    #[test]
    fn sh_is_the_bash_script_and_no_other_shell_is_written() {
        assert_eq!(script("sh", &TREE), script("bash", &TREE));
        assert_eq!(script("powershell", &TREE), None);
    }

    #[test]
    fn each_script_is_framed_and_ends_in_a_line_feed() {
        for (shell, text) in every_shell() {
            assert!(
                text.contains("###-begin-junto-completions-###\n"),
                "{shell}"
            );
            assert!(text.ends_with("###-end-junto-completions-###\n"), "{shell}");
        }
    }

    /// Every command this build has is completed, in each shell's way of naming it.
    #[test]
    fn every_command_of_this_build_is_completed() {
        let scripts = every_shell();
        let mut stack: Vec<(Vec<&str>, &Command)> = vec![(vec!["junto"], &*TREE)];
        while let Some((path, command)) = stack.pop() {
            let function = function_name(&path);
            for (shell, text) in &scripts {
                let named = match *shell {
                    "bash" | "sh" => text.contains(&format!("\n{function}()\n{{")),
                    "zsh" => text.contains(&format!("\n{function}() {{")),
                    _ => {
                        path.len() == 1
                            || text.contains(&format!("-f -a '{}'", path[path.len() - 1]))
                    }
                };
                assert!(named, "{shell} lacks {}", path.join(" "));
            }
            for sub in command.subcommands() {
                let mut next = path.clone();
                next.push(&sub.name);
                stack.push((next, sub));
            }
        }
    }

    #[test]
    fn a_choice_is_offered_in_each_shell() {
        let scripts = every_shell();
        let bash = &scripts[0].1;
        assert!(bash.contains("_junto--choices \"$cur\" \"$_comp_word\" 'with-you' 'between'"));
        assert!(scripts[1].1.contains(":value:(with-you between)"));
        assert!(scripts[2].1.contains("-r -f -a 'with-you between'"));
    }

    #[test]
    fn quotes_and_colons_are_escaped_for_each_shell() {
        assert_eq!(escape_bash("it's"), "it'\\''s");
        assert_eq!(escape_zsh("a:b\\c'd"), "a\\:b\\\\c'\\''d");
        assert_eq!(escape_fish("a\\b'c"), "a\\\\b\\'c");
        assert_eq!(escape_choice("a b"), "a\\ b");
    }
}
