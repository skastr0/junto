//! One companion connection (src/shared/companion-session.ts): `hello` goes
//! out before any request is read, requests are pipelined and each answer is
//! written as soon as its relay settles, and what the phone asked for becomes
//! what it follows: the app's change notifications become events, whoever
//! made the change. A channel silent for two minutes is closed.
//!
//! Threads stand in for the TypeScript event loop: one per request, one for
//! the long poll, one reading stdin. What the connection follows sits behind
//! one lock, never held across a call to the app.

use std::collections::{HashMap, HashSet};
use std::io::{self, BufRead, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::Duration;

use serde_json::{Value, json};

use super::frame::{self, Code, Request};
use super::relay::Relay;

/// COMPANION_IDLE_CLOSE_MS.
const IDLE_CLOSE: Duration = Duration::from_secs(120);
/// The long poll's window for change notifications.
const WAIT_MS: u64 = 25_000;
/// COMPANION_MAIL_MAX_LIMIT.
const MAIL_MAX_LIMIT: u64 = 200;
/// Seats whose threads one connection follows at once; one more drops the oldest.
const THREAD_FOCUS_MAX: usize = 8;

/// What a read of stdin gives the session.
enum Input {
    Line(String),
    /// A line ran past the inbound limit: the channel ends.
    Overflow,
    End,
}

/// Lines of stdin, none held past the inbound limit counting its newline: a
/// line still open at the cap is never buffered further.
fn read_lines(sender: mpsc::Sender<Input>) {
    let mut stdin = io::stdin().lock();
    let mut held: Vec<u8> = Vec::new();
    loop {
        let chunk = match stdin.fill_buf() {
            Ok([]) | Err(_) => break,
            Ok(chunk) => chunk,
        };
        let (part, newline) = match chunk.iter().position(|&b| b == b'\n') {
            Some(at) => (&chunk[..at], true),
            None => (chunk, false),
        };
        if held.len() + part.len() + usize::from(newline) > frame::MAX_INBOUND_BYTES {
            let _ = sender.send(Input::Overflow);
            return;
        }
        held.extend_from_slice(part);
        let used = part.len() + usize::from(newline);
        stdin.consume(used);
        if newline {
            let line = String::from_utf8_lossy(&std::mem::take(&mut held)).into_owned();
            if sender.send(Input::Line(line)).is_err() {
                return;
            }
        }
    }
    if !held.is_empty() {
        let _ = sender.send(Input::Line(String::from_utf8_lossy(&held).into_owned()));
    }
    let _ = sender.send(Input::End);
}

// --- what the connection follows ---------------------------------------------

/// Pairs kept in the order they were first set, as a JavaScript Map keeps them.
#[derive(Clone)]
struct Ordered<V>(Vec<(String, V)>);

impl<V> Default for Ordered<V> {
    fn default() -> Self {
        Ordered(Vec::new())
    }
}

impl<V> Ordered<V> {
    fn get(&self, key: &str) -> Option<&V> {
        self.0.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    fn get_mut(&mut self, key: &str) -> Option<&mut V> {
        self.0.iter_mut().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    fn set(&mut self, key: String, value: V) {
        match self.get_mut(&key) {
            Some(held) => *held = value,
            None => self.0.push((key, value)),
        }
    }

    fn remove(&mut self, key: &str) {
        self.0.retain(|(k, _)| k != key);
    }

    fn keys(&self) -> impl Iterator<Item = &String> {
        self.0.iter().map(|(k, _)| k)
    }
}

/// Each item by its id, as JSON, in the order given.
fn keyed(items: &[Value], id: &str) -> Ordered<String> {
    let mut keyed = Ordered::default();
    for item in items {
        keyed.set(text(item, id).to_string(), item.to_string());
    }
    keyed
}

#[derive(Clone)]
struct Seat {
    canvas: String,
    node: String,
}

impl Seat {
    fn of(request: &Request) -> Seat {
        Seat {
            canvas: request.arg("canvasName").unwrap_or_default().into(),
            node: request.arg("nodeId").unwrap_or_default().into(),
        }
    }

    fn reference(&self) -> String {
        format!("{}\u{0}{}", self.canvas, self.node)
    }
}

struct Focus {
    seat: Seat,
    preambles: HashSet<String>,
}

struct Threads {
    seat: Seat,
    sent: HashMap<String, String>,
}

struct CanvasFocus {
    canvas: String,
    nodes: Ordered<String>,
    wires: Ordered<String>,
}

struct Comments {
    canvas: String,
    subject: Value,
    sent: String,
}

#[derive(Default)]
struct Follow {
    /// `feed.subscribe`, with its canvas filter when it named one.
    feed: Option<Option<String>>,
    sent_feeds: HashMap<String, String>,
    canvases: Option<String>,
    machines: Option<Vec<Value>>,
    /// The seats of each listed canvas.
    seat_canvases: Ordered<Vec<String>>,
    sent_seats: HashMap<String, String>,
    focus: Option<Focus>,
    mail: Option<(Seat, HashMap<String, String>)>,
    threads: Ordered<Threads>,
    artifacts_canvas: Option<String>,
    comments: Option<Comments>,
    canvas_seq: u64,
    canvas: Option<CanvasFocus>,
}

impl Follow {
    fn subscribed(&self) -> bool {
        self.feed.is_some()
            || self.canvases.is_some()
            || self.machines.is_some()
            || !self.seat_canvases.0.is_empty()
            || self.focus.is_some()
            || self.mail.is_some()
            || !self.threads.0.is_empty()
            || self.comments.is_some()
            || self.artifacts_canvas.is_some()
            || self.canvas.is_some()
    }

    /// Records a seat; true when it differs from what was last sent.
    fn note_seat(&mut self, canvas: &str, seat: &Value) -> bool {
        let reference = format!("{canvas}\u{0}{}", text(seat, "nodeId"));
        let key = seat.to_string();
        if self.sent_seats.get(&reference) == Some(&key) {
            return false;
        }
        self.sent_seats.insert(reference, key);
        true
    }
}

// --- reading what the app answered ---------------------------------------------

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or_default()
}

fn list<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
}

/// The result of an answered frame, when it carries `key`.
fn answered<'a>(response: &'a Value, key: &str) -> Option<&'a Value> {
    let result = response
        .get("result")
        .filter(|_| response.get("ok") == Some(&Value::Bool(true)))?;
    result.get(key).map(|_| result)
}

