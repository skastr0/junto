//! The running-seat gate on an install (docs/machines.md, Installing and
//! updating a machine): the installer never counts seats itself. It asks the incumbent core on its own
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
/// A kill is asynchronous: the incumbent's own table still counts the seat
/// until its process is reaped, so the lease is asked only once every killed
/// session has actually gone.
const STOP_BOUND: Duration = Duration::from_secs(10);
const STOP_POLL: Duration = Duration::from_millis(100);

/// The incumbent's maintenance lease, or why it could not be held.
pub enum Hold {
    /// The lease: dropping this closes the socket, which releases it, and
    /// nothing in the flow reads it beyond holding it.
    Lease(#[allow(dead_code)] Lease),
    Refused {
        running_seats: u32,
    },
    /// Sessions were killed and at least one was still there at the bound.
    SeatsStillRunning(u32),
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

#[cfg(test)]
impl Lease {
    /// A lease a test holds the far end of: dropping it is observable as EOF.
    pub fn holding(stream: UnixStream) -> Lease {
        Lease {
            stream: Some(stream),
            reader: None,
        }
    }
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

impl Client {
    /// The incumbent's own session table, or nothing at all when its answer
    /// does not hold one: a missing or malformed table is never read as empty,
    /// since an empty table is what lets the lease be asked for.
    fn sessions(&mut self) -> Option<Vec<SessionRow>> {
        let data = self.call("list", json!({}), REQUEST_TIMEOUT)?;
        let value = data.get("sessions")?.clone();
        serde_json::from_value(value).ok()
    }
}

/// What the wait proved about the sessions it killed.
enum Stopped {
    Gone,
    StillThere,
    /// The table stopped being readable: nothing here can prove the seats are
    /// gone, and the lease is not the place to guess.
    Unreadable,
}

fn wait_until_gone(client: &mut Client, killed: &[String], bound: Duration) -> Stopped {
    let deadline = std::time::Instant::now() + bound;
    loop {
        let Some(sessions) = client.sessions() else {
            return Stopped::Unreadable;
        };
        let alive = killed.iter().any(|binding| {
            sessions
                .iter()
                .any(|row| &row.binding_id == binding && row.status != "exited")
        });
        if !alive {
            return Stopped::Gone;
        }
        if std::time::Instant::now() >= deadline {
            return Stopped::StillThere;
        }
        std::thread::sleep(STOP_POLL);
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
    hold_with(junto_home, stop_running_seats, STOP_BOUND)
}

fn hold_with(junto_home: &Path, stop_running_seats: bool, stop_bound: Duration) -> Hold {
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
        let Some(sessions) = client.sessions() else {
            return Hold::Unknown;
        };
        let mut killed: Vec<String> = Vec::new();
        for session in sessions {
            if session.status == "exited" {
                continue;
            }
            // A kill that fails is not the lease's answer; the wait below is.
            let _ = client.call(
                "kill",
                json!({ "bindingId": session.binding_id }),
                REQUEST_TIMEOUT,
            );
            killed.push(session.binding_id);
        }
        if !killed.is_empty() {
            match wait_until_gone(&mut client, &killed, stop_bound) {
                Stopped::Gone => {}
                Stopped::StillThere => {
                    return Hold::SeatsStillRunning(killed.len().min(u32::MAX as usize) as u32);
                }
                Stopped::Unreadable => return Hold::Unknown,
            }
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

/// The refusal a seat that did not stop earns: not the operator's confirm,
/// which was already given, but a machine to look at.
pub fn seats_did_not_stop(count: u32) -> Refused {
    let message = if count == 1 {
        "One seat on this machine did not stop when it was asked to, so nothing was changed. Check this machine before sending again".to_string()
    } else {
        format!(
            "{count} seats on this machine did not stop when they were asked to, so nothing was changed. Check this machine before sending again"
        )
    };
    Refused::new(message)
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
    use std::sync::{Arc, Mutex};

    /// A term control socket that answers like the incumbent: the token
    /// handshake, its own session table, kills that take effect asynchronously,
    /// and a maintenance lease that only grants once the table is empty.
    fn incumbent(
        home: &Path,
        exit_after_lists: Option<usize>,
    ) -> (Arc<Mutex<Vec<String>>>, std::thread::JoinHandle<()>) {
        incumbent_with(home, exit_after_lists, false)
    }

    /// The same socket, with a table that goes blank after its kill.
    fn incumbent_with(
        home: &Path,
        exit_after_lists: Option<usize>,
        blank_after_kill: bool,
    ) -> (Arc<Mutex<Vec<String>>>, std::thread::JoinHandle<()>) {
        use std::io::{BufRead, BufReader, Write};
        use std::os::unix::net::UnixListener;

        let term = home.join(".junto/term");
        std::fs::create_dir_all(&term).expect("a term directory");
        let token: String = (0..64)
            .map(|index| {
                let byte = (0x41u8.wrapping_add((index * 7 % 6) as u8)) as char;
                byte.to_ascii_lowercase()
            })
            .collect();
        std::fs::write(term.join("token"), &token).expect("a token");
        let socket = term.join("control.sock");
        let _ = std::fs::remove_file(&socket);
        let listener = UnixListener::bind(&socket).expect("the control socket");
        let seen = Arc::new(Mutex::new(Vec::new()));
        let record = seen.clone();
        let handle = std::thread::spawn(move || {
            let (stream, _) = listener.accept().expect("a client");
            let mut reader = BufReader::new(stream.try_clone().expect("clone"));
            let mut writer = stream;
            let mut killed = false;
            let mut lists_since_kill = 0usize;
            loop {
                let mut line = String::new();
                match reader.read_line(&mut line) {
                    Ok(0) | Err(_) => return,
                    Ok(_) => {}
                }
                let request: Value = match serde_json::from_str(line.trim()) {
                    Ok(value) => value,
                    Err(_) => continue,
                };
                if request.get("token").is_some() {
                    record.lock().expect("seen").push("auth".to_string());
                    let _ = writeln!(
                        writer,
                        "{}",
                        json!({ "v": PROTOCOL, "ok": true, "id": "auth" })
                    );
                    continue;
                }
                let id = request.get("id").cloned().unwrap_or(Value::Null);
                let op = request
                    .get("op")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                record.lock().expect("seen").push(op.to_string());
                let data = match op {
                    "list" if blank_after_kill && killed => json!({}),
                    "list" => {
                        let status = if !killed {
                            "running"
                        } else {
                            lists_since_kill += 1;
                            match exit_after_lists {
                                Some(after) if lists_since_kill >= after => "exited",
                                _ => "running",
                            }
                        };
                        json!({ "sessions": [{ "bindingId": "s1", "status": status }] })
                    }
                    "kill" => {
                        killed = true;
                        json!({})
                    }
                    "maintenance.acquire" => {
                        let gone = killed
                            && exit_after_lists.is_some_and(|after| lists_since_kill >= after);
                        if gone {
                            json!({ "acquired": true })
                        } else {
                            json!({ "acquired": false, "evidence": { "activeTerminalSessions": 1 } })
                        }
                    }
                    other => panic!("unexpected op {other}"),
                };
                let _ = writeln!(
                    writer,
                    "{}",
                    json!({ "v": PROTOCOL, "ok": true, "id": id, "data": data })
                );
            }
        });
        (seen, handle)
    }

    fn scratch(name: &str) -> std::path::PathBuf {
        let home =
            super::super::paths::home().join(format!(".junto-hold-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        home
    }

    #[test]
    fn one_call_stops_a_session_that_takes_a_moment_to_exit() {
        let home = scratch("moment");
        let (seen, server) = incumbent(&home, Some(3));
        let held = hold_with(&home, true, Duration::from_secs(5));
        assert!(
            matches!(held, Hold::Lease(_)),
            "one call takes the lease, never the confirm again"
        );
        drop(held);
        let operations = seen.lock().expect("seen").clone();
        assert_eq!(operations.first().map(String::as_str), Some("auth"));
        assert_eq!(
            operations.iter().filter(|op| *op == "kill").count(),
            1,
            "the seat is killed once"
        );
        let acquire = operations
            .iter()
            .position(|op| op == "maintenance.acquire")
            .expect("the lease was asked for");
        assert!(
            operations[..acquire]
                .iter()
                .filter(|op| *op == "list")
                .count()
                >= 4,
            "the lease is asked only after the table showed the session gone: {operations:?}"
        );
        drop(server);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn a_table_that_goes_unreadable_after_a_kill_fails_closed() {
        let home = scratch("blank");
        let (seen, server) = incumbent_with(&home, Some(1), true);
        match hold_with(&home, true, Duration::from_secs(2)) {
            Hold::Unknown => {}
            _ => panic!("a blank table is not a proof that the seats are gone"),
        }
        let operations = seen.lock().expect("seen").clone();
        assert!(
            !operations.iter().any(|op| op == "maintenance.acquire"),
            "the lease is never asked for on a guess: {operations:?}"
        );
        let refused = running_seats_unknown();
        assert!(
            refused.message.contains("did not answer"),
            "{}",
            refused.message
        );
        drop(server);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn a_seat_that_never_stops_refuses_with_its_own_words_and_never_asks_for_the_lease() {
        let home = scratch("stubborn");
        let (seen, server) = incumbent(&home, None);
        let held = hold_with(&home, true, Duration::from_millis(300));
        match held {
            Hold::SeatsStillRunning(1) => {}
            _ => panic!("a seat that never stops is its own refusal"),
        }
        let operations = seen.lock().expect("seen").clone();
        assert!(
            !operations.iter().any(|op| op == "maintenance.acquire"),
            "a seat that did not go is not a lease: {operations:?}"
        );
        let refused = seats_did_not_stop(1);
        assert!(
            refused.message.contains("did not stop"),
            "{}",
            refused.message
        );
        assert!(
            !refused.message.contains("Confirm to stop it"),
            "the confirm was already given: {}",
            refused.message
        );
        assert!(seats_did_not_stop(2).message.contains("2 seats"));
        drop(server);
        let _ = std::fs::remove_dir_all(&home);
    }

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
