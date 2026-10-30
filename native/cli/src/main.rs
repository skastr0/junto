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

use crate::commands::{Root, Run};
use crate::error::{ErrorType, Failure};

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
        eprintln!("{OWNER_COMMAND_REFUSAL}");
        return ExitCode::FAILURE;
    }
    match words.as_slice() {
        ["--version" | "-v"] => {
            println!("junto v{CLI_VERSION}");
            ExitCode::SUCCESS
        }
        ["link", rest @ ..] => commands::pipes::link(rest),
        ["companion-stdio", rest @ ..] => commands::pipes::companion_stdio(rest),
        ["content-transfer", rest @ ..] => commands::pipes::content_transfer(rest),
        ["browser", ..] if features::MACHINE_BUILD => {
            eprintln!(
                "junto browser: the browser runs in the desktop app, not on a Junto Remote machine"
            );
            ExitCode::from(2)
        }
        [first, ..] if features::disabled_group(first).is_some() => {
            eprintln!("junto {first}: disabled in this Junto build");
            ExitCode::from(2)
        }
        _ if help::asked(&words) => help::show(&words),
        _ => match Cli::try_parse_from(std::iter::once("junto").chain(words.iter().copied())) {
            Ok(cli) => cli.root.run(),
            Err(error) => envelope::refuse(None, &usage(&error, &words)),
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

/// A command line clap could not read, as an InputError that names the help.
fn usage(error: &clap::Error, words: &[&str]) -> Failure {
    let text = error.to_string();
    let message = text
        .lines()
        .next()
        .unwrap_or_default()
        .trim_start_matches("error: ")
        .to_string();
    let path: Vec<&str> = words
        .iter()
        .take_while(|w| !w.starts_with('-'))
        .take(2)
        .copied()
        .collect();
    Failure::next_step(
        ErrorType::InputError,
        message,
        format!("junto {} --help", path.join(" ")).replace("  ", " "),
    )
}