fn refused_as(response: &Value, code: &str) -> bool {
    response.get("ok") == Some(&Value::Bool(false))
        && response.pointer("/error/code").and_then(Value::as_str) == Some(code)
}

/// A feed with its clock fields zeroed: two feeds that say the same compare equal.
fn feed_key(feed: &Value) -> String {
    let mut feed = feed.clone();
    if let Some(object) = feed.as_object_mut() {
        object.insert("generatedAt".into(), json!(0));
    }
    for section in feed
        .get_mut("sections")
        .and_then(Value::as_array_mut)
        .into_iter()
        .flatten()
    {
        for item in section
            .get_mut("items")
            .and_then(Value::as_array_mut)
            .into_iter()
            .flatten()
        {
            if let Some(item) = item.as_object_mut() {
                item.insert("ageMs".into(), json!(0));
            }
        }
    }
    feed.to_string()
}

/// A check's age grows on its own, so age alone is no change; a newer check is.
fn machines_differ(sent: &[Value], next: &[Value]) -> bool {
    let ageless = |machine: &Value| {
        let mut machine = machine.clone();
        if let Some(check) = machine.get_mut("lastCheck").and_then(Value::as_object_mut) {
            check.insert("checkedAgoMs".into(), json!(0));
        }
        machine.to_string()
    };
    let age = |machine: &Value| {
        machine
            .pointer("/lastCheck/checkedAgoMs")
            .and_then(Value::as_f64)
    };
    sent.len() != next.len()
        || sent.iter().zip(next).any(|(before, machine)| {
            ageless(before) != ageless(machine)
                || matches!((age(machine), age(before)), (Some(now), Some(then)) if now < then)
        })
}

