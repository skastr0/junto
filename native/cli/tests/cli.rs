//! The built binary against a stand-in work socket: what an agent's terminal
//! types, the frame that reaches the runtime, and the envelope either side
//! prints. These are the behaviours the TypeScript CLI's own tests held before
//! `src/cli` is deleted; each one a user acts on.
//!
//! A fake `control.sock` answers by script, and every frame is kept, so a test
//! asserts the request as well as the reply. Nothing here needs the app.

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde_json::Value;

const TOKEN: &str = "seat-token";
/// A well-formed opId for a write to resend under.
const OP_ID: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

/// What one connection is answered with.
enum Answer {
    /// A success envelope carrying `data`.
    Ok(Value),
    /// An error envelope, as the runtime names it.
    Error(&'static str, &'static str),
    /// Anything else, written as it is (a non-JSON body, or a malformed one).
    Raw(&'static str),
    /// The socket closes with no answer.
    Close,
    /// The request is read and held past the client's bound, then dropped.
    Silent,
}

impl Answer {
    fn ok() -> Answer {
        Answer::Ok(Value::Object(serde_json::Map::new()))
    }
}

struct Work {
    home: PathBuf,
    frames: Arc<Mutex<Vec<Value>>>,
    stop: Arc<AtomicBool>,
    accept: Option<thread::JoinHandle<()>>,
}

impl Work {
    fn start(answers: Vec<Answer>) -> Work {
        let home = std::env::temp_dir().join(format!(
            "junto-cli-test-{}-{}",
            std::process::id(),
            ulid::Ulid::new()
        ));
        std::fs::create_dir_all(&home).unwrap();
        let socket = home.join("control.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        listener.set_nonblocking(true).unwrap();
        let frames = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let answers = Arc::new(Mutex::new(VecDeque::from(answers)));

        let accept = {
            let (frames, stop, answers) = (frames.clone(), stop.clone(), answers.clone());
            thread::spawn(move || {
                while !stop.load(Ordering::Relaxed) {
                    match listener.accept() {
                        Ok((stream, _)) => {
                            let (frames, answers) = (frames.clone(), answers.clone());
                            thread::spawn(move || serve(stream, frames, answers));
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(2));
                        }
                        Err(_) => break,
                    }
                }
            })
        };

        Work {
            home,
            frames,
            stop,
            accept: Some(accept),
        }
    }

    /// A command with no socket at all: refused before it can connect.
    fn offline() -> Work {
        let home = temp_dir();
        Work {
            home,
            frames: Arc::new(Mutex::new(Vec::new())),
            stop: Arc::new(AtomicBool::new(false)),
            accept: None,
        }
    }

    fn command(&self, args: &[&str]) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_junto"));
        command
            .args(args)
            .env("HOME", &self.home)
            .env("JUNTO_WORK_HOME", &self.home)
            .env("JUNTO_WORK_TOKEN", TOKEN)
            .env_remove("JUNTO_HOME")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command
    }

    fn run(&self, args: &[&str]) -> Output {
        self.command(args).output().unwrap()
    }

    fn run_with_stdin(&self, args: &[&str], stdin: &str) -> Output {
        use std::io::Write as _;
        let mut child = self.command(args).stdin(Stdio::piped()).spawn().unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(stdin.as_bytes())
            .unwrap();
        child.wait_with_output().unwrap()
    }

    /// The frames the binary sent, in arrival order.
    fn frames(&self) -> Vec<Value> {
        self.frames.lock().unwrap().clone()
    }

    fn only_frame(&self) -> Value {
        let frames = self.frames();
        assert_eq!(frames.len(), 1, "one call: {frames:?}");
        frames[0].clone()
    }
}

impl Drop for Work {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(accept) = self.accept.take() {
            accept.join().ok();
        }
        std::fs::remove_dir_all(&self.home).ok();
    }
}

fn serve(
    stream: UnixStream,
    frames: Arc<Mutex<Vec<Value>>>,
    answers: Arc<Mutex<VecDeque<Answer>>>,
) {
    stream.set_read_timeout(Some(Duration::from_secs(10))).ok();
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut line = String::new();
    if reader.read_line(&mut line).unwrap_or(0) == 0 {
        return;
    }
    let frame: Value = serde_json::from_str(line.trim()).expect("the CLI sends JSON");
    let op = frame["op"].as_str().unwrap_or("").to_string();
    frames.lock().unwrap().push(frame);
    let answer = answers
        .lock()
        .unwrap()
        .pop_front()
        .unwrap_or(Answer::Ok(Value::Object(serde_json::Map::new())));
    let mut stream = stream;
    match answer {
        Answer::Ok(data) => {
            let envelope = serde_json::json!({ "ok": true, "op": op, "data": data });
            writeln!(stream, "{envelope}").ok();
        }
        Answer::Error(kind, message) => {
            let envelope = serde_json::json!({
                "ok": false,
                "op": op,
                "error": { "type": kind, "message": message },
            });
            writeln!(stream, "{envelope}").ok();
        }
        Answer::Raw(text) => {
            writeln!(stream, "{text}").ok();
        }
        Answer::Close => {}
        Answer::Silent => {
            thread::sleep(Duration::from_secs(2));
        }
    }
}

fn stderr_json(output: &Output) -> Value {
    let text = String::from_utf8_lossy(&output.stderr);
    let line = text
        .lines()
        .find(|line| line.starts_with('{'))
        .unwrap_or_else(|| panic!("no envelope in {text:?}"));
    serde_json::from_str(line)
        .unwrap_or_else(|error| panic!("stderr is not JSON ({error}): {text:?}"))
}

fn stdout_json(output: &Output) -> Value {
    let text = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str(text.trim())
        .unwrap_or_else(|error| panic!("stdout is not JSON ({error}): {text:?}"))
}

fn code(output: &Output) -> i32 {
    output.status.code().unwrap_or(-1)
}

// --- the command line, with no socket ----------------------------------------

#[test]
fn version_answers_with_no_socket_and_no_credential() {
    let work = Work::offline();
    let mut command = work.command(&["--version"]);
    command.env("JUNTO_WORK_TOKEN", "");
    let output = command.output().unwrap();
    assert_eq!(code(&output), 0);
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.starts_with("junto v"), "{stdout:?}");
    assert!(stdout.trim_end().len() > "junto v".len());
    assert!(output.stderr.is_empty());
    assert!(work.frames().is_empty());
}

