//! The running app as a phone's host (makeRelayHost):
//! every request relayed over the operator control socket, which checks the
//! device against the paired-device registry on every call. When the app is
//! down at hello, the installed Junto is started and given a moment.

use std::path::{Path, PathBuf};
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
        Relay {
            device_id,
            turns: Turns::new(CALLS_MAX),
        }
    }

    /// The hello to send, or the connection error that ends the channel.
    pub fn hello(&self) -> Result<Value, (Code, String)> {
        let started = Instant::now();
        let result = wait_for_app(
            |timeout| {
                operator::call(
                    "companion.hello",
                    json!({ "deviceId": self.device_id }),
                    timeout,
                )
            },
            launch_installed,
            thread::sleep,
            || started.elapsed(),
        );
        let data = result.map_err(|refused| {
            let code = if refused == Refused::Down {
                Code::AppNotRunning
            } else {
                Code::Internal
            };
            (code, code.copy().to_string())
        })?;
        match (data.get("ok"), data.get("hello"), data.get("error")) {
            (Some(Value::Bool(true)), Some(hello), _) => Ok(in_schema_order(hello)),
            (Some(Value::Bool(false)), _, Some(error)) => {
                let code = error
                    .get("code")
                    .and_then(|c| serde_json::from_value(c.clone()).ok())
                    .unwrap_or(Code::Internal);
                let message = error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or(code.copy())
                    .to_string();
                Err((code, message))
            }
            _ => Err((Code::Internal, Code::Internal.copy().to_string())),
        }
    }

    /// One phone request, answered by the app or refused for the phone.
    pub fn call(&self, request: &Value) -> Value {
        let id = request
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let args = json!({ "deviceId": self.device_id, "request": request });
        let answer = self
            .turns
            .take(|| operator::call("companion.call", args, DEFAULT_TIMEOUT_MS));
        match answer {
            Ok(mut data) => data
                .get_mut("response")
                .map(Value::take)
                .unwrap_or_else(|| frame::fail(id, Code::Internal, None)),
            Err(Refused::Busy) => frame::fail(id, Code::RateLimited, Some(BUSY)),
            Err(Refused::Down) => frame::fail(id, Code::AppNotRunning, None),
            // The app could not decode it: the phone sent arguments its op does not take.
            Err(Refused::Undecoded) => {
                frame::fail(id, Code::Invalid, Some("The arguments were not valid."))
            }
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
        let list = |key: &str| {
            data.get(key)
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
        };
        Some(Change {
            cursor: data.get("cursor")?.as_str()?.to_string(),
            changed: data.get("changed")?.as_bool()?,
            signals: list("signals"),
            artifacts: list("artifacts"),
            reset: data.get("reset")?.as_bool()?,
        })
    }
}

/// CompanionHello's field order: the TypeScript relay decodes the app's hello
/// and writes it back in this order, whatever order the app sent.
const HELLO_FIELDS: [&str; 7] = [
    "appVersion",
    "deviceId",
    "deviceName",
    "station",
    "serverTime",
    "hosts",
    "features",
];

fn in_schema_order(hello: &Value) -> Value {
    let Some(fields) = hello.as_object() else {
        return hello.clone();
    };
    let known = HELLO_FIELDS
        .iter()
        .filter_map(|&key| Some((key.to_string(), fields.get(key)?.clone())));
    let rest = fields
        .iter()
        .filter(|(key, _)| !HELLO_FIELDS.contains(&key.as_str()))
        .map(|(key, value)| (key.clone(), value.clone()));
    Value::Object(known.chain(rest).collect())
}

/// The hello when the app is down: start the installed app once, then ask
/// again until its socket answers or the wait runs out. The clock and the
/// launch are arguments so the bound is a test, not a sleep.
fn wait_for_app<A, L, S, T>(
    mut ask: A,
    launch: L,
    mut sleep: S,
    mut elapsed: T,
) -> Result<Value, Refused>
where
    A: FnMut(u64) -> Result<Value, Refused>,
    L: FnOnce() -> bool,
    S: FnMut(Duration),
    T: FnMut() -> Duration,
{
    let mut result = ask(DEFAULT_TIMEOUT_MS);
    if result == Err(Refused::Down) && launch() {
        let deadline = elapsed() + LAUNCH_WAIT;
        while result == Err(Refused::Down) {
            let left = deadline.checked_sub(elapsed()).unwrap_or(Duration::ZERO);
            if left.is_zero() {
                break;
            }
            sleep(LAUNCH_POLL.min(left));
            let left = deadline.checked_sub(elapsed()).unwrap_or(Duration::ZERO);
            if left.is_zero() {
                break;
            }
            result = ask(left.as_millis() as u64);
        }
    }
    result
}