/// A seat detail as a seat: what only the detail carries goes.
fn seat_only(detail: &Value) -> Value {
    let mut seat = detail.clone();
    if let Some(object) = seat.as_object_mut() {
        for key in ["briefing", "preambles", "signals", "activity", "connected"] {
            object.shift_remove(key);
        }
    }
    seat
}

// --- the session -----------------------------------------------------------------

struct Session {
    relay: Relay,
    open: AtomicBool,
    follow: Mutex<Follow>,
    polling: Mutex<bool>,
    internal_id: AtomicU64,
}

enum SeatThreads {
    Gone,
    Unknown,
    Listed(Vec<Value>),
}

impl Session {
    fn follow(&self) -> MutexGuard<'_, Follow> {
        self.follow.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn write(&self, line: &str) {
        if self.open.load(Ordering::SeqCst) {
            let mut stdout = io::stdout().lock();
            // A phone that hung up has no one left to tell.
            let _ = stdout
                .write_all(line.as_bytes())
                .and_then(|()| stdout.flush());
        }
    }

    fn emit(&self, event: &str, data: Value) {
        self.write(&frame::encode(&frame::event(event, data)));
    }

    /// A request of the session's own, numbered apart from the phone's.
    fn ask(&self, op: &str, args: Value) -> Value {
        let id = self.internal_id.fetch_add(1, Ordering::SeqCst) + 1;
        self.relay.call(&json!({ "v": frame::PROTOCOL, "type": "request", "id": format!("_event.{id}"), "op": op, "args": args }))
    }

    /// Follows a seat's mail from its whole recent history, so an older
    /// message is never mistaken for a new one; only a seeded focus is followed.
    fn follow_mail(&self, seat: Seat) {
        let response = self.ask(
            "mail.list",
            json!({ "canvasName": seat.canvas, "nodeId": seat.node, "limit": MAIL_MAX_LIMIT }),
        );
        let mut sent = HashMap::new();
        if let Some(result) = answered(&response, "messages").filter(|r| r.get("cut").is_none()) {
            for message in list(result, "messages") {
                sent.insert(text(message, "messageId").to_string(), message.to_string());
            }
        }
        self.follow().mail = Some((seat, sent));
    }

    /// A seat's newest page of threads.
    fn seat_threads(&self, seat: &Seat) -> SeatThreads {
        let response = self.ask(
            "threads.list",
            json!({ "canvasName": seat.canvas, "nodeId": seat.node }),
        );
        if refused_as(&response, "not-found") {
            return SeatThreads::Gone;
        }
        match answered(&response, "threads") {
            Some(result) => SeatThreads::Listed(list(result, "threads").to_vec()),
            None => SeatThreads::Unknown,
        }
    }

    /// Follows a seat's threads from what the phone was just answered; its
    /// newest page is read again at once, and a thread the phone holds that
    /// changed since goes out now.
    fn follow_threads(&self, seat: Seat, given: &[Value]) {
        let reference = seat.reference();
        {
            let mut follow = self.follow();
            if let Some(followed) = follow.threads.get_mut(&reference) {
                for thread in given {
                    followed
                        .sent
                        .insert(text(thread, "threadId").to_string(), thread.to_string());
                }
                return;
            }
            let sent = given
                .iter()
                .map(|t| (text(t, "threadId").to_string(), t.to_string()))
                .collect();
            follow.threads.set(
                reference.clone(),
                Threads {
                    seat: seat.clone(),
                    sent,
                },
            );
            let over = follow.threads.0.len().saturating_sub(THREAD_FOCUS_MAX);
            follow.threads.0.drain(..over);
        }
        let SeatThreads::Listed(threads) = self.seat_threads(&seat) else {
            return;
        };
        let mut follow = self.follow();
        let Some(followed) = follow.threads.get_mut(&reference) else {
            return;
        };
        for thread in threads {
            let id = text(&thread, "threadId").to_string();
            let key = thread.to_string();
            let held = followed.sent.insert(id, key.clone());
            if held.as_ref().is_some_and(|held| *held != key) {
                self.emit(
                    "thread.changed",
                    json!({ "canvasName": seat.canvas, "nodeId": seat.node, "thread": thread }),
                );
            }
        }
    }

