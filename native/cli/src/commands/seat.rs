//! `seat` (src/cli/commands/seat.ts): observe and wait on authorized peer
//! seats, bounded and read-only. The flags a person types lower onto the
//! wire here, with a socket bound that sits above the op's own deadline.

use std::process::ExitCode;

use clap::{Args, Subcommand};
use serde::Serialize;

use super::Run;
use crate::duration::{
    bounded_ms, parse_wait_for, socket_timeout_for as socket_timeout, until_error,
};
use crate::envelope;
use crate::error::{Failure, Result};
use crate::{ops, wire};

/// src/shared/seat-control.ts.
const SEAT_WAIT_MAX_MS: u64 = 600_000;
const SEAT_WAIT_DEFAULT_MS: u64 = 60_000;
const SEAT_READ_MAX_LINES: i64 = 2_000;
const SEAT_READ_MAX_SECONDS: u64 = 600;
const SEAT_READ_DEFAULT_FOLLOW_SECONDS: u64 = 30;
const SEAT_READ_DEFAULT_TIMEOUT_MS: u64 = 30_000;

/// `--max-seconds`: a bare number means seconds, a duration is honored as written.
fn max_seconds(raw: Option<&str>) -> Result<u64> {
    let Some(raw) = raw else {
        return Ok(SEAT_READ_DEFAULT_FOLLOW_SECONDS);
    };
    let trimmed = raw.trim();
    let bare =
        parse_wait_for(trimmed).is_ok() && trimmed.bytes().all(|b| b.is_ascii_digit() || b == b'.');
    let spelled = if bare {
        format!("{trimmed}s")
    } else {
        trimmed.to_string()
    };
    let refuse = |message: String| Failure::input(message, "max-seconds");
    let ms =
        parse_wait_for(&spelled).map_err(|message| refuse(format!("--max-seconds: {message}")))?;
    if ms < 1_000 || ms % 1_000 != 0 {
        return Err(refuse(
            "--max-seconds must be a whole number of seconds, or a duration like \"5m\"".into(),
        ));
    }
    if ms > SEAT_READ_MAX_SECONDS * 1_000 {
        return Err(refuse(format!(
            "--max-seconds is capped at {SEAT_READ_MAX_SECONDS}s; re-issue the follow for the remainder"
        )));
    }
    Ok(ms / 1_000)
}

/// A state a wait answers on.
#[derive(Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SeatUntil {
    Idle,
    Attention,
    Working,
    Gone,
    Replied,
}