/// At most `max` at once, first come first served.
struct Turns {
    max: usize,
    running: Mutex<usize>,
    freed: Condvar,
}

impl Turns {
    fn new(max: usize) -> Self {
        Turns {
            max,
            running: Mutex::new(0),
            freed: Condvar::new(),
        }
    }

    fn take<A>(&self, run: impl FnOnce() -> A) -> A {
        {
            let running = self.running.lock().unwrap_or_else(|p| p.into_inner());
            let mut running = self
                .freed
                .wait_while(running, |n| *n >= self.max)
                .unwrap_or_else(|p| p.into_inner());
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
    installed_app_startable()
        && run(
            "/usr/bin/open",
            &["-g", INSTALLED_APP],
            Duration::from_secs(5),
        )
        .is_some()
}

/// What the launch decision sees, with every system read already made.
#[derive(Debug)]
struct AppFacts {
    macos: bool,
    junto_home: Option<String>,
    home: Option<PathBuf>,
    account_home: Option<String>,
    bundle_is_directory: bool,
    executable_is_file: bool,
    bundle_identifier: Option<String>,
}

fn installed_app_startable() -> bool {
    let bundle_is_directory = real(INSTALLED_APP, true);
    let executable_is_file =
        bundle_is_directory && real(&format!("{INSTALLED_APP}/Contents/MacOS/Junto"), false);
    let bundle_identifier = if executable_is_file {
        run(
            "/usr/bin/plutil",
            &[
                "-extract",
                "CFBundleIdentifier",
                "raw",
                "-o",
                "-",
                &format!("{INSTALLED_APP}/Contents/Info.plist"),
            ],
            Duration::from_secs(2),
        )
    } else {
        None
    };
    launch_refusal(&AppFacts {
        macos: cfg!(target_os = "macos"),
        junto_home: std::env::var("JUNTO_HOME").ok(),
        home: std::env::home_dir(),
        account_home: account_home(),
        bundle_is_directory,
        executable_is_file,
        bundle_identifier,
    })
    .is_none()
}

/// Only the canonical installed app for the account's own home may be
/// started; anything else is refused, and `open` is never called.
fn launch_refusal(facts: &AppFacts) -> Option<&'static str> {
    if !facts.macos {
        return Some("not macOS");
    }
    if usable_junto_home(facts.junto_home.as_deref()) {
        return Some("JUNTO_HOME names another home");
    }
    let (Some(home), Some(account)) = (&facts.home, &facts.account_home) else {
        return Some("no home to compare");
    };
    if normalized(home) != normalized(Path::new(account)) {
        return Some("HOME is not the account's home");
    }
    if !facts.bundle_is_directory {
        return Some("no installed bundle");
    }
    if !facts.executable_is_file {
        return Some("the bundle has no executable");
    }
    if facts.bundle_identifier.as_deref() != Some(BUNDLE_IDENTIFIER) {
        return Some("another bundle uses Junto's name");
    }
    None
}

fn real(path: &str, directory: bool) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|m| if directory { m.is_dir() } else { m.is_file() })
}

/// usableJuntoHome: a JUNTO_HOME that names another home.
fn usable_junto_home(home: Option<&str>) -> bool {
    home.is_some_and(|home| {
        let home = home.trim();
        !home.is_empty()
            && home.len() <= 4096
            && !home.chars().any(|c| (c as u32) < 0x20 || c == '\u{7f}')
            && home.starts_with('/')
    })
}

