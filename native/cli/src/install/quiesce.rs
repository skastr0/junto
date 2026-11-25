//! Stop by service identity, then independently observe the captured process
//! epoch gone: a stop the service
//! confirmed is not enough, the process the machine started must be proven
//! absent from the host's own table, or the stop is unconfirmed.

use std::sync::OnceLock;
use std::time::{Duration, Instant};

use regex::Regex;

use super::Check;
use super::Refused;
use super::run::{self, PS_BOUND, PS_MAX_BYTES};
use super::service::{Observed, Provider, Service};

/// One process's identity: its pid and the wall-clock start that tells a reuse
/// apart.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Epoch {
    pub pid: u32,
    pub start_key: String,
}

const PS_COLUMNS: &str = "pid=,pgid=,lstart=";

fn row_pattern() -> &'static Regex {
    static ROW: OnceLock<Regex> = OnceLock::new();
    ROW.get_or_init(|| {
        Regex::new(
            r"^\s*([1-9][0-9]*)\s+(0|[1-9][0-9]*)\s+((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(?:[1-9]|[12][0-9]|3[01])\s+(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\s+[0-9]{4})\s*$",
        )
        .expect("the ps row pattern")
    })
}

/// One pid's epoch question with a single-pid `ps`: `Some(rows)` is an
/// observation, where an empty answer proves the pid absent, and `None` is an
/// observation the machine could not give.
pub fn read_epoch(pid: u32) -> Option<Vec<Epoch>> {
    if pid == 0 {
        return None;
    }
    let completed = run::bounded(
        "/bin/ps",
        &["-p", &pid.to_string(), "-o", PS_COLUMNS],
        &[("LC_ALL", "C"), ("TZ", "UTC")],
        PS_BOUND,
        PS_MAX_BYTES,
    )
    .or_else(|_| {
        run::bounded(
            "ps",
            &["-p", &pid.to_string(), "-o", PS_COLUMNS],
            &[("LC_ALL", "C"), ("TZ", "UTC")],
            PS_BOUND,
            PS_MAX_BYTES,
        )
    })
    .ok()?;
    if completed.timed_out || !completed.stderr.trim().is_empty() {
        return None;
    }
    if completed.status != Some(0) && completed.status != Some(1) {
        return None;
    }
    let pattern = row_pattern();
    let mut rows = Vec::new();
    for line in completed.stdout.split('\n') {
        if line.trim().is_empty() {
            continue;
        }
        let found = pattern.captures(line)?;
        let row_pid: u32 = found.get(1)?.as_str().parse().ok()?;
        rows.push(Epoch {
            pid: row_pid,
            start_key: found.get(3)?.as_str().to_string(),
        });
    }
    if rows.len() > 1 || rows.first().is_some_and(|row| row.pid != pid) {
        return None;
    }
    Some(rows)
}

/// What a quiesce proved: the incumbent's identity, and how the service stands.
#[derive(Debug, Clone, Default)]
pub struct Quiesced {
    pub pid: Option<u32>,
    pub start_key: Option<String>,
    /// "absent", "unloaded" or "inactive".
    pub service: &'static str,
}

/// Stop by service identity, then independently observe the captured epoch gone.
pub fn quiesce_machine_service(
    service: &mut dyn Service,
    before: &Observed,
    on_stopping: impl FnOnce(),
    epoch_of: &dyn Fn(u32) -> Option<Vec<Epoch>>,
) -> Result<Quiesced, Refused> {
    if !before.loaded {
        if before.pid != 0 {
            return Err(Refused::new("absent service reported a running process")
                .with_check(Check::ServiceNotQuiescent));
        }
        return Ok(Quiesced {
            service: "absent",
            ..Quiesced::default()
        });
    }
    // A pid the table proves absent is a process already gone, not an identity
    // nobody can establish: the stop still runs, and there is nothing to wait
    // for. Only a probe that fails to answer refuses.
    let epoch = if before.pid > 0 {
        match epoch_of(before.pid) {
            Some(rows) => rows.into_iter().next(),
            None => {
                return Err(
                    Refused::new("cannot establish the incumbent process identity")
                        .with_check(Check::ServiceNotQuiescent),
                );
            }
        }
    } else {
        None
    };
    on_stopping();
    service.stop()?;
    let deadline = Instant::now() + Duration::from_secs(30);
    while let Some(epoch) = epoch.clone() {
        let rows = epoch_of(epoch.pid);
        if rows.is_some_and(|rows| !rows.iter().any(|row| row.start_key == epoch.start_key)) {
            break;
        }
        if Instant::now() >= deadline {
            return Err(Refused::new(
                "incumbent process exit is unconfirmed; inspect machine status before recovering forward",
            ).with_check(Check::ServiceNotQuiescent));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let stopped = service.observe()?;
    let still_loaded = service.provider() == Provider::Launchd && stopped.loaded;
    if stopped.pid != 0 || still_loaded {
        return Err(
            Refused::new("service did not become quiescent").with_check(Check::ServiceNotQuiescent)
        );
    }
    Ok(Quiesced {
        pid: epoch.as_ref().map(|epoch| epoch.pid),
        start_key: epoch.as_ref().map(|epoch| epoch.start_key.clone()),
        service: if service.provider() == Provider::Launchd {
            "unloaded"
        } else {
            "inactive"
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn this_process_is_its_own_epoch_and_a_pid_nobody_holds_is_absent() {
        let mine = std::process::id();
        let rows = read_epoch(mine).expect("this process is readable");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].pid, mine);
        assert!(!rows[0].start_key.is_empty());
        // A pid above the kernel's maximum is proven absent, never unknown.
        let absent = read_epoch(4_000_000);
        assert_eq!(absent, Some(Vec::new()));
    }

    #[test]
    fn a_row_that_is_the_wrong_pid_or_a_second_row_is_unavailable() {
        let pattern = row_pattern();
        assert!(pattern.is_match("  12  12 Mon Jan 12 10:00:00 2026"));
        assert!(!pattern.is_match("12 12 Jan 12 10:00:00 2026"));
        assert!(!pattern.is_match("  0  12 Mon Jan 12 10:00:00 2026"));
    }
}
