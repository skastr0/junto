//! The overseer's closed operations (OVERSEER_OPERATION_NAMES in
//! src/shared/overseer-control.ts), each with the way its command reads its
//! input and judges its answer. The vocabulary is fixed; the build's feature
//! gates decide which of it this binary exposes (OVERSEER_CATALOG).

use crate::features::{ARTIFACTS, BROWSER, TASKS};

/// Code steps in automations (CODE_STEPS_ENABLED), as crate::features reads a gate.
pub const CODE_STEPS: bool = matches!(option_env!("JUNTO_CODE_STEPS_ENABLED"), Some(v) if matches!(v.as_bytes(), b"1" | b"true"));

/// Which automation write: where its steps sit and which ids it is given.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Write {
    /// Steps at `then`; the opId is also the new automation's id.
    Create,
    /// Steps at `change.then`.
    Edit,
    /// enable, disable, archive and run: one automation, by name.
    One,
    /// move: one automation, and the machine it runs on from now on.
    Move,
}

impl Write {
    /// The keys its command-line schema takes, in that schema's order
    /// (AutomationCreateCliArgs and the rest, src/shared/automation-control.ts).
    pub fn fields(self) -> &'static [&'static str] {
        match self {
            Write::Create => &[
                "target", "name", "trigger", "when", "then", "machine", "enabled", "limits",
            ],
            Write::Edit => &["target", "automation", "baseVersion", "change"],
            Write::One => &["target", "automation"],
            Write::Move => &["target", "automation", "machine"],
        }
    }
}

/// AutomationChange's keys, in its order: what an edit's `change` takes.
pub const CHANGE_FIELDS: &[&str] = &["name", "trigger", "when", "then", "limits"];

/// How a command reads its input and judges its answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Shape {
    /// One JSON argument, checked by main.
    Plain,
    /// `env doctor`: the report prints whole, exit 1 when a required source is unread.
    Report,
    /// `agent offboard`, `artifact move`: one row per item, exit 1 when any was refused.
    Rows,
    /// `secret put`: the value from stdin only.
    SecretPut,
    /// A prose body from `--body` or `"body"`; `empty` says what to do instead of an empty one.
    Body { empty: &'static str },
    /// An automation write: this process mints its opId, or resends `--op-id`.
    Automation(Write),
}

#[derive(Debug, PartialEq, Eq)]
pub struct Operation {
    pub name: &'static str,
    pub shape: Shape,
}

impl Operation {
    /// The family, `overseer` for the one bare verb (`status`).
    pub fn family(&self) -> &'static str {
        self.name
            .split_once('.')
            .map_or("overseer", |(family, _)| family)
    }

    pub fn verb(&self) -> &'static str {
        self.name
            .split_once('.')
            .map_or(self.name, |(_, verb)| verb)
    }

    /// commandNameFor: `overseer status`, `overseer node create`.
    pub fn command(&self) -> String {
        match self.family() {
            "overseer" => format!("overseer {}", self.verb()),
            family => format!("overseer {family} {}", self.verb()),
        }
    }

    /// overseerOperationEnabled: a gated family leaves the build's surface.
    pub fn enabled(&self) -> bool {
        match self.family() {
            "task" | "content" => TASKS,
            "artifact" => ARTIFACTS,
            "page" => BROWSER,
            _ => true,
        }
    }

    /// isOverseerMutation: anything not in OVERSEER_READ_ONLY_OPERATIONS.
    pub fn mutation(&self) -> bool {
        !READ_ONLY.contains(&self.name)
    }
}

/// OVERSEER_READ_ONLY_OPERATIONS (src/shared/overseer-control.ts).
const READ_ONLY: &[&str] = &[
    "status",
    "canvas.list",
    "canvas.read",
    "canvas.digest",
    "canvas.render",
    "node.list",
    "node.get",
    "wire.list",
    "wire.get",
    "wire.verbs",
    "agent.list",
    "agent.get",
    "agent.output",
    "terminal.list",
    "terminal.get",
    "terminal.output",
    "page.list",
    "page.get",
    "git.status",
    "git.log",
    "git.show",
    "env.show",
    "env.doctor",
    "secret.list",
    "agent.offboard-status",
    "agent.offboard-rules",
    "references.list",
    "references.read",
    "briefing.read",
];

