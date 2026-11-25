//! One child process, bounded: the install flow runs the host's own service
//! tool (launchctl, systemctl, loginctl, ps) and the candidate core's own
//! `machine status`, and none of them may hang it or flood it.

use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// A child's whole answer, or that it outlived its bound.
pub struct Completed {
    pub status: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
}

/// Which exit a host command answered, and what it said: the install's refusals
/// name the words, and launchctl's 112/113 decide a domain.
#[derive(Debug, Clone)]
pub struct RunFailed {
    pub exit: Option<i32>,
    pub message: String,
}

impl RunFailed {
    pub fn exit_is(&self, code: i32) -> bool {
        self.exit == Some(code)
    }
}

/// One command runner. The service writers take one so a test feeds them the
/// host's answers without a host.
pub trait Runner {
    fn run(&self, program: &str, args: &[&str]) -> Result<String, RunFailed>;
}

/// The host's own: 30 seconds and 256 KiB, as the TypeScript service writes.
pub struct System;

const SERVICE_BOUND: Duration = Duration::from_secs(30);
const SERVICE_MAX_BYTES: usize = 256 * 1024;
pub const PS_BOUND: Duration = Duration::from_millis(500);
pub const PS_MAX_BYTES: usize = 64 * 1024;

impl Runner for System {
    fn run(&self, program: &str, args: &[&str]) -> Result<String, RunFailed> {
        let completed =
            bounded(program, args, &[], SERVICE_BOUND, SERVICE_MAX_BYTES).map_err(|error| {
                RunFailed {
                    exit: None,
                    message: error.to_string(),
                }
            })?;
        if completed.timed_out {
            return Err(RunFailed {
                exit: None,
                message: format!("{program} did not answer within its bound"),
            });
        }
        match completed.status {
            Some(0) => Ok(completed.stdout),
            status => Err(RunFailed {
                exit: status,
                message: completed.stderr.trim().to_string(),
            }),
        }
    }
}

/// A child with its output read while it runs, killed at its bound.
pub fn bounded(
    program: &str,
    args: &[&str],
    env: &[(&str, &str)],
    bound: Duration,
    max_bytes: usize,
) -> std::io::Result<Completed> {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (name, value) in env {
        command.env(name, value);
    }
    let mut child = command.spawn()?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let out_reader = std::thread::spawn(move || read_capped(stdout, max_bytes));
    let err_reader = std::thread::spawn(move || read_capped(stderr, max_bytes));
    let deadline = Instant::now() + bound;
    let mut timed_out = false;
    let status = loop {
        match child.try_wait()? {
            Some(status) => break status.code(),
            None if Instant::now() >= deadline => {
                timed_out = true;
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            None => std::thread::sleep(Duration::from_millis(10)),
        }
    };
    Ok(Completed {
        status,
        stdout: out_reader.join().unwrap_or_default(),
        stderr: err_reader.join().unwrap_or_default(),
        timed_out,
    })
}

fn read_capped(source: Option<impl Read>, max_bytes: usize) -> String {
    let Some(source) = source else {
        return String::new();
    };
    let mut bytes = Vec::new();
    let _ = source.take(max_bytes as u64).read_to_end(&mut bytes);
    String::from_utf8_lossy(&bytes).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_child_is_read_whole_and_a_failure_keeps_its_words() {
        let completed = bounded(
            "/bin/sh",
            &["-c", "printf 'out'; printf 'bad' >&2; exit 3"],
            &[],
            Duration::from_secs(5),
            SERVICE_MAX_BYTES,
        )
        .expect("the shell runs");
        assert_eq!(completed.status, Some(3));
        assert_eq!(completed.stdout, "out");
        assert_eq!(completed.stderr, "bad");
        assert!(!completed.timed_out);
    }

    #[test]
    fn a_child_past_its_bound_is_killed() {
        let completed = bounded(
            "/bin/sh",
            &["-c", "sleep 30"],
            &[],
            Duration::from_millis(50),
            SERVICE_MAX_BYTES,
        )
        .expect("the shell runs");
        assert!(completed.timed_out);
        assert_eq!(completed.status, None);
    }
}
