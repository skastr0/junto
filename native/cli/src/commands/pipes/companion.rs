//! `junto companion-stdio --device dev_<id>` (src/cli/companion-stdio.ts): the
//! phone end of junto-companion/1 (docs/companion-protocol.md).
//!
//! sshd runs this as the forced command of a paired phone's key: stdin and
//! stdout are the SSH exec channel, NDJSON both ways, nothing on stdout but
//! protocol frames. Every request is relayed to the running app over the
//! owner-only operator control socket; this process never opens junto.db.

use std::process::ExitCode;

mod frame;
mod operator;
mod relay;
mod session;

use frame::Code;

use crate::envelope;

/// CompanionDeviceId: `dev_` and a ULID.
fn device_id(text: &str) -> Option<String> {
    let ulid = text.strip_prefix("dev_")?;
    let valid = ulid.len() == 26
        && ulid.bytes().all(|b| matches!(b, b'0'..=b'9' | b'A'..=b'H' | b'J' | b'K' | b'M' | b'N' | b'P'..=b'T' | b'V'..=b'Z'));
    valid.then(|| text.to_string())
}

/// The forced command's argv: `--device dev_<id>`, nothing else.
fn parse(args: &[&str]) -> Result<String, String> {
    let mut device = None;
    let mut rest = args.iter();
    while let Some(&arg) = rest.next() {
        match arg {
            "--device" => device = rest.next().copied(),
            _ => match arg.strip_prefix("--device=") {
                Some(id) => device = Some(id),
                None => return Err(format!("unknown argument {}", serde_json::json!(arg))),
            },
        }
    }
    let device = device.ok_or("--device dev_<id> is required")?;
    device_id(device).ok_or_else(|| "--device is not a device id".into())
}

pub fn run(args: &[&str]) -> ExitCode {
    let refuse = |message: &str| {
        // Still one protocol frame on stdout, so a phone sees a reason; usage on stderr.
        let line =
            frame::connection_error_line(Code::Invalid, Some("This key is not set up for Junto."));
        envelope::say(line.trim_end());
        envelope::warn(&format!("junto companion-stdio: {message}"));
        ExitCode::from(64)
    };
    match parse(args) {
        Err(message) => refuse(&message),
        Ok(device) => {
            session::run(relay::Relay::new(device));
            ExitCode::SUCCESS
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_forced_command() {
        let id = "dev_01M65A00M174ZD80B991YMNB97";
        assert_eq!(parse(&["--device", id]), Ok(id.into()));
        assert_eq!(parse(&[&format!("--device={id}")]), Ok(id.into()));
        assert_eq!(parse(&[]), Err("--device dev_<id> is required".into()));
        // The demo is the TypeScript CLI's alone: a phone's key never runs it.
        assert_eq!(
            parse(&["--device", id, "--demo"]),
            Err("unknown argument \"--demo\"".into())
        );
        assert_eq!(
            parse(&["--device", "dev_1"]),
            Err("--device is not a device id".into())
        );
        assert_eq!(parse(&["-x"]), Err("unknown argument \"-x\"".into()));
    }
}
