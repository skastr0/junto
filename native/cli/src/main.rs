//! The native `junto` CLI. It owns what is the CLI's own, the work of being a
//! process in an agent's terminal: the command line, input, the envelopes,
//! exit codes and the socket. Every decision stays with the runtime behind
//! the socket, which decodes each request again and rules on it.

mod attach;
mod batch;
mod commands;
mod duration;
mod envelope;
mod error;
mod features;
mod help;
mod input;
mod operator;
mod wire;

use std::process::ExitCode;

use clap::Parser;
use serde_json::json;

use crate::commands::{Root, Run};

/// The app version the build stamps, as the TypeScript CLI reads APP_VERSION
/// (src/cli/core/constants.ts); the same fallback when it is not stamped.
pub const CLI_VERSION: &str = match option_env!("JUNTO_APP_VERSION") {
    Some(version) => version,
    None => "0.1.0",
};

/// owner-access.ts: a seat never runs owner or machine commands.
const OWNER_COMMAND_REFUSAL: &str = "Owner and machine commands are unavailable from a Junto seat.";

fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args_os()
        .skip(1)
        .map(|a| a.to_string_lossy().into_owned())
        .collect();
    let words: Vec<&str> = argv.iter().map(String::as_str).collect();

    // early-dispatch.ts: owner refusals and the byte pipes, before any parsing.
    if matches!(
        words.first(),
        Some(&("machine" | "link" | "companion-stdio"))
    ) && std::env::var_os("JUNTO_WORK_TOKEN").is_some()
    {
        envelope::warn(OWNER_COMMAND_REFUSAL);
        return ExitCode::FAILURE;
    }
    match words.as_slice() {
        ["--version" | "-v"] => {
            envelope::say(&format!("junto v{CLI_VERSION}"));
            ExitCode::SUCCESS
        }
        ["link", rest @ ..] => commands::pipes::link(rest),
        ["companion-stdio", rest @ ..] => commands::pipes::companion_stdio(rest),
        ["content-transfer", rest @ ..] => commands::pipes::content_transfer(rest),
        ["overseer", "edge", rest @ ..] => {
            envelope::refuse(None, &commands::overseer::retired_edge(rest))
        }
        // The live conversation host is not part of this CLI.
        ["overseer-host", ..] => {
            envelope::warn("Junto live conversation is disabled in this build");
            ExitCode::from(2)
        }
        ["browser", ..] if features::MACHINE_BUILD => {
            envelope::warn(
                "junto browser: the browser runs in the desktop app, not on a Junto Remote machine",
            );
            ExitCode::from(2)
        }
        [first, ..] if features::disabled_group(first).is_some() => {
            envelope::warn(&format!("junto {first}: disabled in this Junto build"));
            ExitCode::from(2)
        }
        _ if help::asked(&words) => help::show(&words),
        _ => match booleans(&words) {
            Err((message, error)) => help::refuse_usage(&words, &message, error),
            Ok(read) => match Cli::try_parse_from(
                std::iter::once("junto").chain(read.iter().map(String::as_str)),
            ) {
                Ok(cli) => cli.root.run(),
                Err(error) => usage(&error, &words),
            },
        },
    }
}

#[derive(Parser)]
#[command(
    name = "junto",
    disable_help_flag = true,
    disable_version_flag = true,
    disable_help_subcommand = true
)]
struct Cli {
    #[command(subcommand)]
    root: Root,
}

const TRUE: [&str; 5] = ["true", "yes", "on", "1", "y"];
const FALSE: [&str; 5] = ["false", "no", "off", "0", "n"];

/// Effect's boolean flags as clap reads them: `--no-x` sets x false, and
/// `--x=<literal>` or `--x <literal>` sets it from a true or false word.
/// What Effect refuses comes back as its message and tagged error.
fn booleans(words: &[&str]) -> Result<Vec<String>, (String, serde_json::Value)> {
    use clap::{ArgAction, CommandFactory};
    let root = Cli::command();
    let mut command = &root;
    for word in words.iter().filter(|w| !w.starts_with('-')) {
        match command.find_subcommand(word) {
            Some(sub) => command = sub,
            None => break,
        }
    }
    let flags: Vec<&str> = command
        .get_arguments()
        .filter(|arg| matches!(arg.get_action(), ArgAction::SetTrue))
        .filter_map(|arg| arg.get_long())
        .collect();
    let refuse = |name: &str, value: &str, expected: String| {
        let said = if expected.starts_with("Expected") {
            expected.clone()
        } else {
            format!("Expected: {expected}")
        };
        (
            format!("Invalid value for flag --{name}: \"{value}\". {said}"),
            json!({ "_tag": "InvalidValue", "option": name, "value": value,
                    "expected": expected, "kind": "flag" }),
        )
    };
    let mut read: Vec<String> = Vec::with_capacity(words.len());
    let mut rest = words.iter().copied().peekable();
    while let Some(word) = rest.next() {
        if word == "--" {
            read.push(word.into());
            read.extend(rest.by_ref().map(String::from));
            break;
        }
        let Some(long) = word.strip_prefix("--") else {
            read.push(word.into());
            continue;
        };
        let (name, inline) = long
            .split_once('=')
            .map_or((long, None), |(n, v)| (n, Some(v)));
        let literal = |v: &str| TRUE.contains(&v) || FALSE.contains(&v);
        if let Some(negated) = name.strip_prefix("no-").filter(|n| flags.contains(n)) {
            let given = inline.or_else(|| rest.next_if(|next| literal(next)));
            if let Some(value) = given {
                let expected =
                    format!("omit the value and use {word} by itself to set --{negated} to false");
                return Err(refuse(negated, value, expected));
            }
            let set = format!("--{negated}");
            read.retain(|w| *w != set);
            continue;
        }
        if !flags.contains(&name) {
            read.push(word.into());
            continue;
        }
        let value = inline.or_else(|| rest.next_if(|next| literal(next)));
        let on = match value {
            None => true,
            Some(v) if TRUE.contains(&v) => true,
            Some(v) if FALSE.contains(&v) => false,
            Some(v) => {
                let all: Vec<String> = TRUE
                    .iter()
                    .chain(&FALSE)
                    .map(|l| format!("\"{l}\""))
                    .collect();
                return Err(refuse(name, v, format!("Expected {}", all.join(" | "))));
            }
        };
        let set = format!("--{name}");
        read.retain(|w| *w != set);
        if on {
            read.push(set);
        }
    }
    Ok(read)
}

