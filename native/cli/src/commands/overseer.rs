//! `overseer` (src/cli/commands/overseer.ts, overseer-automation.ts,
//! overseer-skill.ts): the closed operations of a human-granted overseer
//! seat, sent over the work socket as the op `overseer`, and the offline
//! surface that needs no daemon: the skill and capabilities. Schemas and
//! examples come from the TypeScript-built embed (N5).

mod automation;
mod catalog;
mod live;

use std::process::ExitCode;

use clap::{Args, Subcommand};
use serde_json::json;

use super::{Pending, Run};
use crate::envelope;

/// Agent-native overseer commands (JSON).
#[derive(Args)]
pub struct Overseer {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    Skill,
    Schema(Pending),
    Examples(Pending),
    Capabilities,
    #[command(flatten)]
    Live(live::Call),
}

impl Run for Overseer {
    fn run(self) -> ExitCode {
        match self.command {
            Command::Skill => envelope::print("overseer skill", envelope::ok(&skill())),
            Command::Schema(_) => Pending::refuse("overseer schema"),
            Command::Examples(_) => Pending::refuse("overseer examples"),
            Command::Capabilities => {
                envelope::print("overseer capabilities", envelope::ok(&capabilities()))
            }
            Command::Live(call) => call.run(),
        }
    }
}

/// OVERSEER_SKILL_MARKDOWN, its family list from this build's catalog.
const SKILL: &str = include_str!("overseer/skill.md");

fn skill() -> serde_json::Value {
    let families = catalog::families()
        .into_iter()
        .map(|family| {
            if family == "overseer" {
                "status"
            } else {
                family
            }
        })
        .collect::<Vec<_>>()
        .join(", ");
    json!({
        "name": "overseer",
        "offline": true,
        "daemon_required": false,
        "format": "agent-skill-markdown",
        "content": SKILL.replacen("{families}", &families, 1),
    })
}

/// OVERSEER_UNAVAILABLE: what no overseer can do, and why.
const UNAVAILABLE: [(&str, &str); 8] = [
    (
        "grant or revoke overseer",
        "Human-only toggle. Overseers cannot propagate.",
    ),
    (
        "delete own seat",
        "Direct, indirect, canvas delete, alias, or binding replacement that removes this seat is refused.",
    ),
    (
        "change what an overseer seat runs, remove it, or reseat it",
        "Operator only, for any overseer seat, this one included: agent, session, harness, host and launch. Renaming, moving, resizing and recoloring an overseer seat are allowed.",
    ),
    (
        "operator viewport mutation",
        "No pan, zoom, focus, resize, or switch. Screenshots observe only.",
    ),
    (
        "set a seat's overseer field",
        "Create, copy, configure, and reseat cannot mint or restore the grant: no draft or change carries it.",
    ),
    (
        "pause/play as authority",
        "Pause and play gate automated work only. They have no bearing on overseer command.",
    ),
    (
        "direct database or operator socket",
        "Closed overseer operations over the existing process-bind work socket only.",
    ),
    (
        "caller-supplied principal",
        "Identity is process-bind. No nodeRef or operator seat impersonation.",
    ),
];

/// overseerOfflineCapabilities: the transport this CLI implements, and the
/// authority no overseer has. Live handlers are never claimed offline.
fn capabilities() -> serde_json::Value {
    let unavailable: Vec<_> = UNAVAILABLE
        .iter()
        .map(|(capability, reason)| json!({ "capability": capability, "reason": reason }))
        .collect();
    let operations: Vec<_> = catalog::enabled().map(|op| op.name).collect();
    json!({
        "offline": true,
        "daemon_required": false,
        "transport": {
            "implemented": true,
            "work_op": "overseer",
            "request": { "operation": "OverseerOperation", "args": "optional" },
            "inner_result": "{ok:true,operation,data}|{ok:false,operation,error}",
        },
        "implemented": {
            "cli_transport": operations,
            "offline": ["overseer skill", "overseer schema", "overseer examples", "overseer capabilities"],
        },
        "unavailable": unavailable,
        "handlers": {
            "claimed": false,
            "note": "CLI ships the full catalog. Live handler availability is not claimed offline. Run overseer status under a live granted seat, or treat Unsupported as missing handler.",
        },
        "authority": {
            "grant": "human-only",
            "remote": "supported",
            "edges_required": false,
            "pause_play_has_bearing": false,
            "self_deletion": false,
            "operator_viewport_mutation": false,
            "propagation": false,
        },
    })
}