impl SeatUntil {
    const ALL: [(&'static str, SeatUntil); 5] = [
        ("idle", SeatUntil::Idle),
        ("attention", SeatUntil::Attention),
        ("working", SeatUntil::Working),
        ("gone", SeatUntil::Gone),
        ("replied", SeatUntil::Replied),
    ];

    /// `--until` as typed, or the refusal naming the states a wait answers on.
    fn parse(raw: &str) -> Result<Self> {
        Self::ALL
            .iter()
            .find(|(name, _)| *name == raw)
            .map(|(_, until)| *until)
            .ok_or_else(|| {
                let names = Self::ALL.map(|(name, _)| name);
                until_error("until", raw, &names)
            })
    }
}

/// Who a wait watches: one seat, or every authorized peer.
#[derive(Serialize)]
pub enum Watch {
    #[serde(rename = "target")]
    Seat(String),
    #[serde(rename = "any")]
    Any(bool),
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WaitArgs {
    #[serde(flatten)]
    watch: Watch,
    until: SeatUntil,
    timeout_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    after: Option<String>,
}

/// A read of one seat's screen, or of every peer without screens.
#[derive(Serialize)]
#[serde(untagged)]
pub enum ReadArgs {
    Brief { brief: bool },
    Seat(SeatRead),
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeatRead {
    target: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    lines: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    since: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    since_generation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    follow: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_seconds: Option<u64>,
}

ops! {
    WaitArgs => "seat.wait",
    ReadArgs => "seat.read",
}

/// Arguments on the wire, and the socket bound that outlives their deadline.
struct Lowered<A> {
    args: A,
    socket: wire::Timeout,
}

/// lowerSeatWait: `seat wait <seat|--any> --until <state> [--timeout] [--after]`.
fn lower_wait(flags: Wait) -> Result<Lowered<WaitArgs>> {
    let watch = match (flags.seat, flags.any) {
        (Some(_), true) => {
            return Err(Failure::input(
                "seat wait takes a seat argument or --any, not both",
                "seat",
            )
            .and(
                "hint",
                "--any waits on the peer seats the caller's edges authorize",
            ));
        }
        (None, false) => {
            return Err(
                Failure::input("seat wait needs a seat argument or --any", "seat")
                    .and(
                        "hint",
                        "name the seat to watch, or pass --any for every authorized peer",
                    )
                    .and("next_step", "junto seat wait <seat> --until idle"),
            );
        }
        (Some(seat), false) => Watch::Seat(seat),
        (None, true) => Watch::Any(true),
    };
    let until = SeatUntil::parse(&flags.until)?;
    if flags.after.is_some() && until != SeatUntil::Replied {
        return Err(
            Failure::input("--after applies to --until replied", "after")
                .and("hint", "--after names the last mail you saw from the peer"),
        );
    }
    let timeout_ms = bounded_ms(
        "timeout",
        flags.timeout.as_deref(),
        SEAT_WAIT_MAX_MS,
        SEAT_WAIT_DEFAULT_MS,
    )?;
    Ok(Lowered {
        args: WaitArgs {
            watch,
            until,
            timeout_ms,
            after: flags.after,
        },
        socket: socket_timeout(timeout_ms),
    })
}

/// lowerSeatRead: `seat read <seat> [--lines] [--since --since-generation]
/// [--follow --max-seconds]`, or `seat read --brief`.
fn lower_read(flags: Read) -> Result<Lowered<ReadArgs>> {
    if flags.brief {
        if flags.seat.is_some() {
            return Err(Failure::input(
                "seat read --brief reads every peer and takes no seat",
                "seat",
            )
            .and("next_step", "junto seat read --brief"));
        }
        let windowed = flags.lines.is_some()
            || flags.since.is_some()
            || flags.since_generation.is_some()
            || flags.follow
            || flags.max_seconds.is_some();
        if windowed {
            return Err(Failure::input(
                "seat read --brief returns no screen, so it takes no --lines, --since or --follow",
                "brief",
            ));
        }
        return Ok(Lowered {
            args: ReadArgs::Brief { brief: true },
            socket: socket_timeout(SEAT_READ_DEFAULT_TIMEOUT_MS),
        });
    }
    let Some(target) = flags.seat else {
        return Err(Failure::input(
            "seat read needs a seat argument, or --brief for every peer",
            "seat",
        )
        .and("next_step", "junto seat read <seat>"));
    };
    if flags.since.is_some() && flags.since_generation.is_none() {
        return Err(
            Failure::input("--since requires --since-generation", "since")
                .and("hint", "an observer sequence belongs to one generation")
                .and("next_step", "copy both from the previous seat read result"),
        );
    }
    let since = flags
        .since
        .as_deref()
        .map(|raw| {
            parse_wait_for(raw).map_err(|_| {
                Failure::input(
                    "--since must be an observer sequence (a whole number)",
                    "since",
                )
                .and("received", raw)
            })
        })
        .transpose()?;
    if let Some(lines) = flags
        .lines
        .filter(|n| !(1..=SEAT_READ_MAX_LINES).contains(n))
    {
        return Err(Failure::input(
            format!("--lines must be between 1 and {SEAT_READ_MAX_LINES}"),
            "lines",
        )
        .and("received", lines));
    }
    if !flags.follow && flags.max_seconds.is_some() {
        return Err(Failure::input(
            "--max-seconds applies to --follow",
            "max-seconds",
        ));
    }
    let seconds = max_seconds(flags.max_seconds.as_deref())?;
    let budget_ms = if flags.follow {
        seconds * 1_000
    } else {
        SEAT_READ_DEFAULT_TIMEOUT_MS
    };
    Ok(Lowered {
        args: ReadArgs::Seat(SeatRead {
            target,
            lines: flags.lines,
            since,
            since_generation: flags.since_generation,
            follow: flags.follow.then_some(true),
            max_seconds: flags.follow.then_some(seconds),
        }),
        socket: socket_timeout(budget_ms),
    })
}

/// Observe and wait on authorized peer seats
#[derive(Args)]
pub struct Seat {
    #[command(subcommand)]
    command: Command,
}

#[derive(Args)]
struct Wait {
    seat: Option<String>,
    #[arg(long)]
    any: bool,
    #[arg(long)]
    until: String,
    #[arg(long)]
    timeout: Option<String>,
    #[arg(long)]
    after: Option<String>,
}

#[derive(Args)]
struct Read {
    seat: Option<String>,
    #[arg(long)]
    brief: bool,
    #[arg(long)]
    lines: Option<i64>,
    #[arg(long)]
    since: Option<String>,
    #[arg(long = "since-generation")]
    since_generation: Option<String>,
    #[arg(long)]
    follow: bool,
    #[arg(long = "max-seconds")]
    max_seconds: Option<String>,
}

#[derive(Subcommand)]
enum Command {
    Wait(Wait),
    Read(Read),
}

fn call<R: wire::Request>(lowered: Result<Lowered<R>>) -> envelope::Answer {
    lowered
        .and_then(|l| wire::call(&l.args, l.socket))
        .map(Into::into)
}

impl Run for Seat {
    fn run(self) -> ExitCode {
        match self.command {
            Command::Wait(flags) => envelope::print("seat wait", call(lower_wait(flags))),
            Command::Read(flags) => envelope::print("seat read", call(lower_read(flags))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_max_seconds_bare_as_seconds() {
        assert_eq!(max_seconds(Some("45")).ok(), Some(45));
        assert_eq!(max_seconds(Some("5m")).ok(), Some(300));
        assert!(max_seconds(Some("1500ms")).is_err());
        assert!(max_seconds(Some("11m")).is_err());
    }

    fn wire_of<T: Serialize>(lowered: Result<Lowered<T>>) -> String {
        serde_json::to_string(&lowered.ok().map(|l| (l.args, l.socket.0))).unwrap_or_default()
    }

    #[test]
    fn lowers_a_wait_and_a_read_onto_the_wire() {
        let wait = Wait {
            seat: None,
            any: true,
            until: "replied".into(),
            timeout: Some("10m".into()),
            after: Some("m1".into()),
        };
        assert_eq!(
            wire_of(lower_wait(wait)),
            r#"[{"any":true,"until":"replied","timeoutMs":600000,"after":"m1"},605000]"#
        );
        let read = Read {
            seat: Some("lead".into()),
            brief: false,
            lines: Some(5),
            since: None,
            since_generation: None,
            follow: true,
            max_seconds: None,
        };
        assert_eq!(
            wire_of(lower_read(read)),
            r#"[{"target":"lead","lines":5,"follow":true,"maxSeconds":30},35000]"#
        );
    }
}
