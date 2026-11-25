//! One failure type: every refusal is a sentence the operator can read, as
//! the TypeScript verifier and installer worded them.

use std::fmt;

#[derive(Debug, Clone)]
pub struct Error {
    message: String,
    activated: Option<bool>,
}

impl Error {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            activated: None,
        }
    }

    /// Whether the launcher was already published when the failure happened.
    pub fn attach_activation(mut self, activated: bool) -> Self {
        self.activated = Some(activated);
        self
    }

    pub fn activated(&self) -> Option<bool> {
        self.activated
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

impl fmt::Display for Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for Error {}

pub type Result<T> = std::result::Result<T, Error>;

pub fn error<T>(message: impl Into<String>) -> Result<T> {
    Err(Error::new(message))
}

/// The activation boundary was crossed or not when a first install failed: the
/// caller turns this flag into recovery guidance, never into a retry.
#[derive(Debug, Clone)]
pub struct ActivationError {
    pub message: String,
    pub activated: bool,
}

impl ActivationError {
    pub fn new(message: impl Into<String>, activated: bool) -> Self {
        Self {
            message: message.into(),
            activated,
        }
    }
}

impl fmt::Display for ActivationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for ActivationError {}