#[test]
fn owner_and_machine_commands_are_refused_when_a_seat_variable_is_present() {
    let work = Work::start(vec![]);
    for token in ["", "malformed", TOKEN] {
        for args in [
            vec!["machine", "status"],
            vec!["machine", "install-local", "{}"],
            vec!["machine", "uninstall-local", "{}"],
            vec!["link"],
            vec!["companion-stdio"],
        ] {
            let output = work
                .command(&args)
                .env("JUNTO_WORK_TOKEN", token)
                .output()
                .unwrap();
            assert_eq!(code(&output), 1, "{args:?} with {token:?}");
            assert!(
                String::from_utf8_lossy(&output.stderr)
                    .contains("Owner and machine commands are unavailable from a Junto seat."),
                "{args:?}: {:?}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
    }
    assert!(work.frames().is_empty(), "no owner refusal opened a socket");
    // A seat's ordinary mail is not owner work.
    let pass = work.run(&["msg", "list"]);
    assert_eq!(
        code(&pass),
        0,
        "{:?}",
        String::from_utf8_lossy(&pass.stderr)
    );
    assert_eq!(work.only_frame()["op"], "msg.list");
}

// --- bare commands reach the socket ------------------------------------------

#[test]
fn bare_reads_reach_the_socket_with_nothing_but_their_defaults() {
    let work = Work::start(vec![]);
    // A read only exists in a build that carries its family; every other one
    // is refused by main.rs before the socket, so a gated build skips it here.
    let mut cases: Vec<(Vec<&str>, &str)> = vec![
        (vec!["since"], "since"),
        (vec!["msg", "list"], "msg.list"),
        (vec!["seat", "read", "peer"], "seat.read"),
        (vec!["automation", "list"], "automation.list"),
    ];
    if artifacts_on() {
        cases.insert(1, (vec!["artifact", "list"], "artifact.list"));
    }
    if tasks_on() {
        cases.push((vec!["task", "list"], "task.list"));
    }
    for (args, _) in &cases {
        let output = work.run(args);
        assert_eq!(
            code(&output),
            0,
            "{args:?}: {:?}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    let frames = work.frames();
    assert_eq!(frames.len(), cases.len());
    for ((args, op), frame) in cases.into_iter().zip(&frames) {
        assert_eq!(frame["op"], op, "{args:?}");
        assert_eq!(frame["token"], TOKEN, "{args:?}");
        if op != "seat.read" {
            assert_eq!(frame["args"], serde_json::json!({}), "{args:?}");
        }
    }
}

// --- logs --------------------------------------------------------------------

#[test]
fn logs_lower_the_filters_as_one_query() {
    let work = Work::start(vec![Answer::Ok(serde_json::json!({
        "rows": [{
            "at": 1,
            "level": "warn",
            "area": "seats",
            "message": "one row",
        }],
    }))]);
    let before = now_ms();
    let output = work.run(&[
        "logs", "--since", "15m", "--level", "warn", "--last", "5", "--area", "seats",
    ]);
    let after = now_ms();
    assert_eq!(
        code(&output),
        0,
        "{:?}",
        String::from_utf8_lossy(&output.stderr)
    );
    let frame = work.only_frame();
    assert_eq!(frame["op"], "logs.read");
    let since = frame["args"]["since"].as_i64().unwrap();
    assert!(
        since >= before - 15 * 60_000 && since <= after - 15 * 60_000,
        "since {since} in [{before},{after}]"
    );
    assert_eq!(frame["args"]["level"], "warn");
    assert_eq!(frame["args"]["area"], "seats");
    assert_eq!(frame["args"]["limit"], 5);
    assert_eq!(
        stdout_json(&output)["data"]["rows"][0]["message"],
        "one row"
    );
}

#[test]
fn logs_refuse_a_filter_they_cannot_read_before_the_socket() {
    let work = Work::start(vec![]);
    for since in ["soon", "1d12h", "7 days"] {
        let output = work.run(&["logs", "--since", since]);
        assert_eq!(code(&output), 1, "{since}");
        let printed = stderr_json(&output);
        assert_eq!(printed["error"]["type"], "InputError", "{since}: {printed}");
        assert_eq!(
            printed["error"]["details"]["path"], "since",
            "{since}: {printed}"
        );
    }
    assert!(work.frames().is_empty());
}

// --- opId: minted, trimmed, refused -------------------------------------------

#[test]
fn a_write_mints_an_op_id_and_takes_the_one_it_is_given() {
    if !artifacts_on() {
        return;
    }
    let work = Work::start(vec![Answer::ok(), Answer::ok()]);
    let created = work.run(&[
        "artifact",
        "create",
        "Plan",
        "--type",
        "document",
        "--markdown",
        "# Plan",
    ]);
    assert_eq!(
        code(&created),
        0,
        "{:?}",
        String::from_utf8_lossy(&created.stderr)
    );
    let minted = work.frames()[0]["args"]["opId"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(minted.len(), 26, "{minted}");

    let given = format!(" {OP_ID} ");
    let edited = work.run(&[
        "artifact",
        "edit",
        "art-1",
        "--base",
        "2",
        "--markdown",
        "# Next",
        "--op-id",
        &given,
    ]);
    assert_eq!(
        code(&edited),
        0,
        "{:?}",
        String::from_utf8_lossy(&edited.stderr)
    );
    assert_eq!(
        work.frames()[1]["args"]["opId"],
        OP_ID,
        "trimmed, then taken"
    );
}

#[test]
fn a_bad_op_id_is_refused_before_the_socket() {
    if !artifacts_on() {
        return;
    }
    let work = Work::start(vec![]);
    for bad in [
        "",
        "op-01ARZ3NDEKTSV4RRFFQ69G5FAV",
        "01ARZ3NDEKTSV4RRFFQ69G5FA",
        "not-a-ulid",
    ] {
        let output = work.run(&["artifact", "archive", "art-1", "--op-id", bad]);
        assert_eq!(code(&output), 1, "{bad:?}");
        let printed = stderr_json(&output);
        assert_eq!(printed["error"]["type"], "InputError", "{bad:?}: {printed}");
        assert_eq!(
            printed["error"]["details"]["path"], "--op-id",
            "{bad:?}: {printed}"
        );
    }
    assert!(work.frames().is_empty());
}

// --- artifact flags -----------------------------------------------------------

#[test]
fn artifact_create_lowers_its_body_tasks_and_labels() {
    if !artifacts_on() {
        return;
    }
    let work = Work::start(vec![Answer::ok()]);
    let output = work.run(&[
        "artifact",
        "create",
        "The plan",
        "--type",
        "document",
        "--node",
        "agent-1",
        "--task",
        "#4",
        "--task",
        "#5",
        "--label",
        "design",
        "--label",
        "ops, review",
        "--markdown",
        "# The plan\n\nbody",
        "--op-id",
        OP_ID,
    ]);
    assert_eq!(
        code(&output),
        0,
        "{:?}",
        String::from_utf8_lossy(&output.stderr)
    );
    let args = &work.only_frame()["args"];
    assert_eq!(args["opId"], OP_ID);
    assert_eq!(args["type"], "document");
    assert_eq!(args["title"], "The plan");
    assert_eq!(args["node"], "agent-1");
    assert_eq!(
        args["body"],
        serde_json::json!({ "markdown": "# The plan\n\nbody" })
    );
    assert_eq!(args["taskIds"], serde_json::json!(["#4", "#5"]));
    assert_eq!(
        args["labels"],
        serde_json::json!(["design", "ops", "review"])
    );
}

#[test]
fn artifact_comment_and_label_lower_their_flags() {
    if !artifacts_on() {
        return;
    }
    let work = Work::start(vec![Answer::ok(), Answer::ok()]);
    let comment = work.run(&[
        "artifact",
        "comment",
        "art-1",
        "Looks good",
        "--anchor",
        r#"{"line":3,"path":"a.md"}"#,
    ]);
    assert_eq!(
        code(&comment),
        0,
        "{:?}",
        String::from_utf8_lossy(&comment.stderr)
    );
    let label = work.run(&[
        "artifact",
        "label",
        "art-1",
        "--add",
        "design,ops",
        "--remove",
        "old",
    ]);
    assert_eq!(
        code(&label),
        0,
        "{:?}",
        String::from_utf8_lossy(&label.stderr)
    );
    let frames = work.frames();
    assert_eq!(frames[0]["op"], "artifact.comment");
    assert_eq!(frames[0]["args"]["text"], "Looks good");
    assert_eq!(frames[0]["args"]["anchor"]["line"], 3);
    assert!(
        frames[0]["args"].get("opId").is_some(),
        "a comment names its opId"
    );
    assert_eq!(frames[1]["op"], "artifact.label");
    assert_eq!(
        frames[1]["args"]["add"],
        serde_json::json!(["design", "ops"])
    );
    assert_eq!(frames[1]["args"]["remove"], serde_json::json!(["old"]));
}

#[test]
fn artifact_takes_one_body_and_colours_only_its_eight_names() {
    if !artifacts_on() {
        return;
    }
    let work = Work::start(vec![Answer::ok(), Answer::ok()]);
    for args in [
        vec![
            "artifact",
            "create",
            "T",
            "--type",
            "document",
            "--markdown",
            "m",
            "--url",
            "https://example.com",
        ],
        vec![
            "artifact",
            "create",
            "T",
            "--type",
            "document",
            "--markdown",
            "m",
            "--body",
            "{}",
        ],
        vec![
            "artifact",
            "create",
            "T",
            "--type",
            "document",
            "--url",
            "https://example.com",
            "--body",
            "{}",
        ],
    ] {
        let output = work.run(&args);
        assert_eq!(code(&output), 1, "{args:?}");
        assert_eq!(
            stderr_json(&output)["error"]["type"],
            "InputError",
            "{args:?}"
        );
    }
    assert!(work.frames().is_empty(), "nothing is sent for two bodies");

    let bad = work.run(&["artifact", "colour", "design", "charcoal"]);
    assert_ne!(code(&bad), 0, "an outside choice is usage");
    let printed = stderr_json(&bad);
    assert!(
        matches!(
            printed["error"]["type"].as_str(),
            Some("ShowHelp" | "InvalidValue")
        ),
        "an outside choice is usage, not a call: {printed}"
    );
    assert!(work.frames().is_empty());

    let cleared = work.run(&["artifact", "colour", "design", "none"]);
    assert_eq!(
        code(&cleared),
        0,
        "{:?}",
        String::from_utf8_lossy(&cleared.stderr)
    );
    let frame = work.only_frame();
    assert_eq!(frame["op"], "artifact.colour");
    assert!(
        frame["args"].get("colour").is_some_and(Value::is_null),
        "none unsets it as null: {frame}"
    );
}

// --- task check ---------------------------------------------------------------

#[test]
fn task_check_reads_each_flag_as_one_result_and_names_what_it_cannot() {
    if !tasks_on() {
        return;
    }
    let work = Work::start(vec![Answer::ok()]);
    let output = work.run(&[
        "task",
        "check",
        "#4",
        "--outgoing",
        "tests=0",
        "--outgoing",
        "a=b=1",
        "--incoming",
        "e2e=-1",
        "--next",
        "Review the diff",
    ]);
    assert_eq!(
        code(&output),
        0,
        "{:?}",
        String::from_utf8_lossy(&output.stderr)
    );
    let args = &work.only_frame()["args"];
    assert_eq!(
        args["results"],
        serde_json::json!([
            { "checkId": "tests", "side": "outgoing", "exitCode": 0, "outputTail": "" },
            { "checkId": "a=b", "side": "outgoing", "exitCode": 1, "outputTail": "" },
            { "checkId": "e2e", "side": "incoming", "exitCode": -1, "outputTail": "" },
        ])
    );
    assert_eq!(args["next"], "Review the diff");

    for (args, path) in [
        (
            vec!["task", "check", "#4", "--outgoing", "tests=green"],
            "outgoing",
        ),
        (
            vec!["task", "check", "#4", "--incoming", "tests"],
            "incoming",
        ),
        (vec!["task", "check", "#4"], "results"),
        (
            vec![
                "task",
                "check",
                "#4",
                "--outgoing",
                "tests=0",
                "--results",
                "[]",
            ],
            "results",
        ),
    ] {
        let refused = work.run(&args);
        assert_eq!(code(&refused), 1, "{args:?}");
        let printed = stderr_json(&refused);
        assert_eq!(
            printed["error"]["type"], "InputError",
            "{args:?}: {printed}"
        );
        assert_eq!(
            printed["error"]["details"]["path"], path,
            "{args:?}: {printed}"
        );
    }
    assert_eq!(
        work.frames().len(),
        1,
        "none of the refusals reached the socket"
    );
}

#[test]
fn task_check_reads_results_from_a_file_and_keeps_the_tail_in_characters() {
    if !tasks_on() {
        return;
    }
    let work = Work::start(vec![Answer::ok()]);
    let dir = temp_dir();
    let file = dir.join("checks.json");
    let output_tail = format!("{}end", "é".repeat(8192));
    std::fs::write(
        &file,
        serde_json::json!([{
            "checkId": "e2e",
            "side": "incoming",
            "exitCode": 1,
            "outputTail": output_tail,
        }])
        .to_string(),
    )
    .unwrap();
    let output = work.run(&[
        "task",
        "check",
        "#4",
        "--results",
        &format!("@{}", file.display()),
    ]);
    std::fs::remove_dir_all(&dir).ok();
    assert_eq!(
        code(&output),
        0,
        "{:?}",
        String::from_utf8_lossy(&output.stderr)
    );
    let tail = work.only_frame()["args"]["results"][0]["outputTail"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(tail.chars().count(), 8192, "a tail, not the whole output");
    assert!(
        tail.ends_with("éend"),
        "cut at a character boundary: {tail:?}"
    );
}

// --- seat wait / read ---------------------------------------------------------

#[test]
fn seat_wait_lowers_its_state_and_a_bounded_timeout() {
    let work = Work::start(vec![Answer::ok(), Answer::ok(), Answer::ok()]);
    let named = work.run(&["seat", "wait", "peer", "--until", "idle"]);
    assert_eq!(
        code(&named),
        0,
        "{:?}",
        String::from_utf8_lossy(&named.stderr)
    );
    let any = work.run(&[
        "seat",
        "wait",
        "--any",
        "--until",
        "blocked",
        "--timeout",
        "600s",
    ]);
    assert_eq!(code(&any), 0, "{:?}", String::from_utf8_lossy(&any.stderr));
    let read = work.run(&["seat", "read", "peer", "--follow", "--max-seconds", "45"]);
    assert_eq!(
        code(&read),
        0,
        "{:?}",
        String::from_utf8_lossy(&read.stderr)
    );
    let frames = work.frames();
    assert_eq!(frames[0]["op"], "seat.wait");
    assert_eq!(frames[0]["args"]["target"], "peer");
    assert_eq!(frames[0]["args"]["until"], "idle");
    assert_eq!(frames[0]["args"]["timeoutMs"], 60_000);
    assert_eq!(frames[1]["args"]["any"], true);
    assert_eq!(frames[1]["args"]["timeoutMs"], 600_000);
    assert_eq!(frames[2]["op"], "seat.read");
    assert_eq!(frames[2]["args"]["follow"], true);
    assert_eq!(frames[2]["args"]["maxSeconds"], 45);
}

#[test]
fn seat_wait_refuses_both_neither_an_internal_state_and_an_overlong_bound() {
    let work = Work::start(vec![]);
    for args in [
        vec!["seat", "wait", "peer", "--any", "--until", "idle"],
        vec!["seat", "wait", "--until", "idle"],
        vec!["seat", "wait", "peer", "--until", "gone"],
        vec![
            "seat",
            "wait",
            "peer",
            "--until",
            "idle",
            "--timeout",
            "601s",
        ],
    ] {
        let output = work.run(&args);
        assert_eq!(code(&output), 1, "{args:?}");
        assert_eq!(
            stderr_json(&output)["error"]["type"],
            "InputError",
            "{args:?}"
        );
    }
    assert!(work.frames().is_empty());
}

// --- offboard input -----------------------------------------------------------

#[test]
fn offboard_takes_notes_inline_as_json_or_from_a_file_and_the_continuation_three_ways() {
    let work = Work::start(vec![
        Answer::ok(),
        Answer::ok(),
        Answer::ok(),
        Answer::ok(),
        Answer::ok(),
    ]);
    let dir = temp_dir();
    let notes = dir.join("notes.md");
    std::fs::write(&notes, "From a file\n").unwrap();
    let next = dir.join("next.md");
    std::fs::write(&next, "Pick up the retry\n").unwrap();

    for args in [
        vec!["offboard", "Shipped the parser"],
        vec!["offboard", r#"{"notes":"From JSON"}"#],
        vec!["offboard", &format!("@{}", notes.display())],
        vec!["offboard", "Notes", "--continue", "Pick up the retry"],
        vec![
            "offboard",
            "Notes",
            "--continue",
            &format!("@{}", next.display()),
        ],
    ] {
        let output = work.run(&args);
        assert_eq!(
            code(&output),
            0,
            "{args:?}: {:?}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    std::fs::remove_dir_all(&dir).ok();
    let frames = work.frames();
    assert_eq!(
        frames[0]["args"],
        serde_json::json!({ "notes": "Shipped the parser" })
    );
    assert_eq!(
        frames[1]["args"],
        serde_json::json!({ "notes": "From JSON" })
    );
    assert_eq!(
        frames[2]["args"],
        serde_json::json!({ "notes": "From a file\n" })
    );
    assert_eq!(
        frames[3]["args"],
        serde_json::json!({ "notes": "Notes", "continuation": "Pick up the retry" })
    );
    assert_eq!(
        frames[4]["args"],
        serde_json::json!({ "notes": "Notes", "continuation": "Pick up the retry\n" })
    );
}

#[test]
fn offboard_refuses_empty_notes_and_a_continuation_given_twice() {
    let work = Work::start(vec![]);
    for (args, path) in [
        (vec!["offboard", "  "], "input"),
        (vec!["offboard", "Notes", "--continue", "  "], "continue"),
        (
            vec![
                "offboard",
                r#"{"notes":"n","continuation":"a"}"#,
                "--continue",
                "b",
            ],
            "continue",
        ),
    ] {
        let output = work.run(&args);
        assert_eq!(code(&output), 1, "{args:?}");
        let printed = stderr_json(&output);
        assert_eq!(
            printed["error"]["type"], "InputError",
            "{args:?}: {printed}"
        );
        assert_eq!(
            printed["error"]["details"]["path"], path,
            "{args:?}: {printed}"
        );
    }
    assert!(work.frames().is_empty());
}

// --- the transport ------------------------------------------------------------

#[test]
fn a_down_runtime_names_what_to_do() {
    let work = Work::offline();
    let output = work.run(&["msg", "list"]);
    assert_eq!(code(&output), 1);
    let printed = stderr_json(&output);
    assert_eq!(printed["error"]["type"], "RuntimeDown");
    assert!(
        printed["error"]["details"]["next_step"]
            .as_str()
            .unwrap()
            .contains("launch Junto"),
        "{printed}"
    );
}

#[test]
fn a_socket_that_closes_or_answers_junk_is_a_protocol_error() {
    let closing = Work::start(vec![Answer::Close]);
    let closed = closing.run(&["msg", "list"]);
    assert_eq!(code(&closed), 1);
    assert_eq!(stderr_json(&closed)["error"]["type"], "ProtocolError");
    assert!(
        stderr_json(&closed)["error"]["message"]
            .as_str()
            .unwrap()
            .contains("closed")
    );

    let junk = Work::start(vec![Answer::Raw("garbage")]);
    let refused = junk.run(&["msg", "list"]);
    assert_eq!(code(&refused), 1);
    assert_eq!(stderr_json(&refused)["error"]["type"], "ProtocolError");
    assert!(
        stderr_json(&refused)["error"]["message"]
            .as_str()
            .unwrap()
            .contains("non-JSON")
    );
}

#[test]
fn a_silent_socket_times_out_and_a_write_says_what_may_have_happened() {
    let read = Work::start(vec![Answer::Silent]);
    let output = read.run(&["msg", "list", "--timeout", "200"]);
    assert_eq!(code(&output), 1);
    let printed = stderr_json(&output);
    assert_eq!(printed["error"]["type"], "ProtocolError");
    assert_eq!(printed["error"]["details"]["retryable"], true);
    assert!(
        printed["error"]["message"]
            .as_str()
            .unwrap()
            .contains("timed out after 200ms")
    );

    let mail = Work::start(vec![Answer::Silent]);
    let output = mail.run(&["msg", "send", "peer", "hi", "--timeout", "200"]);
    assert_eq!(code(&output), 1);
    let printed = stderr_json(&output);
    assert_eq!(printed["error"]["type"], "UncertainCompletion");
    assert_eq!(printed["error"]["details"]["operation"], "msg.send");
    assert!(
        printed["error"]["details"]["next_step"]
            .as_str()
            .unwrap()
            .contains("mail may already be")
    );
}

#[test]
fn a_write_that_times_out_is_offered_for_replay_under_its_op_id() {
    if !artifacts_on() {
        return;
    }
    let work = Work::start(vec![Answer::Silent]);
    let output = work.run(&[
        "artifact",
        "archive",
        "art-1",
        "--op-id",
        OP_ID,
        "--timeout",
        "200",
    ]);
    assert_eq!(code(&output), 1);
    let printed = stderr_json(&output);
    assert_eq!(printed["error"]["type"], "Timeout");
    assert_eq!(printed["error"]["details"]["opId"], OP_ID);
    assert_eq!(printed["error"]["details"]["retryable"], true);
    assert!(
        printed["error"]["details"]["next_step"]
            .as_str()
            .unwrap()
            .contains("--op-id")
    );
}

#[test]
fn a_runtime_refusal_passes_through_as_the_runtime_words_it() {
    let work = Work::start(vec![Answer::Error("AuthError", "seat gone")]);
    let output = work.run(&["msg", "list"]);
    assert_eq!(code(&output), 1);
    let printed = stderr_json(&output);
    assert_eq!(printed["error"]["type"], "AuthError");
    assert_eq!(printed["error"]["message"], "seat gone");
}

// --- batches ------------------------------------------------------------------

#[test]
fn a_batch_sends_each_item_and_reports_a_partial_failure() {
    let work = Work::start(vec![Answer::ok(), Answer::ok()]);
    let output = work.run(&[
        "msg",
        "send",
        r#"[{"target":"a","text":"1"},{"target":"b"}]"#,
    ]);
    assert_eq!(
        code(&output),
        1,
        "a partial failure exits 1 while printing the whole answer"
    );
    let printed = stdout_json(&output);
    assert_eq!(printed["ok"], true);
    assert_eq!(printed["data"]["outcome"], "partial_failure");
    assert_eq!(printed["data"]["total"], 2);
    assert_eq!(printed["data"]["success_count"], 1);
    assert_eq!(printed["data"]["error_count"], 1);
    assert_eq!(printed["data"]["results"][0]["index"], 0);
    assert_eq!(printed["data"]["results"][1]["index"], 1);
    assert_eq!(
        work.frames().len(),
        1,
        "only the item that decoded was sent"
    );
}

#[test]
fn a_batch_that_all_failed_is_one_batch_failure_and_keeps_the_item_order() {
    let work = Work::start(vec![]);
    let output = work.run(&["msg", "send", r#"[{"text":"1"},{"target":"b","text":2}]"#]);
    assert_eq!(code(&output), 1);
    let printed = stderr_json(&output);
    assert_eq!(printed["error"]["type"], "BatchFailed");
    assert_eq!(printed["error"]["details"]["total"], 2);
    assert_eq!(printed["error"]["details"]["outcome"], "failed");
    assert_eq!(printed["error"]["details"]["retryable"], false);
    assert!(work.frames().is_empty());
}

#[test]
fn a_batch_width_must_be_positive() {
    let work = Work::start(vec![]);
    let output = work.run(&[
        "msg",
        "send",
        r#"[{"target":"a","text":"1"}]"#,
        "--concurrency",
        "0",
    ]);
    assert_eq!(code(&output), 1);
    let printed = stderr_json(&output);
    assert_eq!(printed["error"]["type"], "InputError", "{printed}");
    assert_eq!(
        printed["error"]["details"]["path"], "concurrency",
        "{printed}"
    );
    assert!(work.frames().is_empty());
}

// --- browser ------------------------------------------------------------------

#[test]
fn browser_refuses_a_box_that_is_not_four_numbers_and_a_bad_session() {
    if !browser_on() {
        return;
    }
    let work = Work::start(vec![]);
    for args in [
        vec![
            "browser", "comment", "sess-1", "--box", "1,2,3", "--text", "x",
        ],
        vec![
            "browser",
            "comment",
            "sess-1",
            "--box",
            "1,2,3,4,5",
            "--text",
            "x",
        ],
        vec![
            "browser", "comment", "sess-1", "--box", "a,b,c,d", "--text", "x",
        ],
        vec![
            "browser", "comment", "sess-1", "--box", "1,,3,4", "--text", "x",
        ],
        vec![
            "browser",
            "comment",
            "sess-1",
            "--box",
            "1,2,3,Infinity",
            "--text",
            "x",
        ],
    ] {
        let output = work.run(&args);
        assert_eq!(code(&output), 1, "{args:?}");
        assert_eq!(
            stderr_json(&output)["error"]["type"],
            "InputError",
            "{args:?}"
        );
    }
    assert!(work.frames().is_empty());
}

// --- authority (only in a build that carries it) ------------------------------

#[test]
fn authority_reads_lower_their_canvas_and_order() {
    if !authority_on() {
        return;
    }
    let operator = Operator::start(|frame| {
        let data = if frame["op"] == "authority.list" {
            serde_json::json!({ "canvas": "factory", "named": [], "committed": [] })
        } else {
            serde_json::json!({ "self": null, "machines": [], "canvases": [] })
        };
        serde_json::json!({
            "protocol": "junto-operator/v1",
            "id": frame["id"],
            "op": frame["op"],
            "ok": true,
            "data": data,
        })
    });
    for args in [
        vec!["authority", "status"],
        vec!["authority", "status", "factory"],
        vec!["authority", "list", "factory", "--order", "mini,book"],
    ] {
        let output = operator.run(&args);
        assert_eq!(
            code(&output),
            0,
            "{args:?}: {:?}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    let frames = operator.frames();
    assert_eq!(frames.len(), 3);
    assert_eq!(frames[0]["op"], "authority.status");
    assert_eq!(frames[0]["args"], serde_json::json!({}));
    assert_eq!(
        frames[1]["args"],
        serde_json::json!({ "canvas": "factory" })
    );
    assert_eq!(frames[2]["op"], "authority.list");
    assert_eq!(
        frames[2]["args"]["order"],
        serde_json::json!(["mini", "book"])
    );

    for order in ["", " , ", "mini,mini"] {
        let output = operator.run(&["authority", "list", "factory", "--order", order]);
        assert_eq!(code(&output), 1, "{order:?}");
        assert_eq!(
            stderr_json(&output)["error"]["type"],
            "InputError",
            "{order:?}"
        );
    }
    assert_eq!(operator.frames().len(), 3, "a refused order sends nothing");
}

#[test]
fn a_family_a_build_does_not_carry_is_disabled_before_any_socket() {
    if authority_on() {
        return;
    }
    let work = Work::start(vec![]);
    let output = work.run(&["authority", "status"]);
    assert_eq!(code(&output), 2);
    assert_eq!(
        String::from_utf8_lossy(&output.stderr).trim(),
        "junto authority: disabled in this Junto build"
    );
    assert!(work.frames().is_empty());
}

// --- the operator socket ------------------------------------------------------

#[test]
fn an_owner_command_speaks_the_operator_protocol_without_a_credential() {
    let operator = Operator::start(|frame| {
        serde_json::json!({
            "protocol": "junto-operator/v1",
            "id": frame["id"],
            "op": frame["op"],
            "ok": true,
            "data": { "machines": [] },
        })
    });
    let output = operator.run(&["machine", "status", "{}"]);
    let frames = operator.frames();
    assert_eq!(
        code(&output),
        0,
        "{:?}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        stdout_json(&output)["data"],
        serde_json::json!({ "machines": [] })
    );
    assert_eq!(frames.len(), 1);
    let frame = &frames[0];
    assert_eq!(frame["protocol"], "junto-operator/v1");
    assert_eq!(frame["op"], "machine.status");
    assert!(
        frame.get("token").is_none(),
        "no seat credential leaves an owner call: {frame}"
    );
    assert_eq!(frame["id"].as_str().map(str::len), Some(26));
}

#[test]
fn an_owner_command_refuses_an_answer_for_another_request() {
    let operator = Operator::start(|_| {
        serde_json::json!({
            "protocol": "junto-operator/v1",
            "id": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
            "op": "machine.status",
            "ok": true,
            "data": {},
        })
    });
    let output = operator.run(&["machine", "status", "{}"]);
    assert_eq!(code(&output), 1);
    let printed = stderr_json(&output);
    assert_eq!(printed["error"]["type"], "ProtocolError");
    assert!(
        printed["error"]["message"]
            .as_str()
            .unwrap()
            .contains("does not match")
    );
}

/// A stand-in operator socket at `$HOME/.junto/operator/control.sock`.
struct Operator {
    home: PathBuf,
    frames: Arc<Mutex<Vec<Value>>>,
    stop: Arc<AtomicBool>,
    accept: Option<thread::JoinHandle<()>>,
}

impl Operator {
    fn start(answer: fn(&Value) -> Value) -> Operator {
        let home = temp_dir();
        let socket = home.join(".junto/operator/control.sock");
        std::fs::create_dir_all(socket.parent().unwrap()).unwrap();
        let listener = UnixListener::bind(&socket).unwrap();
        listener.set_nonblocking(true).unwrap();
        let frames = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let accept = {
            let (frames, stop) = (frames.clone(), stop.clone());
            thread::spawn(move || {
                while !stop.load(Ordering::Relaxed) {
                    match listener.accept() {
                        Ok((stream, _)) => {
                            let frames = frames.clone();
                            thread::spawn(move || {
                                let mut reader = BufReader::new(stream.try_clone().unwrap());
                                let mut line = String::new();
                                reader.read_line(&mut line).ok();
                                let frame: Value = serde_json::from_str(line.trim()).unwrap();
                                let response = answer(&frame);
                                frames.lock().unwrap().push(frame);
                                let mut stream = stream;
                                writeln!(stream, "{response}").ok();
                            });
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(2));
                        }
                        Err(_) => break,
                    }
                }
            })
        };
        Operator {
            home,
            frames,
            stop,
            accept: Some(accept),
        }
    }

    fn run(&self, args: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_junto"))
            .args(args)
            .env("HOME", &self.home)
            .env_remove("JUNTO_WORK_TOKEN")
            .env_remove("JUNTO_HOME")
            .env_remove("JUNTO_WORK_HOME")
            .stdin(Stdio::null())
            .output()
            .unwrap()
    }

    fn frames(&self) -> Vec<Value> {
        self.frames.lock().unwrap().clone()
    }
}

impl Drop for Operator {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(accept) = self.accept.take() {
            accept.join().ok();
        }
        std::fs::remove_dir_all(&self.home).ok();
    }
}

// --- overseer, offline and live -----------------------------------------------

#[test]
fn overseer_offline_commands_answer_without_a_socket() {
    let work = Work::offline();
    for args in [
        vec!["overseer", "skill"],
        vec!["overseer", "schema", "list"],
        vec!["overseer", "schema", "show", "canvas.create"],
        vec!["overseer", "examples", "list"],
        vec!["overseer", "capabilities"],
        vec!["docs", "overseer"],
    ] {
        let output = work.run(&args);
        assert_eq!(
            code(&output),
            0,
            "{args:?}: {:?}",
            String::from_utf8_lossy(&output.stderr)
        );
        let printed = stdout_json(&output);
        assert_eq!(printed["ok"], true, "{args:?}");
        assert!(!printed["data"].is_null(), "{args:?}: {}", printed["data"]);
    }
    assert!(
        work.frames().is_empty(),
        "none of the offline answers opened a socket"
    );
}

#[test]
fn overseer_sends_the_closed_call_and_prints_the_inner_data() {
    let work = Work::start(vec![Answer::Ok(serde_json::json!({
        "ok": true,
        "operation": "canvas.list",
        "data": { "canvases": [] },
    }))]);
    let output = work.run(&["overseer", "canvas", "list", "{}"]);
    assert_eq!(
        code(&output),
        0,
        "{:?}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        stdout_json(&output)["data"],
        serde_json::json!({ "canvases": [] })
    );
    let frame = work.only_frame();
    assert_eq!(frame["op"], "overseer");
    assert_eq!(frame["args"]["operation"], "canvas.list");
    assert_eq!(frame["args"]["args"], serde_json::json!({}));
}

#[test]
fn overseer_prints_an_inner_refusal_and_exits_nonzero() {
    let work = Work::start(vec![Answer::Ok(serde_json::json!({
        "ok": false,
        "operation": "canvas.list",
        "error": { "type": "InvalidArguments", "message": "args do not decode" },
    }))]);
    let output = work.run(&["overseer", "canvas", "list", "{}"]);
    assert_eq!(
        code(&output),
        1,
        "an inner refusal is never a success envelope"
    );
    let printed = stderr_json(&output);
    assert_eq!(printed["ok"], false);
    assert_eq!(printed["error"]["message"], "args do not decode");
}

#[test]
fn overseer_secret_put_reads_stdin_and_never_prints_the_value() {
    let work = Work::start(vec![Answer::Ok(serde_json::json!({
        "ok": true,
        "operation": "secret.put",
        "data": { "secretId": "5b0f6d0e-2c1a-4b7e-9d3f-8a1c2e4f6a70" },
    }))]);
    let value = "s3cret-value-never-printed";
    let output = work.run_with_stdin(&["overseer", "secret", "put"], &format!("{value}\n"));
    let printed = stdout_json(&output);
    assert_eq!(
        code(&output),
        0,
        "{:?}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        printed["data"]["secretId"],
        "5b0f6d0e-2c1a-4b7e-9d3f-8a1c2e4f6a70"
    );
    assert!(
        !String::from_utf8_lossy(&output.stdout).contains(value),
        "the value never comes back"
    );
    assert!(!String::from_utf8_lossy(&output.stderr).contains(value));
    let frame = work.only_frame();
    assert_eq!(frame["args"]["operation"], "secret.put");
    assert_eq!(
        frame["args"]["args"]["value"], value,
        "one trailing newline goes"
    );
}

#[test]
fn overseer_artifact_move_sends_its_ids_destination_and_canvas_and_exits_on_a_refusal() {
    if !artifacts_on() {
        return;
    }
    let work = Work::start(vec![
        Answer::Ok(serde_json::json!({
            "ok": true,
            "operation": "artifact.move",
            "data": { "rows": [], "refused": 0 },
        })),
        Answer::Ok(serde_json::json!({
            "ok": true,
            "operation": "artifact.move",
            "data": { "rows": [], "refused": 1 },
        })),
    ]);
    let call = r#"{"artifactIds":["art-1","art-2"],"to":"release","canvas":"factory"}"#;
    let moved = work.run(&["overseer", "artifact", "move", call]);
    assert_eq!(
        code(&moved),
        0,
        "{:?}",
        String::from_utf8_lossy(&moved.stderr)
    );
    let refused = work.run(&["overseer", "artifact", "move", call]);
    assert_eq!(
        code(&refused),
        1,
        "a refused row sets exit 1 while the answer prints whole"
    );
    assert_eq!(stdout_json(&refused)["ok"], true);
    let frames = work.frames();
    assert_eq!(frames[0]["args"]["operation"], "artifact.move");
    assert_eq!(
        frames[0]["args"]["args"]["artifactIds"],
        serde_json::json!(["art-1", "art-2"])
    );
    assert_eq!(frames[0]["args"]["args"]["to"], "release");
    assert_eq!(frames[0]["args"]["args"]["canvas"], "factory");
}

#[test]
fn automation_show_and_history_lower_their_json() {
    let work = Work::start(vec![Answer::ok(), Answer::ok()]);
    let shown = work.run(&[
        "automation",
        "show",
        r#"{"target":"auto-node","automation":"auto-1"}"#,
    ]);
    let history = work.run(&[
        "automation",
        "history",
        r#"{"target":"auto-node","automation":"auto-1","limit":5}"#,
    ]);
    assert_eq!(
        code(&shown),
        0,
        "{:?}",
        String::from_utf8_lossy(&shown.stderr)
    );
    assert_eq!(
        code(&history),
        0,
        "{:?}",
        String::from_utf8_lossy(&history.stderr)
    );
    let frames = work.frames();
    assert_eq!(frames[0]["op"], "automation.show");
    assert_eq!(
        frames[0]["args"],
        serde_json::json!({ "target": "auto-node", "automation": "auto-1" })
    );
    assert_eq!(frames[1]["op"], "automation.history");
    assert_eq!(frames[1]["args"]["limit"], 5);
}

#[test]
fn task_finish_reads_the_handoff_note() {
    if !tasks_on() {
        return;
    }
    let work = Work::start(vec![Answer::ok()]);
    let output = work.run(&[
        "task",
        "finish",
        "#4",
        "--note",
        "Pick up the retry in feed.ts",
    ]);
    assert_eq!(
        code(&output),
        0,
        "{:?}",
        String::from_utf8_lossy(&output.stderr)
    );
    let frame = work.only_frame();
    assert_eq!(frame["op"], "task.finish");
    assert_eq!(frame["args"]["handoff"], "Pick up the retry in feed.ts");
}

// --- input the CLI refuses before the socket -----------------------------------

#[test]
fn logs_refuse_a_filter_out_of_its_range() {
    let work = Work::start(vec![]);
    for (flag, value) in [
        ("--level", "loud".to_string()),
        ("--level", "WARN".to_string()),
        ("--area", "Seats".to_string()),
        ("--area", "s".repeat(49)),
        ("--operation", "op 1".to_string()),
        ("--seat", "a b".to_string()),
        ("--canvas", "Factory".to_string()),
        ("--last", "0".to_string()),
        ("--last", "2001".to_string()),
    ] {
        let output = work.run(&["logs", flag, &value]);
        assert_eq!(code(&output), 1, "{flag} {value}");
        let printed = stderr_json(&output);
        assert_eq!(
            printed["error"]["type"], "InputError",
            "{flag} {value}: {printed}"
        );
        assert_eq!(
            printed["error"]["message"], "a filter is out of range",
            "{flag} {value}"
        );
        assert!(
            printed["error"]["details"]["hint"]
                .as_str()
                .unwrap()
                .contains("--last is 1 to 2000"),
            "{flag} {value}: {printed}"
        );
    }
    assert!(work.frames().is_empty(), "none of them reached the socket");
}

#[test]
fn browser_refuses_a_bad_session_a_tab_and_a_comment_text() {
    if !browser_on() {
        return;
    }
    let work = Work::start(vec![]);
    let long_text = "x".repeat(64 * 1024 + 1);
    let cases: Vec<Vec<&str>> = vec![
        vec!["browser", "goto", "bad id", "https://example.com"],
        vec!["browser", "goto", "", "https://example.com"],
        vec!["browser", "close", "sess 1"],
        vec![
            "browser",
            "goto",
            "sess-1",
            "https://example.com",
            "--tab",
            "",
        ],
        vec!["browser", "shot", "sess-1", "--tab", "tab 2"],
        vec![
            "browser", "comment", "sess-1", "--box", "1,2,3,4", "--text", "   ",
        ],
        vec![
            "browser", "comment", "sess-1", "--box", "1,2,3,4", "--text", &long_text,
        ],
    ];
    for args in cases {
        let output = work.run(&args);
        assert_eq!(code(&output), 1, "{args:?}");
        let printed = stderr_json(&output);
        assert_eq!(
            printed["error"]["type"], "InputError",
            "{args:?}: {printed}"
        );
        assert!(
            printed["error"]["details"]["next_step"]
                .as_str()
                .is_some_and(|next| next.starts_with("junto schema show browser.")),
            "{args:?}: {printed}"
        );
    }
    assert!(
        work.frames().is_empty(),
        "none of them reached the control socket"
    );
}

// --- content staging, through a signal's attachment ----------------------------

/// A staged file's sha256, as the store names it.
fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn closed_ref(sha: &str, byte_length: usize, display_name: &str) -> Answer {
    Answer::Ok(serde_json::json!({
        "ref": {
            "sha256": sha,
            "byteLength": byte_length,
            "mediaType": "text/plain",
            "displayName": display_name,
        },
    }))
}

#[test]
fn a_small_file_goes_up_in_one_piece_with_its_digest_and_never_its_path() {
    let dir = temp_dir();
    let file = dir.join("probe.txt");
    std::fs::write(&file, b"hello").unwrap();
    let sha = sha256_hex(b"hello");
    let work = Work::start(vec![closed_ref(&sha, 5, "probe.txt"), Answer::ok()]);
    let path = file.to_str().unwrap().to_string();
    let output = work.run(&["escalate", "Need a look", "--attach", &path]);
    std::fs::remove_dir_all(&dir).ok();
    assert_eq!(
        code(&output),
        0,
        "{:?}",
        String::from_utf8_lossy(&output.stderr)
    );
    let frames = work.frames();
    assert_eq!(frames.len(), 2, "{frames:?}");
    let stage = &frames[0];
    assert_eq!(stage["op"], "content.stage");
    assert_eq!(stage["args"]["bytesBase64"], "aGVsbG8=");
    assert_eq!(stage["args"]["done"]["expected"]["sha256"], sha);
    assert_eq!(stage["args"]["done"]["expected"]["byteLength"], 5);
    assert_eq!(stage["args"]["done"]["mediaType"], "text/plain");
    assert_eq!(stage["args"]["done"]["displayName"], "probe.txt");
    assert!(
        !stage.to_string().contains(&path),
        "the path stays here: {stage}"
    );
    assert_eq!(frames[1]["op"], "signal.raise");
    assert_eq!(frames[1]["args"]["attach"][0]["ref"]["sha256"], sha);
    assert!(
        !frames[1].to_string().contains(".txt"),
        "no path in the signal either"
    );
}

#[test]
fn a_file_past_one_piece_goes_up_in_pieces_and_the_last_one_closes_it() {
    let dir = temp_dir();
    let file = dir.join("big.txt");
    let piece = 4 * 1024 * 1024;
    std::fs::write(&file, vec![b'a'; piece + 1]).unwrap();
    let sha = sha256_hex(&vec![b'a'; piece + 1]);
    let stage_id = "stg_0123456789abcdef0123456789abcdef";
    let work = Work::start(vec![
        Answer::Ok(serde_json::json!({ "stageId": stage_id })),
        closed_ref(&sha, piece + 1, "big.txt"),
        Answer::ok(),
    ]);
    let output = work.run(&[
        "escalate",
        "Too big for one",
        "--attach",
        file.to_str().unwrap(),
    ]);
    std::fs::remove_dir_all(&dir).ok();
    assert_eq!(
        code(&output),
        0,
        "{:?}",
        String::from_utf8_lossy(&output.stderr)
    );
    let frames = work.frames();
    assert_eq!(frames.len(), 3, "two pieces, then the signal");
    assert_eq!(frames[0]["op"], "content.stage");
    assert_eq!(
        frames[0]["args"]["bytesBase64"].as_str().unwrap().len(),
        piece.div_ceil(3) * 4
    );
    assert!(
        frames[0]["args"].get("done").is_none(),
        "a full piece stays open"
    );
    assert!(
        frames[0]["args"].get("stageId").is_none(),
        "the first piece opens the upload"
    );
    assert_eq!(frames[1]["args"]["stageId"], stage_id);
    assert_eq!(frames[1]["args"]["bytesBase64"], "YQ==");
    assert_eq!(
        frames[1]["args"]["done"]["expected"]["byteLength"],
        piece + 1
    );
    assert_eq!(frames[1]["args"]["done"]["expected"]["sha256"], sha);
}

#[test]
fn a_file_that_ends_on_a_piece_boundary_and_an_empty_file_both_close_in_one_call() {
    let dir = temp_dir();
    let piece = 4 * 1024 * 1024;
    let exact = dir.join("exact.txt");
    std::fs::write(&exact, vec![b'a'; piece]).unwrap();
    let exact_sha = sha256_hex(&vec![b'a'; piece]);
    let work = Work::start(vec![
        closed_ref(&exact_sha, piece, "exact.txt"),
        Answer::ok(),
        closed_ref(&sha256_hex(b""), 0, "empty.txt"),
        Answer::ok(),
    ]);
    let closed = work.run(&[
        "escalate",
        "Exactly a piece",
        "--attach",
        exact.to_str().unwrap(),
    ]);
    let empty_file = dir.join("empty.txt");
    std::fs::write(&empty_file, b"").unwrap();
    let empty = work.run(&[
        "escalate",
        "Nothing yet",
        "--attach",
        empty_file.to_str().unwrap(),
    ]);
    std::fs::remove_dir_all(&dir).ok();
    assert_eq!(
        code(&closed),
        0,
        "{:?}",
        String::from_utf8_lossy(&closed.stderr)
    );
    assert_eq!(
        code(&empty),
        0,
        "{:?}",
        String::from_utf8_lossy(&empty.stderr)
    );
    let frames = work.frames();
    assert_eq!(frames.len(), 4, "{frames:?}");
    assert!(frames[0]["args"].get("stageId").is_none());
    assert_eq!(frames[0]["args"]["done"]["expected"]["byteLength"], piece);
    assert_eq!(frames[2]["args"]["bytesBase64"], "");
    assert_eq!(frames[2]["args"]["done"]["expected"]["byteLength"], 0);
}

#[test]
fn a_file_that_cannot_be_read_is_refused_before_anything_is_sent() {
    let work = Work::start(vec![]);
    let dir = temp_dir();
    let missing = dir.join("gone.txt");
    let output = work.run(&["escalate", "No file", "--attach", missing.to_str().unwrap()]);
    std::fs::remove_dir_all(&dir).ok();
    assert_eq!(code(&output), 1);
    let printed = stderr_json(&output);
    assert_eq!(printed["error"]["type"], "InputError", "{printed}");
    assert_eq!(printed["error"]["details"]["path"], "--attach", "{printed}");
    assert!(work.frames().is_empty());
}

// --- helpers ------------------------------------------------------------------

fn temp_dir() -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "junto-cli-test-{}-{}",
        std::process::id(),
        ulid::Ulid::new()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

/// Whether a build-time feature variable reads on, as src/features.rs does.
fn on(value: Option<&str>) -> bool {
    matches!(value, Some(value) if matches!(value.as_bytes(), b"1" | b"true"))
}

/// Whether this build carries fleet authority (off in ship, on in all-on).
fn authority_on() -> bool {
    on(std::option_env!("JUNTO_AUTHORITY_ENABLED"))
}

/// Whether this build carries artifacts: list, create, edit and labels.
fn artifacts_on() -> bool {
    on(std::option_env!("JUNTO_ARTIFACTS_ENABLED"))
}

/// Whether this build carries tasks (task, rulings).
fn tasks_on() -> bool {
    on(std::option_env!("JUNTO_TASKS_ENABLED"))
}

/// Whether this build carries the browser: off in a machine build, and in all-off.
fn browser_on() -> bool {
    on(std::option_env!("JUNTO_BROWSER_ENABLED")) && !on(std::option_env!("JUNTO_MACHINE_BUILD"))
}
