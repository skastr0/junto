//! `env` (src/cli/commands/env.ts): this seat's region environment report,
//! names and sources, never a value.

use std::process::ExitCode;

use clap::{Args, Subcommand};
use serde::Serialize;
use serde_json::Value;

use super::{Run, Timeout};
use crate::envelope::{self, Answer, Reply};
use crate::error::{ErrorType, Failure};
use crate::{ops, wire};

#[derive(Serialize)]
pub struct ReportArgs {}

ops! {
    ReportArgs => "env.report",
}

/// This seat's region environment
#[derive(Args)]
pub struct Env {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    Report {
        #[command(flatten)]
        timeout: Timeout,
    },
}

impl Run for Env {
    fn run(self) -> ExitCode {
        let Command::Report { timeout } = self.command;
        envelope::print("env report", report(timeout))
    }
}

/// The report whole, exit 1 when a seat depending on it would be refused at launch.
fn report(timeout: Timeout) -> Answer {
    let data = wire::call(&ReportArgs {}, timeout.into())?;
    let report: Value = serde_json::from_str(data.get())
        .map_err(|e| Failure::new(ErrorType::InternalError, e.to_string()))?;
    Ok(Reply {
        unmet: blocks_launch(&report),
        data,
    })
}

/// reportBlocksLaunch (src/cli/core/env-report.ts): a `required` source that
/// could not be read, wherever a source row appears in the report.
pub fn blocks_launch(report: &Value) -> bool {
    match report {
        Value::Array(items) => items.iter().any(blocks_launch),
        Value::Object(record) => {
            let blocking = record.get("sourceId").is_some_and(Value::is_string)
                && record.get("required") == Some(&Value::Bool(true))
                && matches!(
                    record.get("status").and_then(Value::as_str),
                    Some("missing" | "error")
                );
            blocking || record.values().any(blocks_launch)
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_required_source_not_read_blocks_launch() {
        let row =
            |required, status| json!({ "sourceId": "s", "required": required, "status": status });
        assert!(blocks_launch(
            &json!({ "regions": [{ "sources": [row(true, "missing")] }] })
        ));
        assert!(!blocks_launch(
            &json!({ "regions": [{ "sources": [row(false, "error"), row(true, "ok")] }] })
        ));
    }
}
