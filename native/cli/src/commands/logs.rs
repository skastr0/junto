//! `logs` (src/cli/commands/logs.ts): this machine's log, read from a seat,
//! within the scope its credential gives. `machine logs` takes the same filters.

use std::process::ExitCode;
use std::time::{SystemTime, UNIX_EPOCH};

use clap::Args;
use serde::Serialize;

use super::{Run, Timeout};
use crate::duration::parse_wait_for;
use crate::envelope;
use crate::error::{Failure, Result};
use crate::{ops, wire};

/// MachineLogQuery (src/shared/machine-log.ts). The runtime decodes it again
/// and refuses a filter out of range.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Query {
    #[serde(skip_serializing_if = "Option::is_none")]
    since: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    level: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    area: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    operation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    seat: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    canvas: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    limit: Option<i64>,
}

ops! {
    Query => "logs.read",
}

/// The filters as a person types them (logsFilterFlags).
#[derive(Args)]
pub struct Filters {
    /// Rows from this long ago (15m, 2h, 1d) or from an ISO time
    #[arg(long)]
    since: Option<String>,
    /// Rows at or above this level
    #[arg(long)]
    level: Option<String>,
    /// One area, such as seats, link, kernel or core
    #[arg(long)]
    area: Option<String>,
    /// One operation id, at both ends of a link
    #[arg(long)]
    operation: Option<String>,
    /// One seat (canvas node id), within what this seat may read
    #[arg(long)]
    seat: Option<String>,
    /// One canvas name
    #[arg(long)]
    canvas: Option<String>,
    /// The newest rows to return, oldest first
    #[arg(long)]
    last: Option<i64>,
}

impl Filters {
    /// lowerLogsFlags: `since` is a duration back from now, or an ISO time.
    pub fn lower(self) -> Result<Query> {
        let since = self.since.as_deref().map(since_ms).transpose()?;
        Ok(Query {
            since,
            level: self.level,
            area: self.area,
            operation_id: self.operation,
            seat: self.seat,
            canvas: self.canvas,
            limit: self.last,
        })
    }
}

fn since_ms(raw: &str) -> Result<i64> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64);
    if let Ok(back) = parse_wait_for(raw) {
        return Ok(now
            .saturating_sub(i64::try_from(back).unwrap_or(i64::MAX))
            .max(0));
    }
    iso_ms(raw).ok_or_else(|| {
        Failure::input(
            "--since must be a duration like 15m or 2h, or an ISO time",
            "since",
        )
        .and("received", raw)
    })
}

/// An ISO time as Date.parse reads one that opens with a date: a date alone
/// is UTC midnight, a time with no offset is local.
fn iso_ms(raw: &str) -> Option<i64> {
    let opens_with_date = raw.len() >= 10
        && raw.as_bytes()[..10].iter().enumerate().all(|(i, b)| {
            if i == 4 || i == 7 {
                *b == b'-'
            } else {
                b.is_ascii_digit()
            }
        });
    if !opens_with_date {
        return None;
    }
    if let Ok(at) = raw.parse::<jiff::Timestamp>() {
        return Some(at.as_millisecond());
    }
    if let Ok(date) = raw.parse::<jiff::civil::Date>() {
        return date
            .to_zoned(jiff::tz::TimeZone::UTC)
            .ok()
            .map(|z| z.timestamp().as_millisecond());
    }
    let local = raw.parse::<jiff::civil::DateTime>().ok()?;
    local
        .to_zoned(jiff::tz::TimeZone::system())
        .ok()
        .map(|z| z.timestamp().as_millisecond())
}

/// Read this machine's log
#[derive(Args)]
pub struct Logs {
    #[command(flatten)]
    filters: Filters,
    #[command(flatten)]
    timeout: Timeout,
}

impl Run for Logs {
    fn run(self) -> ExitCode {
        let answer = self
            .filters
            .lower()
            .and_then(|query| wire::call(&query, self.timeout.into()))
            .map(Into::into);
        envelope::print("logs", answer)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_an_iso_time_as_date_parse_does() {
        assert_eq!(iso_ms("2026-10-30T05:00:00Z"), Some(1_793_336_400_000));
        assert_eq!(
            iso_ms("2026-10-30T05:00:00.250+00:00"),
            Some(1_793_336_400_250)
        );
        assert_eq!(iso_ms("2026-10-30"), Some(1_793_318_400_000));
        assert!(iso_ms("2026-10-30T05:00").is_some());
        assert_eq!(iso_ms("yesterday"), None);
        assert_eq!(iso_ms("10/30/2026"), None);
    }

    #[test]
    fn a_duration_reaches_back_from_now() {
        let at = since_ms("15m").ok().unwrap_or_default();
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_millis() as i64);
        assert!((now - 900_000 - at).abs() < 5_000);
        assert!(since_ms("soon").is_err());
    }
}
