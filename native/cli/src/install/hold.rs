//! The running-seat gate on an install (docs/machines.md, Installing and
//! updating a machine), as src/cli/hosts/install-lease.ts holds it: the
//! installer never counts seats itself. It asks the incumbent core on its own
//! term control socket to observe the live set, and closes create admission
//! with a maintenance lease it keeps through the quiesce, so a seat cannot start
//! between the check and the stop.
//!
//! A refused lease is a refusal, never a guess. A socket that does not answer is
//! unknown, and unknown fails closed. Stopping running sessions happens only
//! when the operator's own confirm set it.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};

use super::Refused;

const PROTOCOL: u64 = 1;
const DIAL_TIMEOUT: Duration = Duration::from_secs(8);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const MAINTENANCE_TIMEOUT: Duration = Duration::from_secs(5);

/// The incumbent's maintenance lease, or why it could not be held.
pub enum Hold {
    /// The lease: dropping this closes the socket, which releases it, and
    /// nothing in the flow reads it beyond holding it.
    Lease(#[allow(dead_code)] Lease),
    Refused {
        running_seats: u32,
    },
    Unknown,
}

/// The held lease: the open socket is the authority, and holding it is all this
/// struct is for.
pub struct Lease {
    // The descriptor is the lease; nothing here reads it.
    #[allow(dead_code)]
    stream: Option<UnixStream>,
    reader: Option<BufReader<UnixStream>>,
}

impl Drop for Lease {
    fn drop(&mut self) {
        // Closing the socket is the release: the server cleans up on close.
        self.reader.take();
        self.stream.take();
    }
}

#[derive(Deserialize)]
struct SessionRow {
    #[serde(rename = "bindingId")]
    binding_id: String,
    status: String,
}

struct Client {
    stream: UnixStream,
    reader: BufReader<UnixStream>,
    next_id: u64,
}

impl Client {
    fn dial(socket: &Path) -> Option<Client> {
        let stream = UnixStream::connect(socket).ok()?;
        let _ = stream.set_read_timeout(Some(DIAL_TIMEOUT));
        let _ = stream.set_write_timeout(Some(DIAL_TIMEOUT));
        Some(Client {
            reader: BufReader::new(stream.try_clone().ok()?),
            stream,
            next_id: 1,
        })
    }

    fn hello(&mut self, token: &str) -> Option<()> {
        let line = json!({ "token": token }).to_string();
        writeln!(self.stream, "{line}").ok()?;
        self.stream.flush().ok()?;
        let reply = self.read_line(DIAL_TIMEOUT)?;
        if reply.get("v").and_then(Value::as_u64) != Some(PROTOCOL) {
            return None;
        }
        if reply.get("ok").and_then(Value::as_bool) == Some(true)
            && reply.get("id").and_then(Value::as_str) == Some("auth")
        {
            return Some(());
        }
        None
    }

    fn read_line(&mut self, bound: Duration) -> Option<Value> {
        self.reader.get_ref().set_read_timeout(Some(bound)).ok()?;
        loop {
            let mut line = String::new();
            let read = self.reader.read_line(&mut line).ok()?;
            if read == 0 {
                return None;
            }
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let value: Value = serde_json::from_str(trimmed).ok()?;
            // Host events are not answers to a request.
            if value.get("type").and_then(Value::as_str) == Some("event") {
                continue;
            }
            return Some(value);
        }
    }