/// The account's home from the user database, whatever HOME says (`id -P` prints its passwd entry).
fn account_home() -> Option<String> {
    run("/usr/bin/id", &["-P"], Duration::from_secs(2))?
        .split(':')
        .nth(8)
        .map(str::to_string)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_the_hello_in_schema_order() {
        let sent = json!({ "appVersion": "1", "deviceId": "d", "deviceName": "n", "station": "s",
            "hosts": ["h"], "features": ["f"], "serverTime": 1 });
        let keys: Vec<_> = in_schema_order(&sent)
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect();
        assert_eq!(keys, HELLO_FIELDS);
    }

    fn installed() -> AppFacts {
        AppFacts {
            macos: true,
            junto_home: None,
            home: Some(PathBuf::from("/Users/me")),
            account_home: Some("/Users/me".into()),
            bundle_is_directory: true,
            executable_is_file: true,
            bundle_identifier: Some(BUNDLE_IDENTIFIER.into()),
        }
    }

    #[test]
    fn starts_only_the_canonical_installed_app_for_the_accounts_home() {
        assert_eq!(launch_refusal(&installed()), None);
        assert_eq!(
            launch_refusal(&AppFacts {
                junto_home: Some("  ".into()),
                ..installed()
            }),
            None
        );
        for (case, facts) in [
            (
                "not macOS",
                AppFacts {
                    macos: false,
                    ..installed()
                },
            ),
            (
                "a Junto with its own home",
                AppFacts {
                    junto_home: Some("/Users/me/.junto-dev".into()),
                    ..installed()
                },
            ),
            (
                "HOME pointed elsewhere",
                AppFacts {
                    home: Some(PathBuf::from("/tmp/jr-x")),
                    ..installed()
                },
            ),
            (
                "no bundle in /Applications",
                AppFacts {
                    bundle_is_directory: false,
                    ..installed()
                },
            ),
            (
                "a bundle without its executable",
                AppFacts {
                    executable_is_file: false,
                    ..installed()
                },
            ),
            (
                "another app under Junto's name",
                AppFacts {
                    bundle_identifier: Some("com.example.other".into()),
                    ..installed()
                },
            ),
            (
                "an unreadable Info.plist",
                AppFacts {
                    bundle_identifier: None,
                    ..installed()
                },
            ),
        ] {
            assert!(launch_refusal(&facts).is_some(), "{case}");
        }
    }

    #[test]
    fn starts_nothing_when_the_app_already_answers() {
        let launched = std::cell::Cell::new(false);
        let asks = std::cell::Cell::new(0);
        let result = wait_for_app(
            |_| {
                asks.set(asks.get() + 1);
                Ok(json!({ "ok": true, "hello": {} }))
            },
            || {
                launched.set(true);
                true
            },
            |_| {},
            || Duration::ZERO,
        );
        assert!(result.is_ok());
        assert_eq!(asks.get(), 1);
        assert!(!launched.get());
    }

    #[test]
    fn starts_the_app_once_and_waits_for_its_socket() {
        let launched = std::cell::Cell::new(false);
        let elapsed = std::cell::Cell::new(Duration::ZERO);
        let result = wait_for_app(
            |_| {
                if elapsed.get() >= Duration::from_secs(3) {
                    Ok(json!({ "ok": true, "hello": {} }))
                } else {
                    Err(Refused::Down)
                }
            },
            || {
                launched.set(true);
                true
            },
            |wait| elapsed.set(elapsed.get() + wait),
            || elapsed.get(),
        );
        assert!(result.is_ok());
        assert!(launched.get());
        assert!(elapsed.get() <= Duration::from_millis(3_500));
    }

    #[test]
    fn gives_up_at_the_wait_and_answers_app_not_running() {
        let launched = std::cell::Cell::new(false);
        let elapsed = std::cell::Cell::new(Duration::ZERO);
        let result = wait_for_app(
            |timeout| {
                elapsed.set(elapsed.get() + Duration::from_millis(timeout.min(700)));
                Err(Refused::Down)
            },
            || {
                launched.set(true);
                true
            },
            |wait| elapsed.set(elapsed.get() + wait),
            || elapsed.get(),
        );
        assert_eq!(result, Err(Refused::Down));
        assert!(launched.get());
        // The first attempt precedes the launch; the wait after it is bounded.
        assert!(elapsed.get().saturating_sub(Duration::from_millis(700)) <= LAUNCH_WAIT);
    }
}