    /// Reads again what the connection follows and sends what differs.
    fn refresh(&self, signals: &[Value], artifacts: &[Value]) {
        {
            let follow = self.follow();
            for change in artifacts {
                if follow
                    .artifacts_canvas
                    .as_deref()
                    .is_some_and(|c| c == text(change, "canvasName"))
                {
                    self.emit("artifact.changed", change.clone());
                }
            }
            // signal.changed: every upsert, whoever made it, for a subscribed feed or the focused seat.
            for signal in signals {
                let canvas = text(signal, "canvasName");
                let in_feed = follow
                    .feed
                    .as_ref()
                    .is_some_and(|filter| filter.as_deref().is_none_or(|c| c == canvas));
                let on_focus = follow.focus.as_ref().is_some_and(|f| {
                    f.seat.canvas == canvas && f.seat.node == text(signal, "nodeId")
                });
                if in_feed || on_focus {
                    self.emit("signal.changed", json!({ "signal": signal }));
                }
            }
        }
        if self.follow().canvases.is_some() {
            let response = self.ask("canvases.list", json!({}));
            if let Some(result) = answered(&response, "canvases") {
                let key = result["canvases"].to_string();
                let mut follow = self.follow();
                if follow.canvases.as_ref() != Some(&key) {
                    follow.canvases = Some(key);
                    self.emit(
                        "canvases.changed",
                        json!({ "canvases": result["canvases"] }),
                    );
                }
            }
        }
        if self.follow().machines.is_some() {
            let response = self.ask("machines.list", json!({}));
            if let Some(result) = answered(&response, "machines") {
                let machines = list(result, "machines").to_vec();
                let mut follow = self.follow();
                if follow
                    .machines
                    .as_deref()
                    .is_some_and(|sent| machines_differ(sent, &machines))
                {
                    self.emit("machines.changed", json!({ "machines": &machines }));
                    follow.machines = Some(machines);
                }
            }
        }
        let feed = self.follow().feed.clone();
        if let Some(filter) = feed {
            let args = filter.map_or_else(|| json!({}), |canvas| json!({ "canvasName": canvas }));
            let response = self.ask("feed.get", args);
            if let Some(result) = answered(&response, "feeds") {
                let mut follow = self.follow();
                for feed in list(result, "feeds") {
                    let key = feed_key(feed);
                    let canvas = text(feed, "canvasName").to_string();
                    if follow.sent_feeds.get(&canvas) == Some(&key) {
                        continue;
                    }
                    follow.sent_feeds.insert(canvas, key);
                    self.emit("feed.changed", json!({ "feed": feed }));
                }
            }
        }
        let canvases: Vec<String> = self.follow().seat_canvases.keys().cloned().collect();
        for canvas in canvases {
            let response = self.ask("seats.list", json!({ "canvasName": canvas }));
            let Some(result) = answered(&response, "seats") else {
                continue;
            };
            let mut follow = self.follow();
            let mut present = Vec::new();
            for seat in list(result, "seats") {
                let node = text(seat, "nodeId").to_string();
                if let Some(members) = follow.seat_canvases.get_mut(&canvas)
                    && !members.contains(&node)
                {
                    members.push(node.clone());
                }
                present.push(node);
                if follow.note_seat(&canvas, seat) {
                    self.emit(
                        "seat.changed",
                        json!({ "canvasName": canvas, "seat": seat }),
                    );
                }
            }
            let gone: Vec<String> = follow
                .seat_canvases
                .get(&canvas)
                .map(|members| {
                    members
                        .iter()
                        .filter(|m| !present.contains(m))
                        .cloned()
                        .collect()
                })
                .unwrap_or_default();
            for node in gone {
                if let Some(members) = follow.seat_canvases.get_mut(&canvas) {
                    members.retain(|m| *m != node);
                }
                follow.sent_seats.remove(&format!("{canvas}\u{0}{node}"));
                self.emit(
                    "seat.removed",
                    json!({ "canvasName": canvas, "nodeId": node }),
                );
            }
        }
        let focus = self.follow().focus.as_ref().map(|f| f.seat.clone());
        if let Some(seat) = focus {
            let response = self.ask(
                "seat.get",
                json!({ "canvasName": seat.canvas, "nodeId": seat.node }),
            );
            let mut follow = self.follow();
            if let Some(result) = answered(&response, "seat") {
                let detail = &result["seat"];
                if follow.note_seat(&seat.canvas, &seat_only(detail)) {
                    self.emit(
                        "seat.changed",
                        json!({ "canvasName": seat.canvas, "seat": seat_only(detail) }),
                    );
                }
                for preamble in list(detail, "preambles").iter().rev() {
                    let id = text(preamble, "preambleId").to_string();
                    let fresh = follow
                        .focus
                        .as_mut()
                        .is_some_and(|f| f.preambles.insert(id));
                    if fresh {
                        self.emit("preamble", json!({ "canvasName": seat.canvas, "nodeId": seat.node, "preamble": preamble }));
                    }
                }
            } else if refused_as(&response, "not-found") {
                follow.focus = None;
                if !follow
                    .seat_canvases
                    .get(&seat.canvas)
                    .is_some_and(|m| m.contains(&seat.node))
                {
                    self.emit(
                        "seat.removed",
                        json!({ "canvasName": seat.canvas, "nodeId": seat.node }),
                    );
                }
                follow.sent_seats.remove(&seat.reference());
            }
        }
        let open_canvas = self.follow().canvas.as_ref().map(|c| c.canvas.clone());
        if let Some(canvas) = open_canvas {
            let response = self.ask("canvas.open", json!({ "canvasName": canvas }));
            let mut follow = self.follow();
            let still = |f: &Follow| f.canvas.as_ref().is_some_and(|c| c.canvas == canvas);
            let held = follow.canvas.as_ref().filter(|c| c.canvas == canvas);
            if let (Some(result), Some(focus)) = (answered(&response, "wires"), held) {
                let (nodes, changed_nodes, removed_nodes) =
                    delta(list(result, "nodes"), "nodeId", &focus.nodes);
                let (wires, changed_wires, removed_wires) =
                    delta(list(result, "wires"), "wireId", &focus.wires);
                if changed_nodes.len()
                    + removed_nodes.len()
                    + changed_wires.len()
                    + removed_wires.len()
                    > 0
                {
                    follow.canvas = Some(CanvasFocus {
                        canvas: canvas.clone(),
                        nodes,
                        wires,
                    });
                    follow.canvas_seq += 1;
                    self.emit(
                        "canvas.changed",
                        json!({
                            "canvasName": canvas,
                            "seq": follow.canvas_seq,
                            "nodes": changed_nodes,
                            "wires": changed_wires,
                            "removedNodes": removed_nodes,
                            "removedWires": removed_wires,
                        }),
                    );
                }
            } else if refused_as(&response, "not-found") && still(&follow) {
                follow.canvas = None;
            }
        }
        let comments = self
            .follow()
            .comments
            .as_ref()
            .map(|c| (c.canvas.clone(), c.subject.clone()));
        if let Some((canvas, subject)) = comments {
            let response = self.ask(
                "comments.list",
                json!({ "canvasName": canvas, "subject": subject }),
            );
            let mut follow = self.follow();
            let still = |f: &Follow| f.comments.as_ref().is_some_and(|c| c.canvas == canvas);
            if let Some(result) = answered(&response, "threads") {
                let key = result.to_string();
                if follow.comments.as_ref().is_some_and(|c| c.sent != key) && still(&follow) {
                    follow.comments = Some(Comments {
                        canvas: canvas.clone(),
                        subject: subject.clone(),
                        sent: key,
                    });
                    self.emit(
                        "comments.changed",
                        json!({ "canvasName": canvas, "subject": subject }),
                    );
                }
            } else if refused_as(&response, "not-found") && still(&follow) {
                follow.comments = None;
            }
        }
        let followed: Vec<(String, Seat)> = self
            .follow()
            .threads
            .0
            .iter()
            .map(|(r, t)| (r.clone(), t.seat.clone()))
            .collect();
        for (reference, seat) in followed {
            match self.seat_threads(&seat) {
                SeatThreads::Gone => self.follow().threads.remove(&reference),
                SeatThreads::Unknown => {}
                SeatThreads::Listed(threads) => {
                    let mut follow = self.follow();
                    let Some(held) = follow.threads.get_mut(&reference) else {
                        continue;
                    };
                    for thread in threads.iter().rev() {
                        let key = thread.to_string();
                        if held.sent.get(text(thread, "threadId")) == Some(&key) {
                            continue;
                        }
                        held.sent.insert(text(thread, "threadId").to_string(), key);
                        self.emit("thread.changed", json!({ "canvasName": seat.canvas, "nodeId": seat.node, "thread": thread }));
                    }
                }
            }
        }
        let mail = self.follow().mail.as_ref().map(|(seat, _)| seat.clone());
        if let Some(seat) = mail {
            let response = self.ask(
                "mail.list",
                json!({ "canvasName": seat.canvas, "nodeId": seat.node, "limit": MAIL_MAX_LIMIT }),
            );
            if let Some(result) = answered(&response, "messages").filter(|r| r.get("cut").is_none())
            {
                let mut follow = self.follow();
                let Some((_, sent)) = follow.mail.as_mut() else {
                    return;
                };
                for message in list(result, "messages").iter().rev() {
                    let key = message.to_string();
                    let id = text(message, "messageId").to_string();
                    if sent.get(&id) == Some(&key) {
                        continue;
                    }
                    sent.insert(id, key);
                    self.emit("mail.changed", json!({ "canvasName": seat.canvas, "nodeId": seat.node, "message": message }));
                }
            }
        }
    }