const fn op(name: &'static str, shape: Shape) -> Operation {
    Operation { name, shape }
}

use Shape::{Automation, Body, Plain, Report, Rows, SecretPut};

pub static OPERATIONS: &[Operation] = &[
    op("status", Plain),
    op("canvas.list", Plain),
    op("canvas.read", Plain),
    op("canvas.create", Plain),
    op("canvas.batch", Plain),
    op("canvas.delete", Plain),
    op("canvas.digest", Plain),
    op("canvas.render", Plain),
    op("canvas.screenshot", Plain),
    op("node.list", Plain),
    op("node.get", Plain),
    op("node.create", Plain),
    op("node.configure", Plain),
    op("node.move", Plain),
    op("node.resize", Plain),
    op("node.recolor", Plain),
    op("node.delete", Plain),
    op("wire.list", Plain),
    op("wire.get", Plain),
    op("wire.verbs", Plain),
    op("wire.connect", Plain),
    op("wire.configure", Plain),
    op("wire.disconnect", Plain),
    op("msg.list", Plain),
    op("msg.send", Plain),
    op("msg.read", Plain),
    op("msg.reply", Plain),
    op("msg.react", Plain),
    op("content.ingest", Plain),
    op("agent.list", Plain),
    op("agent.get", Plain),
    op("agent.reseat", Plain),
    op("agent.start", Plain),
    op("agent.wake", Plain),
    op("agent.prompt", Plain),
    op("agent.output", Plain),
    op("agent.interrupt", Plain),
    op("agent.stop", Plain),
    op("terminal.list", Plain),
    op("terminal.get", Plain),
    op("terminal.start", Plain),
    op("terminal.input", Plain),
    op("terminal.output", Plain),
    op("terminal.resize", Plain),
    op("terminal.interrupt", Plain),
    op("terminal.stop", Plain),
    op("page.list", Plain),
    op("page.get", Plain),
    op("page.open", Plain),
    op("page.goto", Plain),
    op("page.eval", Plain),
    op("page.screenshot", Plain),
    op("page.close", Plain),
    op("page.stop", Plain),
    op("git.status", Plain),
    op("git.log", Plain),
    op("git.show", Plain),
    op("env.show", Plain),
    op("env.source-add", Plain),
    op("env.source-edit", Plain),
    op("env.source-remove", Plain),
    op("env.source-reorder", Plain),
    op("env.seal", Plain),
    op("env.folders", Plain),
    op("env.doctor", Report),
    op("secret.put", SecretPut),
    op("secret.delete", Plain),
    op("secret.list", Plain),
    op("agent.offboard", Rows),
    op("agent.offboard-status", Plain),
    op("agent.offboard-rules", Plain),
    op("agent.offboard-configure", Plain),
    op("references.list", Plain),
    op("references.read", Plain),
    op(
        "references.write",
        Body {
            empty: "a reference needs a body; to remove one use junto overseer references delete",
        },
    ),
    op("references.delete", Plain),
    op("briefing.read", Plain),
    op(
        "briefing.write",
        Body {
            empty: "the briefing needs a body; the operator clears it in Settings",
        },
    ),
    op("automation.create", Automation(Write::Create)),
    op("automation.edit", Automation(Write::Edit)),
    op("automation.enable", Automation(Write::One)),
    op("automation.disable", Automation(Write::One)),
    op("automation.move", Automation(Write::Move)),
    op("automation.archive", Automation(Write::One)),
    op("automation.run", Automation(Write::One)),
    op("artifact.move", Rows),
];

/// The operations this build exposes, in catalog order.
pub fn enabled() -> impl Iterator<Item = &'static Operation> {
    OPERATIONS.iter().filter(|op| op.enabled())
}

/// Any operation of the whole vocabulary, by name: an inner result may name one.
pub fn named(name: &str) -> Option<&'static Operation> {
    OPERATIONS.iter().find(|op| op.name == name)
}

/// The families in catalog order, each once: `overseer` (status) first.
pub fn families() -> Vec<&'static str> {
    enabled().fold(Vec::new(), |mut families, op| {
        if !families.contains(&op.family()) {
            families.push(op.family());
        }
        families
    })
}
