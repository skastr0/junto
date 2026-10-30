//! The running app as a phone's host (makeRelayHost, src/cli/companion-stdio.ts):
//! every request relayed over the operator control socket, which checks the
//! device against the paired-device registry on every call. When the app is
//! down at hello, the installed Junto is started and given a moment
//! (src/cli/companion-launch.ts).

use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use super::frame::{self, Code};
use super::operator::{self, Refused};

const DEFAULT_TIMEOUT_MS: u64 = 30_000;
/// OPERATOR_COMPANION_WAIT_MAX_MS: a change wait is a long poll; the call outlives it.
const WAIT_MAX_MS: u64 = 25_000;
const LAUNCH_WAIT: Duration = Duration::from_secs(20);
const LAUNCH_POLL: Duration = Duration::from_millis(500);
/// Requests one phone relays at once; with the long poll that is four of the
/// socket's eight peers, so two phones fit and a burst queues.
const CALLS_MAX: usize = 3;
const BUSY: &str = "Junto on the Mac is busy. Try again in a moment.";

/// What the long poll saw since its cursor.
pub struct Change {
    pub cursor: String,
    pub changed: bool,
    pub signals: Vec<Value>,
    pub artifacts: Vec<Value>,
    pub reset: bool,
}

/// A paired device's relay to the app.
pub struct Relay {
    device_id: String,
    turns: Turns,
}

impl Relay {
    pub fn new(device_id: String) -> Self {
        Relay { device_id, turns: Turns::new(CALLS_MAX) }
    }

    /// The hello to send, or the connection error that ends the channel.
    pub fn hello(&self) -> Result<Value, (Code, String)> {
        let ask = |timeout| operator::call("companion.hello", json!({ "deviceId": self.device_id }), timeout);
        let mut result = ask(DEFAULT_TIMEOUT_MS);
        // Not running: start the installed app once, then ask again until its
        // socket answers or the wait runs out.
        if result == Err(Refused::Down) && launch_installed() {
            let deadline = Instant::now() + LAUNCH_WAIT;
            while result == Err(Refused::Down) {
                thread::sleep(LAUNCH_POLL.min(deadline.saturating_duration_since(Instant::now())));
                let left = deadline.saturating_duration_since(Instant::now());
                if left.is_zero() {
                    break;
                }
                result = ask(left.as_millis() as u64);
            }
        }
        let data = result.map_err(|refused| {
            let code = if refused == Refused::Down { Code::AppNotRunning } else { Code::Internal };
            (code, code.copy().to_string())
        })?;
        match (data.get("ok"), data.get("hello"), data.get("error")) {
            (Some(Value::Bool(true)), Some(hello), _) => Ok(hello.clone()),
            (Some(Value::Bool(false)), _, Some(error)) => {
                let code = error.get("code").and_then(|c| serde_json::from_value(c.clone()).ok()).unwrap_or(Code::Internal);
                let message = error.get("message").and_then(Value::as_str).unwrap_or(code.copy()).to_string();
                Err((code, message))
            }
            _ => Err((Code::Internal, Code::Internal.copy().to_string())),
        }
    }

    /// One phone request, answered by the app or refused for the phone.
    pub fn call(&self, request: &Value) -> Value {
        let id = request.get("id").and_then(Value::as_str).unwrap_or_default();
        let args = json!({ "deviceId": self.device_id, "request": request });
        let answer = self.turns.take(|| operator::call("companion.call", args, DEFAULT_TIMEOUT_MS));
        match answer {
            Ok(mut data) => data.get_mut("response").map(Value::take).unwrap_or_else(|| frame::fail(id, Code::Internal, None)),
            Err(Refused::Busy) => frame::fail(id, Code::RateLimited, Some(BUSY)),
            Err(Refused::Down) => frame::fail(id, Code::AppNotRunning, None),
            // The app could not decode it: the phone sent arguments its op does not take.
            Err(Refused::Undecoded) => frame::fail(id, Code::Invalid, Some("The arguments were not valid.")),
            Err(Refused::Failed) => frame::fail(id, Code::Internal, None),
        }
    }