    /// The long poll: a change after the cursor, read against what was sent.
    fn poll(self: &Arc<Self>) {
        let mut cursor: Option<String> = None;
        while self.open.load(Ordering::SeqCst) && self.follow().subscribed() {
            // The app went away mid-poll; the next request will say so.
            let Some(change) = self.relay.wait_change(cursor.as_deref(), WAIT_MS) else {
                break;
            };
            if !self.open.load(Ordering::SeqCst) {
                break;
            }
            // The first cursor may already count a change made while the
            // phone's answer was on its way: read once, then wait.
            let first = cursor.is_none();
            cursor = Some(change.cursor);
            if first || change.changed || change.reset || !change.signals.is_empty() {
                self.refresh(&change.signals, &change.artifacts);
            }
        }
        *self.polling.lock().unwrap_or_else(|p| p.into_inner()) = false;
    }

    fn ensure_polling(self: &Arc<Self>) {
        let mut polling = self.polling.lock().unwrap_or_else(|p| p.into_inner());
        if !*polling && self.follow().subscribed() {
            *polling = true;
            let session = Arc::clone(self);
            thread::spawn(move || session.poll());
        }
    }

    /// One phone request: relayed, noted as something to follow, answered.
    fn handle(self: &Arc<Self>, request: Request) {
        let mut response = self.relay.call(&request.frame);
        let op = request.op.as_str();
        if response.get("ok") == Some(&Value::Bool(true)) {
            let mut follow = self.follow();
            let canvas = request.arg("canvasName").map(str::to_string);
            match op {
                "feed.subscribe" => {
                    if let Some(result) = answered(&response, "feeds") {
                        follow.feed = Some(canvas);
                        follow.sent_feeds = list(result, "feeds")
                            .iter()
                            .map(|f| (text(f, "canvasName").to_string(), feed_key(f)))
                            .collect();
                    }
                }
                "feed.unsubscribe" => {
                    follow.feed = None;
                    follow.sent_feeds.clear();
                }
                "canvases.list" => {
                    if let Some(result) = answered(&response, "canvases") {
                        follow.canvases = Some(result["canvases"].to_string());
                    }
                }
                "machines.list" => {
                    if let Some(result) = answered(&response, "machines") {
                        follow.machines = Some(list(result, "machines").to_vec());
                    }
                }
                "seats.list" => {
                    if let Some(result) = answered(&response, "seats") {
                        let canvas = canvas.unwrap_or_default();
                        let members = list(result, "seats")
                            .iter()
                            .map(|s| text(s, "nodeId").to_string())
                            .collect();
                        for seat in list(result, "seats") {
                            follow.note_seat(&canvas, seat);
                        }
                        follow.seat_canvases.set(canvas, members);
                    }
                }
                "seat.get" => {
                    if let Some(result) = answered(&response, "seat") {
                        let detail = &result["seat"];
                        let seat = Seat::of(&request);
                        follow.note_seat(&seat.canvas, &seat_only(detail));
                        let preambles = list(detail, "preambles")
                            .iter()
                            .map(|p| text(p, "preambleId").to_string())
                            .collect();
                        follow.focus = Some(Focus { seat, preambles });
                    }
                }
                "canvas.open" => {
                    if answered(&response, "wires").is_some() {
                        follow.canvas_seq += 1;
                        let result = &mut response["result"];
                        follow.canvas = Some(CanvasFocus {
                            canvas: canvas.unwrap_or_default(),
                            nodes: keyed(list(result, "nodes"), "nodeId"),
                            wires: keyed(list(result, "wires"), "wireId"),
                        });
                        result["seq"] = json!(follow.canvas_seq);
                    }
                }
                "canvas.close" => {
                    if follow
                        .canvas
                        .as_ref()
                        .is_some_and(|c| Some(&c.canvas) == canvas.as_ref())
                    {
                        follow.canvas = None;
                    }
                }
                "threads.read" => {
                    // The phone has the thread as its read left it: no echo of its own read.
                    if let Some(result) = answered(&response, "thread") {
                        let thread = &result["thread"];
                        if let Some(followed) =
                            follow.threads.get_mut(&Seat::of(&request).reference())
                        {
                            followed
                                .sent
                                .insert(text(thread, "threadId").to_string(), thread.to_string());
                        }
                    }
                }
                "artifacts.subscribe" => follow.artifacts_canvas = canvas,
                "artifacts.unsubscribe" => follow.artifacts_canvas = None,
                "comments.list" => {
                    if let Some(result) = answered(&response, "threads") {
                        let subject = request
                            .args()
                            .get("subject")
                            .cloned()
                            .unwrap_or(Value::Null);
                        follow.comments = Some(Comments {
                            canvas: canvas.unwrap_or_default(),
                            subject,
                            sent: result.to_string(),
                        });
                    }
                }
                _ => {}
            }
        }
        self.write(&frame::encode(&response));
        let ok = response.get("ok") == Some(&Value::Bool(true));
        if ok && matches!(op, "seat.get" | "mail.list") {
            self.follow_mail(Seat::of(&request));
        }
        if ok && matches!(op, "threads.list" | "thread.get") {
            let given = if op == "threads.list" {
                answered(&response, "threads").map(|r| list(r, "threads").to_vec())
            } else {
                None
            };
            self.follow_threads(Seat::of(&request), &given.unwrap_or_default());
        }
        self.ensure_polling();
    }
}

