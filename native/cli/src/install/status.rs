//! What a running core says about itself, read from the candidate's own
//! binary: `<install>/current/bin/junto machine status {}` under that machine's
//! `JUNTO_HOME`, its envelope's `data` as src/shared/machine-control.ts
//! MachineOwnStatus holds it.

use std::path::Path;
use std::time::Duration;

use serde::Deserialize;

use super::Check;
use super::Refused;
use super::run;

const STATUS_BOUND: Duration = Duration::from_secs(2);
const STATUS_MAX_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnStatus {
    pub build: String,
    pub junto_home: String,
    pub pid: i64,
    pub ready: bool,
    pub installation_id: String,
    pub machine_name: String,
}

#[derive(Deserialize)]
struct Envelope {
    ok: bool,
    command: String,
    data: Option<OwnStatus>,
}

/// The installed core's own answer, or the words that say why it gave none.
pub fn read_installed_status(directory: &Path, junto_home: &Path) -> Result<OwnStatus, Refused> {
    let program = directory.join("bin").join("junto");
    let program = program.to_string_lossy().into_owned();
    let home = junto_home.to_string_lossy().into_owned();
    let completed = run::bounded(
        &program,
        &["machine", "status", "{}"],
        &[("JUNTO_HOME", home.as_str())],
        STATUS_BOUND,
        STATUS_MAX_BYTES,
    )
    .map_err(|error| {
        Refused::new(format!("{program}: {error}")).with_check(Check::StatusUnreadable)
    })?;
    if completed.timed_out {
        return Err(Refused::new(format!(
            "{program} did not answer within {} seconds",
            STATUS_BOUND.as_secs()
        ))
        .with_check(Check::StatusUnreadable));
    }
    if completed.status != Some(0) {
        let said = completed.stderr.trim();
        return Err(Refused::new(if said.is_empty() {
            format!(
                "{program} machine status exited {}",
                completed.status.unwrap_or(-1)
            )
        } else {
            said.to_string()
        })
        .with_check(Check::StatusUnreadable));
    }
    let envelope: Envelope = serde_json::from_str(completed.stdout.trim()).map_err(|error| {
        Refused::new(format!("machine status answered something else: {error}"))
            .with_check(Check::StatusUnreadable)
    })?;
    match (envelope.ok, envelope.command.as_str(), envelope.data) {
        (true, "machine status", Some(data)) => Ok(data),
        _ => Err(Refused::new(
            "machine status answered something other than this machine's own status",
        )
        .with_check(Check::StatusUnreadable)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_receipt_that_predates_this_builds_fields_is_read() {
        // An installed 3363 machine answers with build, form, installation id,
        // machine name, home, pid and ready; nothing newer is required.
        let text = r#"{"ok":true,"command":"machine status","data":{"build":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","form":"mac-mini","installationId":"install-one","machineName":"mini","juntoHome":"/home/peer","pid":71,"ready":true}}"#;
        let envelope: Envelope = serde_json::from_str(text).expect("the envelope");
        assert!(envelope.ok);
        let status = envelope.data.expect("the status");
        assert_eq!(status.pid, 71);
        assert_eq!(status.installation_id, "install-one");
        assert!(status.ready);
    }

    #[test]
    fn an_envelope_that_is_not_the_own_status_is_refused() {
        let parsed: Option<Envelope> =
            serde_json::from_str(r#"{"ok":false,"command":"machine status"}"#).ok();
        let envelope = parsed.expect("an envelope");
        assert!(!envelope.ok);
        let good: Envelope = serde_json::from_str(
            r#"{"ok":true,"command":"machine status","data":{"build":"aa","version":"0.11.15","form":"linux","installationId":"i","machineName":"m","juntoHome":"/home/u","pid":7,"ready":true}}"#,
        )
        .expect("the own status decodes");
        let data = good.data.expect("data");
        assert_eq!(data.pid, 7);
        assert!(data.ready);
    }
}