    /// The next change after `cursor`, or none within `wait_ms`.
    pub fn wait_change(&self, cursor: Option<&str>, wait_ms: u64) -> Option<Change> {
        let bounded = wait_ms.min(WAIT_MAX_MS);
        let mut args = json!({ "deviceId": self.device_id, "waitMs": bounded });
        if let Some(cursor) = cursor {
            args["cursor"] = json!(cursor);
        }
        let data = operator::call("companion.events", args, bounded + 10_000).ok()?;
        if data.get("ok") != Some(&Value::Bool(true)) {
            return None;
        }
        let list = |key: &str| data.get(key).and_then(Value::as_array).cloned().unwrap_or_default();
        Some(Change {
            cursor: data.get("cursor")?.as_str()?.to_string(),
            changed: data.get("changed")?.as_bool()?,
            signals: list("signals"),
            artifacts: list("artifacts"),
            reset: data.get("reset")?.as_bool()?,
        })
    }
}

/// At most `max` at once, first come first served.
struct Turns {
    max: usize,
    running: Mutex<usize>,
    freed: Condvar,
}

impl Turns {
    fn new(max: usize) -> Self {
        Turns { max, running: Mutex::new(0), freed: Condvar::new() }
    }

    fn take<A>(&self, run: impl FnOnce() -> A) -> A {
        {
            let running = self.running.lock().unwrap_or_else(|p| p.into_inner());
            let mut running = self.freed.wait_while(running, |n| *n >= self.max).unwrap_or_else(|p| p.into_inner());
            *running += 1;
        }
        let answer = run();
        *self.running.lock().unwrap_or_else(|p| p.into_inner()) -= 1;
        self.freed.notify_one();
        answer
    }
}

// --- starting the installed app (companion-launch.ts) ------------------------

const INSTALLED_APP: &str = "/Applications/Junto.app";
const BUNDLE_IDENTIFIER: &str = "com.skastr0.junto";

/// Only the canonical /Applications/Junto.app is ever started, and only when
/// this command talks to the socket that app serves: the account's own home,
/// no JUNTO_HOME. What plutil prints is compared and dropped: stderr reaches
/// the phone over SSH.
fn launch_installed() -> bool {
    installed_app_startable() && run("/usr/bin/open", &["-g", INSTALLED_APP], Duration::from_secs(5)).is_some()
}

fn installed_app_startable() -> bool {
    if !cfg!(target_os = "macos") || usable_junto_home() {
        return false;
    }
    let home = std::env::home_dir();
    let account = account_home();
    if home.is_none() || home.map(|h| normalized(&h)) != account.map(|a| normalized(Path::new(&a))) {
        return false;
    }
    let real = |path: &str, directory: bool| {
        std::fs::symlink_metadata(path).is_ok_and(|m| if directory { m.is_dir() } else { m.is_file() })
    };
    real(INSTALLED_APP, true)
        && real(&format!("{INSTALLED_APP}/Contents/MacOS/Junto"), false)
        && run(
            "/usr/bin/plutil",
            &["-extract", "CFBundleIdentifier", "raw", "-o", "-", &format!("{INSTALLED_APP}/Contents/Info.plist")],
            Duration::from_secs(2),
        )
        .as_deref()
            == Some(BUNDLE_IDENTIFIER)
}

/// usableJuntoHome: a JUNTO_HOME that names another home.
fn usable_junto_home() -> bool {
    std::env::var("JUNTO_HOME").is_ok_and(|home| {
        let home = home.trim();
        !home.is_empty() && home.len() <= 4096 && !home.chars().any(|c| (c as u32) < 0x20 || c == '\u{7f}') && home.starts_with('/')
    })
}

/// The account's home from the user database, whatever HOME says (`id -P` prints its passwd entry).
fn account_home() -> Option<String> {
    run("/usr/bin/id", &["-P"], Duration::from_secs(2))?.split(':').nth(8).map(str::to_string)
}

fn normalized(path: &Path) -> std::path::PathBuf {
    path.components().collect()
}

/// A child with no inherited environment (the SSH session's LANG, LC_* and
/// whatever sshd accepts never reach it): its trimmed stdout, or None.
fn run(file: &str, args: &[&str], bound: Duration) -> Option<String> {
    let mut child = Command::new(file)
        .args(args)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break,
            Ok(Some(_)) | Err(_) => return None,
            Ok(None) if started.elapsed() >= bound => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Ok(None) => thread::sleep(Duration::from_millis(20)),
        }
    }
    let mut out = String::new();
    std::io::Read::read_to_string(&mut child.stdout.take()?, &mut out).ok()?;
    Some(out.trim().to_string())
}
