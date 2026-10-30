//! Wait durations as an operator speaks them (src/cli/core/duration.ts) and
//! the bounded flag reading seat wait and task wait share (seat.ts parseBoundedMs).
//! Owned by cli-protocol.

use serde_json::Value;

use crate::error::{Failure, Result};
use crate::wire::Timeout;

/// How many milliseconds one of each unit is.
fn unit_ms(unit: &str) -> Option<f64> {
    Some(match unit {
        "" | "ms" => 1.0,
        "s" => 1_000.0,
        "m" => 60_000.0,
        "h" => 3_600_000.0,
        "d" => 86_400_000.0,
        "w" => 604_800_000.0,
        _ => return None,
    })
}

/// One hold duration (parseWaitFor): a bare number is milliseconds, or a
/// number and one unit (`90m`, `12h`, `7d`); compound spellings are refused.
pub fn parse_wait_for(value: &str) -> std::result::Result<u64, String> {
    let rejection = || {
        format!(
            "waitFor must be milliseconds or a duration like \"90m\", \"12h\", \"7d\" (received {})",
            Value::from(value)
        )
    };
    let trimmed = value.trim().to_lowercase();
    let split = trimmed
        .find(|c: char| !(c.is_ascii_digit() || c == '.'))
        .unwrap_or(trimmed.len());
    let (amount, unit) = trimmed.split_at(split);
    // \d+(?:\.\d+)?: digits, then at most one dot with digits after it.
    let well_formed = match amount.split_once('.') {
        Some((whole, fraction)) => {
            !whole.is_empty()
                && !fraction.is_empty()
                && fraction.bytes().all(|b| b.is_ascii_digit())
        }
        None => !amount.is_empty(),
    };
    match (well_formed, amount.parse::<f64>(), unit_ms(unit)) {
        // `as` saturates: a duration past u64 is past every bound anyway.
        (true, Ok(amount), Some(per)) if amount.is_finite() => Ok((amount * per).round() as u64),
        _ => Err(rejection()),
    }
}

/// A bounded duration flag (parseBoundedMs): the fallback when left out, and
/// a value out of range refused rather than clamped, so the caller learns the bound.
pub fn bounded_ms(flag: &str, raw: Option<&str>, max_ms: u64, fallback_ms: u64) -> Result<u64> {
    let Some(raw) = raw else {
        return Ok(fallback_ms);
    };
    let refuse = |message: String| Failure::input(message, flag);
    let ms = parse_wait_for(raw).map_err(|message| refuse(format!("--{flag}: {message}")))?;
    if ms < 1 {
        return Err(refuse(format!("--{flag} must be at least 1ms")));
    }
    if ms > max_ms {
        let seconds = max_ms as f64 / 1000.0;
        return Err(refuse(format!(
            "--{flag} is capped at {seconds}s; re-issue the wait for the remainder"
        )));
    }
    Ok(ms)
}

/// A wait's `--until` outside the states it names (untilError).
pub fn until_error(flag: &str, raw: &str, allowed: &[&str]) -> Failure {
    Failure::input(
        format!("--{flag} must be one of {}", allowed.join(", ")),
        flag,
    )
    .and("received", raw)
    .and("hint", "the wait answers only on the states it names")
}

/// The socket's bound for one bounded wait (socketTimeoutFor): above its
/// deadline, so a healthy wait is never reported as a dropped socket.
pub fn socket_timeout_for(deadline_ms: u64) -> Timeout {
    Timeout(
        i64::try_from(deadline_ms)
            .unwrap_or(i64::MAX)
            .saturating_add(5_000),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_durations_as_duration_ts_does() {
        assert_eq!(parse_wait_for("600s"), Ok(600_000));
        assert_eq!(parse_wait_for(" 10M "), Ok(600_000));
        assert_eq!(parse_wait_for("1.5s"), Ok(1_500));
        assert_eq!(parse_wait_for("250"), Ok(250));
        for refused in ["1d12h", "1.s", ".5s", "-1s", "", "5x", "1e3"] {
            assert!(parse_wait_for(refused).is_err(), "{refused}");
        }
    }

    #[test]
    fn bounds_refuse_rather_than_clamp() {
        assert_eq!(
            bounded_ms("timeout", None, 600_000, 60_000).ok(),
            Some(60_000)
        );
        assert!(bounded_ms("timeout", Some("0"), 600_000, 60_000).is_err());
        assert!(bounded_ms("timeout", Some("11m"), 600_000, 60_000).is_err());
    }
}
