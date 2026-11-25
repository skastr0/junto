//! The closed list of far install refusal codes: one name a refusal can carry
//! into `details.check`, so the window shows the same sentence for a fault
//! wherever it happened. The list is checked in once, under `src/contract`, and
//! both the far enum and the near decoder fail if their own list differs.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Check {
    BoatKeyNotPlaced,
    BundleManifestInvalid,
    BundleMismatch,
    BundleNotDirectory,
    BundleSpecialFile,
    BundleWritableByOthers,
    CoreMismatch,
    DatabaseCopyFailed,
    DatabaseNotPrivate,
    HomeLockRefused,
    InstallFolderNotOurs,
    InstallLeaseUnavailable,
    InstallationChanged,
    InstalledNotStarted,
    MachinePathUnsafe,
    RestoreFinishBlocked,
    RestoreInterrupted,
    RestoreOwed,
    RunningSeatsUnreported,
    SeatsDidNotStop,
    SendInProgress,
    ServiceNotOurs,
    ServiceNotQuiescent,
    ServicePlatformUnsupported,
    StartAndRestoreFailed,
    StartFailed,
    StartRolledBack,
    StatusUnreadable,
}

#[cfg(test)]
impl Check {
    /// Every code, in the sorted order the fixture holds.
    pub const ALL: &'static [Check] = &[
        Check::BoatKeyNotPlaced,
        Check::BundleManifestInvalid,
        Check::BundleMismatch,
        Check::BundleNotDirectory,
        Check::BundleSpecialFile,
        Check::BundleWritableByOthers,
        Check::CoreMismatch,
        Check::DatabaseCopyFailed,
        Check::DatabaseNotPrivate,
        Check::HomeLockRefused,
        Check::InstallFolderNotOurs,
        Check::InstallLeaseUnavailable,
        Check::InstallationChanged,
        Check::InstalledNotStarted,
        Check::MachinePathUnsafe,
        Check::RestoreFinishBlocked,
        Check::RestoreInterrupted,
        Check::RestoreOwed,
        Check::RunningSeatsUnreported,
        Check::SeatsDidNotStop,
        Check::SendInProgress,
        Check::ServiceNotOurs,
        Check::ServiceNotQuiescent,
        Check::ServicePlatformUnsupported,
        Check::StartAndRestoreFailed,
        Check::StartFailed,
        Check::StartRolledBack,
        Check::StatusUnreadable,
    ];
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_fixture_is_the_closed_list() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../src/contract/core/machine-install-checks.json"
        );
        let text = std::fs::read_to_string(path).expect("the machine install check list");
        let listed: Vec<String> = serde_json::from_str(&text).expect("a JSON array of strings");
        let mut sorted = listed.clone();
        sorted.sort();
        assert_eq!(listed, sorted, "the fixture is sorted");
        for code in &listed {
            assert!(code.len() <= 64, "{code} is longer than 64 bytes");
            assert!(
                code.starts_with(|c: char| c.is_ascii_lowercase()),
                "{code} does not start with a lowercase letter"
            );
            assert!(
                code.chars().all(|c| c.is_ascii_lowercase() || c == '-'),
                "{code} is not kebab-case"
            );
        }
        let ours: Vec<String> = Check::ALL
            .iter()
            .map(|check| {
                serde_json::to_value(check)
                    .expect("a check serializes")
                    .as_str()
                    .expect("a string")
                    .to_string()
            })
            .collect();
        assert_eq!(listed, ours, "the far list and the check enum differ");
    }
}