    fn call(&mut self, op: &str, extra: Value, bound: Duration) -> Option<Value> {
        let id = format!("junto-install-{}", self.next_id);
        self.next_id += 1;
        let mut request = json!({ "v": PROTOCOL, "id": id, "op": op });
        if let (Some(target), Some(extra)) = (request.as_object_mut(), extra.as_object()) {
            for (key, value) in extra {
                target.insert(key.clone(), value.clone());
            }
        }
        writeln!(self.stream, "{request}").ok()?;
        self.stream.flush().ok()?;
        loop {
            let reply = self.read_line(bound)?;
            if reply.get("id").and_then(Value::as_str) != Some(id.as_str()) {
                continue;
            }
            if reply.get("ok").and_then(Value::as_bool) != Some(true) {
                return None;
            }
            return Some(reply.get("data").cloned().unwrap_or(Value::Null));
        }
    }
}

fn own_socket(junto_home: &Path) -> std::path::PathBuf {
    junto_home.join(".junto").join("term").join("control.sock")
}

fn own_token(junto_home: &Path) -> Option<String> {
    let text =
        std::fs::read_to_string(junto_home.join(".junto").join("term").join("token")).ok()?;
    let token = text.trim().to_string();
    let shaped = token.len() == 64
        && token
            .chars()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&(c as u8)));
    shaped.then_some(token)
}

/// The incumbent's maintenance lease, or why it could not be held.
pub fn hold_incumbent_for_update(junto_home: &Path, stop_running_seats: bool) -> Hold {
    let Some(token) = own_token(junto_home) else {
        return Hold::Unknown;
    };
    let Some(mut client) = Client::dial(&own_socket(junto_home)) else {
        return Hold::Unknown;
    };
    if client.hello(&token).is_none() {
        return Hold::Unknown;
    }
    if stop_running_seats {
        let Some(data) = client.call("list", json!({}), REQUEST_TIMEOUT) else {
            return Hold::Unknown;
        };
        let sessions: Vec<SessionRow> = data
            .get("sessions")
            .cloned()
            .and_then(|value| serde_json::from_value(value).ok())
            .unwrap_or_default();
        for session in sessions {
            if session.status == "exited" {
                continue;
            }
            // A kill that fails is not the lease's answer; the count below is.
            let _ = client.call(
                "kill",
                json!({ "bindingId": session.binding_id }),
                REQUEST_TIMEOUT,
            );
        }
    }
    let Some(data) = client.call("maintenance.acquire", json!({}), MAINTENANCE_TIMEOUT) else {
        return Hold::Unknown;
    };
    match data.get("acquired").and_then(Value::as_bool) {
        Some(true) => Hold::Lease(Lease {
            stream: Some(client.stream),
            reader: Some(client.reader),
        }),
        Some(false) => {
            let running = data
                .get("evidence")
                .and_then(|evidence| evidence.get("activeTerminalSessions"))
                .and_then(Value::as_u64)
                .unwrap_or(0)
                .min(u32::MAX as u64) as u32;
            Hold::Refused {
                running_seats: running,
            }
        }
        None => Hold::Unknown,
    }
}

/// The refusal a held set of seats earns: the operator's own words, and the
/// count the core observed.
pub fn running_seats_refusal(running_seats: u32) -> Refused {
    let message = if running_seats == 1 {
        "One seat is running on this machine. Confirm to stop it and update".to_string()
    } else {
        format!(
            "{running_seats} seats are running on this machine. Confirm to stop them and update"
        )
    };
    Refused::with_running_seats(message, running_seats)
}

/// The refusal an unanswered socket earns.
pub fn running_seats_unknown() -> Refused {
    Refused::with_running_seats_unknown(
        "This machine's Junto did not answer how many seats it runs, so nothing was stopped or changed. Check this machine before updating",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn without_a_token_there_is_no_lease_and_no_guess() {
        let home = super::super::paths::home().join(format!(".junto-hold-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(home.join(".junto/term")).expect("a term directory");
        assert!(matches!(
            hold_incumbent_for_update(&home, false),
            Hold::Unknown
        ));
        std::fs::write(home.join(".junto/term/token"), "not-a-token").expect("a token");
        assert!(matches!(
            hold_incumbent_for_update(&home, false),
            Hold::Unknown
        ));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn the_refusals_name_the_count_the_core_observed() {
        assert!(running_seats_refusal(1).message.contains("One seat is"));
        assert!(running_seats_refusal(3).message.contains("3 seats are"));
        assert!(running_seats_unknown().message.contains("did not answer"));
    }
}

