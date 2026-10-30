//! Input and attachments (N3, cli-external): signal input, the attach kinds,
//! git, hashing and content staging (src/cli/core/signal-*.ts, content-stage.ts,
//! body-input.ts, secret-input.ts).

// Ported ahead of their commands (overseer references write, secret put).
#[allow(dead_code)]
pub mod body_input;
mod content_stage;
mod link;
mod media;
#[allow(dead_code)]
pub mod secret_input;
pub mod signal_attach;
pub mod signal_form;
pub mod signal_input;

use std::path::Path;

use serde::Serialize;

use crate::error::Result;
use crate::wire::Timeout;
pub use content_stage::StagedRef;

/// SeatRaiseKind: what a seat raises. Feedback asks for review, nothing more.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Escalate,
    Blocked,
    Feedback,
}

impl Kind {
    pub fn name(self) -> &'static str {
        match self {
            Kind::Escalate => "escalate",
            Kind::Blocked => "blocked",
            Kind::Feedback => "feedback",
        }
    }

    /// FORM_SIGNAL_KINDS: only blocked and escalate ask the operator to produce something.
    pub fn takes_form(self) -> bool {
        matches!(self, Kind::Blocked | Kind::Escalate)
    }
}

/// stageFile: put one file of this seat's into the content store, a piece
/// per call, and answer the ref to name it by. The path never crosses the
/// socket; a file of any size goes up without being whole in memory.
#[allow(dead_code)]
pub fn stage_file(
    path: &Path,
    media_type: &str,
    display_name: Option<&str>,
    timeout: Timeout,
) -> Result<StagedRef> {
    content_stage::file(
        path,
        content_stage::Label {
            media_type,
            display_name,
        },
        timeout,
    )
}