/// A command line clap could not read, answered as Effect's CLI answers it
/// (help, ERROR, ShowHelp), each error in its words and with its `_tag`.
fn usage(error: &clap::Error, words: &[&str]) -> ExitCode {
    use clap::error::{ContextKind, ContextValue, ErrorKind};
    let text = |kind| match error.get(kind) {
        Some(ContextValue::String(s)) => Some(s.as_str()),
        Some(ContextValue::Strings(v)) => v.first().map(String::as_str),
        _ => None,
    };
    // clap names a flag as `--timeout <MS>` and a positional as `<TASK>`.
    let arg = text(ContextKind::InvalidArg).unwrap_or_default();
    let flag = arg.split_whitespace().next().unwrap_or_default();
    let value = text(ContextKind::InvalidValue).unwrap_or_default();
    let command = help::command_line(words);
    let (message, tagged) = match error.kind() {
        ErrorKind::UnknownArgument if arg.starts_with('-') => (
            format!("Unrecognized flag: {arg} in command {command}"),
            json!({ "_tag": "UnrecognizedOption", "option": arg,
                    "command": command.split(' ').collect::<Vec<_>>(), "suggestions": [] }),
        ),
        ErrorKind::UnknownArgument => (
            format!("Unexpected positional argument: \"{arg}\""),
            json!({ "_tag": "UnexpectedArgument", "arguments": [arg] }),
        ),
        ErrorKind::InvalidSubcommand => {
            let sub = text(ContextKind::InvalidSubcommand).unwrap_or_default();
            (
                format!("Unknown subcommand \"{sub}\" for \"{command}\""),
                json!({ "_tag": "UnknownSubcommand", "subcommand": sub,
                        "parent": command.split(' ').collect::<Vec<_>>(), "suggestions": [] }),
            )
        }
        ErrorKind::MissingRequiredArgument if arg.starts_with("--") => (
            format!("Missing required flag: {flag}"),
            json!({ "_tag": "MissingOption", "option": flag.trim_start_matches('-') }),
        ),
        ErrorKind::MissingRequiredArgument => {
            let name = arg
                .trim_matches(|c| matches!(c, '<' | '>' | '.'))
                .to_lowercase();
            (
                format!("Missing required argument: {name}"),
                json!({ "_tag": "MissingArgument", "argument": name }),
            )
        }
        ErrorKind::InvalidValue if value.is_empty() => {
            // A flag with choices names them; any other takes a string.
            let expected = match error.get(ContextKind::ValidValue) {
                Some(ContextValue::Strings(valid)) => valid.join(" | "),
                _ => "string".into(),
            };
            (
                format!("Missing value for flag {flag}. Expected: {expected}"),
                json!({ "_tag": "InvalidValue", "option": flag.trim_start_matches('-'),
                        "value": "", "expected": expected, "kind": "flag" }),
            )
        }
        ErrorKind::InvalidValue => {
            let expected = match error.get(ContextKind::ValidValue) {
                Some(ContextValue::Strings(valid)) => valid
                    .iter()
                    .map(|v| format!("\"{v}\""))
                    .collect::<Vec<_>>()
                    .join(" | "),
                _ => String::new(),
            };
            (
                format!("Invalid value for flag {flag}: \"{value}\". Expected: {expected}"),
                json!({ "_tag": "InvalidValue", "option": flag.trim_start_matches('-'),
                        "value": value, "expected": expected, "kind": "flag" }),
            )
        }
        ErrorKind::ValueValidation => {
            let expected = "Expected a string representing a finite number";
            (
                format!("Invalid value for flag {flag}: \"{value}\". {expected}"),
                json!({ "_tag": "InvalidValue", "option": flag.trim_start_matches('-'),
                        "value": value, "expected": expected, "kind": "flag" }),
            )
        }
        // Anything else in clap's own words, without its usage block.
        _ => {
            let rendered = error.to_string();
            let said = rendered
                .split("\n\nUsage:")
                .next()
                .unwrap_or_default()
                .trim_start_matches("error: ")
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ");
            (
                said.clone(),
                json!({ "_tag": "InvalidArgument", "message": said }),
            )
        }
    };
    help::refuse_usage(words, &message, tagged)
}
