//! The native `junto` CLI (0.12 native CLI). It owns what is the CLI's own,
//! the work of being a process in an agent's terminal; every decision stays
//! with the runtime behind the socket. Until N2 lands it answers only its
//! version, and refuses everything else in the CLI's failure envelope.

use std::io::Write;
use std::process::ExitCode;

/// The app version the build stamps, as the TypeScript CLI reads APP_VERSION
/// (src/cli/core/constants.ts); the same fallback when it is not stamped.
const CLI_VERSION: &str = match option_env!("JUNTO_APP_VERSION") {
    Some(version) => version,
    None => "0.1.0",
};

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("--version" | "-v") => {
            println!("junto v{CLI_VERSION}");
            ExitCode::SUCCESS
        }
        first => {
            let message = match first {
                Some(command) => format!(
                    "this junto build answers only --version; {} is not here yet",
                    json_escape(command)
                ),
                None => "this junto build answers only --version".to_string(),
            };
            let mut stderr = std::io::stderr().lock();
            let _ = writeln!(
                stderr,
                "{{\"ok\":false,\"error\":{{\"type\":\"InputError\",\"message\":\"{message}\"}}}}"
            );
            ExitCode::FAILURE
        }
    }
}

/// A JSON string body: quotes, backslashes and control characters escaped.
fn json_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::json_escape;

    #[test]
    fn escapes_what_json_requires() {
        assert_eq!(json_escape("a\"b\\c\nd\u{1}"), "a\\\"b\\\\c\\nd\\u0001");
    }
}
