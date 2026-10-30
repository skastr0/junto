//! The CLI's errors as values: what failed, in the shape the failure envelope
//! prints (src/cli/core/output.ts toErrorDetails), `{type, message, details?}`.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

/// Every `type` a failure envelope carries: the runtime's WorkErrorType
/// (src/shared/work-control.ts), then the CLI's own.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ErrorType {
    ScopeError,
    ClaimConflict,
    UnknownTarget,
    StaleNodeRef,
    InvalidTransition,
    RuntimeDown,
    AuthError,
    InputError,
    ProtocolError,
    InternalError,
    Paused,
    Timeout,
    ReviewerIsAuthor,
    Stale,
    NeedsUpdate,
    // The CLI's own, never sent by the runtime.
    #[serde(skip_deserializing)]
    BatchFailed,
    #[serde(skip_deserializing)]
    UncertainCompletion,
    // An overseer operation's own refusal, printed as its inner `ok:false` names it.
    #[serde(skip_deserializing)]
    Forbidden,
    #[serde(skip_deserializing)]
    InvalidArguments,
    #[serde(skip_deserializing)]
    NotFound,
    #[serde(skip_deserializing)]
    Conflict,
    #[serde(skip_deserializing)]
    Unsupported,
    // Usage: a bare group shows its help, and a flag value outside its choices.
    #[serde(skip_deserializing)]
    ShowHelp,
    #[serde(skip_deserializing)]
    InvalidValue,
}

/// A failure: printed as the `error` of the failure envelope.
#[derive(Debug, Clone, Serialize)]
pub struct Failure {
    #[serde(rename = "type")]
    pub kind: ErrorType,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

impl Failure {
    pub fn new(kind: ErrorType, message: impl Into<String>) -> Self {
        Failure {
            kind,
            message: message.into(),
            details: None,
        }
    }

    /// The same failure with these details; `details` must serialize to an object.
    pub fn with(mut self, details: Value) -> Self {
        self.details = Some(details);
        self
    }

    /// An InputError, as the CLI's InputError tagged error prints:
    /// `{message, path?, ...}` with the path first among its details.
    pub fn input(message: impl Into<String>, path: impl Into<String>) -> Self {
        Failure::new(ErrorType::InputError, message).with(json!({ "path": path.into() }))
    }

    /// One more detail, after those already there.
    pub fn and(mut self, key: &str, value: impl Into<Value>) -> Self {
        let mut details = match self.details.take() {
            Some(Value::Object(map)) => map,
            _ => Map::new(),
        };
        details.insert(key.to_string(), value.into());
        self.details = Some(Value::Object(details));
        self
    }

    /// A failure whose only detail is the step that gets past it.
    pub fn next_step(kind: ErrorType, message: impl Into<String>, next: impl Into<String>) -> Self {
        Failure::new(kind, message).with(json!({ "next_step": next.into() }))
    }

    /// Whether its details say `retryable: true`.
    pub fn retryable(&self) -> bool {
        self.details
            .as_ref()
            .and_then(|d| d.get("retryable"))
            .and_then(Value::as_bool)
            .unwrap_or(false)
    }
}

pub type Result<T, E = Failure> = std::result::Result<T, E>;