/// What differs from what was sent, whole, and what is gone.
fn delta(
    items: &[Value],
    id: &str,
    sent: &Ordered<String>,
) -> (Ordered<String>, Vec<Value>, Vec<String>) {
    let next = keyed(items, id);
    let changed = items
        .iter()
        .filter(|item| sent.get(text(item, id)) != next.get(text(item, id)))
        .cloned()
        .collect();
    let removed = sent
        .keys()
        .filter(|key| next.get(key).is_none())
        .cloned()
        .collect();
    (next, changed, removed)
}

/// Runs one connection to its end.
pub fn run(relay: Relay) {
    // Start reading before anything waits: a phone pipelines its first
    // requests right behind the connection.
    let (sender, lines) = mpsc::channel();
    thread::spawn(move || read_lines(sender));

    let session = Arc::new(Session {
        relay,
        open: AtomicBool::new(true),
        follow: Mutex::new(Follow::default()),
        polling: Mutex::new(false),
        internal_id: AtomicU64::new(0),
    });
    match session.relay.hello() {
        Ok(hello) => session.emit("hello", hello),
        Err((code, message)) => {
            return session.write(&frame::connection_error_line(code, Some(&message)));
        }
    }

    let mut pending = Vec::new();
    loop {
        let line = match lines.recv_timeout(IDLE_CLOSE) {
            Ok(Input::Line(line)) => line,
            Ok(Input::Overflow) => {
                session.write(&frame::connection_error_line(Code::TooLarge, None));
                break;
            }
            Ok(Input::End) | Err(RecvTimeoutError::Timeout | RecvTimeoutError::Disconnected) => {
                break;
            }
        };
        let line = line.strip_suffix('\r').unwrap_or(&line);
        if line.trim().is_empty() {
            continue;
        }
        match frame::decode(line) {
            Ok(request) => {
                let session = Arc::clone(&session);
                pending.push(thread::spawn(move || session.handle(request)));
            }
            Err(refusal) => {
                session.write(&refusal.line());
                if refusal.close {
                    break;
                }
            }
        }
    }
    for flight in pending {
        let _ = flight.join();
    }
    session.open.store(false, Ordering::SeqCst);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_feeds_and_machines_without_their_clocks() {
        let feed = |at: u64, age: u64| json!({ "canvasName": "c", "generatedAt": at, "sections": [{ "items": [{ "id": "s", "ageMs": age }] }] });
        assert_eq!(feed_key(&feed(1, 5)), feed_key(&feed(2, 9)));
        let machine = |ago: u64, state: &str| json!({ "name": "m", "state": state, "lastCheck": { "checkedAgoMs": ago } });
        assert!(!machines_differ(&[machine(10, "up")], &[machine(20, "up")]));
        assert!(machines_differ(&[machine(10, "up")], &[machine(5, "up")]));
        assert!(machines_differ(
            &[machine(10, "up")],
            &[machine(10, "down")]
        ));
        assert!(machines_differ(&[], &[machine(10, "up")]));
    }

    #[test]
    fn finds_what_changed_on_a_canvas() {
        let sent = keyed(
            &[
                json!({ "nodeId": "a", "x": 1 }),
                json!({ "nodeId": "b", "x": 1 }),
            ],
            "nodeId",
        );
        let (_, changed, removed) = delta(
            &[json!({ "nodeId": "a", "x": 2 }), json!({ "nodeId": "c" })],
            "nodeId",
            &sent,
        );
        assert_eq!(
            changed,
            vec![json!({ "nodeId": "a", "x": 2 }), json!({ "nodeId": "c" })]
        );
        assert_eq!(removed, vec!["b".to_string()]);
    }

    #[test]
    fn keeps_a_seat_apart_from_its_detail() {
        let detail = json!({ "nodeId": "n", "briefing": 1, "title": "t", "preambles": [], "signals": [], "activity": [], "connected": [] });
        assert_eq!(seat_only(&detail), json!({ "nodeId": "n", "title": "t" }));
    }
}
