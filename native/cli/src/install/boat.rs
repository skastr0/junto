//! A Boat machine's own key, written by that machine's Junto from its stdin, as
//! src/cli/hosts/machine-local.ts and src/node/boat/files.ts write it: the
//! delivery is checked closed, then two files under `<home>/.junto/boat` are
//! written whole, 0600, in a directory this user alone may read.

use std::fs;
use std::io::Write as _;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use rustix::process::getuid;

use super::Refused;

/// What the window's machine writes to this one's stdin.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BoatMachineKeyDelivery {
    pub sandbox_id: String,
    pub key_id: String,
    pub key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MachineSelf {
    version: u32,
    sandbox_id: String,
    key_id: String,
}

/// A sandbox id: `bx_` then 4 to 32 lowercase alphanumerics.
fn sandbox_id(value: &str) -> bool {
    let Some(rest) = value.strip_prefix("bx_") else {
        return false;
    };
    (4..=32).contains(&rest.len())
        && rest
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
}

/// A Boat key id: 8 to 64 lowercase hex or dashes.
fn key_id(value: &str) -> bool {
    (8..=64).contains(&value.len())
        && value
            .chars()
            .all(|c| c.is_ascii_digit() || c == '-' || (b'a'..=b'f').contains(&(c as u8)))
}

/// The machine key itself: `boat_` or the older `box_`, then at least 24.
fn key_secret(value: &str) -> bool {
    let Some(rest) = value
        .strip_prefix("boat_")
        .or_else(|| value.strip_prefix("box_"))
    else {
        return false;
    };
    (24..=256).contains(&rest.len())
        && rest
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

impl BoatMachineKeyDelivery {
    fn admitted(&self) -> bool {
        sandbox_id(&self.sandbox_id) && key_id(&self.key_id) && key_secret(&self.key)
    }
}

/// The Junto home as the app resolves it: `JUNTO_HOME` when it is usable, else
/// the account home.
pub fn resolve_junto_home() -> PathBuf {
    let Some(raw) = std::env::var_os("JUNTO_HOME") else {
        return super::paths::home();
    };
    let text = raw.to_string_lossy().to_string();
    let trimmed = text.trim();
    let usable = !trimmed.is_empty()
        && trimmed.chars().count() <= 4096
        && !trimmed.chars().any(|c| c.is_control())
        && Path::new(trimmed).is_absolute();
    if usable {
        super::paths::resolve_path(trimmed)
    } else {
        super::paths::home()
    }
}

/// The directory, made 0700 if missing; refused when it is a link or anyone
/// else's.
fn owned_dir(path: &Path) -> Result<PathBuf, Refused> {
    make_private_directories(path)?;
    let metadata = fs::symlink_metadata(path).map_err(Refused::from)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(Refused::new(format!(
            "Not a real directory: {}",
            path.display()
        )));
    }
    if metadata.uid() != getuid().as_raw() || metadata.mode() & 0o077 != 0 {
        return Err(Refused::new(format!(
            "Boat files must be this user's alone: {}",
            path.display()
        )));
    }
    Ok(path.to_path_buf())
}

/// Every missing directory on the way, made 0700 as its own step.
fn make_private_directories(path: &Path) -> Result<(), Refused> {
    let mut component = PathBuf::new();
    for part in path.components() {
        component.push(part.as_os_str());
        if component.as_os_str().is_empty() || component.exists() {
            continue;
        }
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&component)
            .map_err(Refused::from)?;
    }
    Ok(())
}

/// Written whole, then renamed over the old one: a reader never sees half.
fn write_owned(path: &Path, body: &str) -> Result<(), Refused> {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis())
        .unwrap_or_default();
    let temp = PathBuf::from(format!(
        "{}.{}.{}.tmp",
        path.display(),
        std::process::id(),
        stamp
    ));
    {
        let mut options = fs::OpenOptions::new();
        options
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(rustix::fs::OFlags::NOFOLLOW.bits() as i32);
        let mut handle = options.open(&temp).map_err(Refused::from)?;
        handle.write_all(body.as_bytes()).map_err(Refused::from)?;
        handle.sync_all().map_err(Refused::from)?;
    }
    match fs::rename(&temp, path) {
        Ok(()) => Ok(()),
        Err(error) => {
            let _ = fs::remove_file(&temp);
            Err(Refused::from(error))
        }
    }
}

fn boat_dir(home: &Path) -> PathBuf {
    home.join(".junto").join("boat")
}

/// The key into this Junto home, 0600, and the record naming its sandbox.
pub fn place_machine_key(
    junto_home: &Path,
    delivery: &BoatMachineKeyDelivery,
) -> Result<(), Refused> {
    let refused = || Refused::new("The machine key could not be written in this Junto home");
    if !delivery.admitted() {
        return Err(refused());
    }
    let directory = owned_dir(&boat_dir(junto_home)).map_err(|_| refused())?;
    let record = MachineSelf {
        version: 1,
        sandbox_id: delivery.sandbox_id.clone(),
        key_id: delivery.key_id.clone(),
    };
    let record = serde_json::to_string(&record).map_err(|_| refused())?;
    let key = format!("{}\n", delivery.key);
    write_owned(&directory.join("machine-key"), &key).map_err(|_| refused())?;
    write_owned(&directory.join("machine.json"), &format!("{record}\n")).map_err(|_| refused())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_delivery_shapes_are_checked_as_their_schemas() {
        let good = BoatMachineKeyDelivery {
            sandbox_id: "bx_abc123".to_string(),
            key_id: "0123456789abcdef".to_string(),
            key: format!("boat_{}", "a".repeat(24)),
        };
        assert!(good.admitted());
        let mut wrong = good.clone();
        wrong.sandbox_id = "box_abc".to_string();
        assert!(!wrong.admitted());
        let mut wrong = good.clone();
        wrong.key_id = "SHOUTING".to_string();
        assert!(!wrong.admitted());
        let mut wrong = good.clone();
        wrong.key = format!("boat_{}", "a".repeat(23));
        assert!(!wrong.admitted());
        assert!(serde_json::from_str::<BoatMachineKeyDelivery>(
            r#"{"sandboxId":"bx_abc123","keyId":"0123456789abcdef","key":"boat_aaaaaaaaaaaaaaaaaaaaaaaa","extra":1}"#
        )
        .is_err());
    }

    #[test]
    fn the_key_and_its_record_are_written_private() {
        let home = super::super::paths::home().join(format!(".junto-boat-{}", std::process::id()));
        let _ = fs::remove_dir_all(&home);
        let delivery = BoatMachineKeyDelivery {
            sandbox_id: "bx_abc123".to_string(),
            key_id: "0123456789abcdef".to_string(),
            key: format!("boat_{}", "a".repeat(24)),
        };
        place_machine_key(&home, &delivery).expect("placed");
        let directory = boat_dir(&home);
        let key = fs::read_to_string(directory.join("machine-key")).expect("the key");
        assert_eq!(key, format!("boat_{}\n", "a".repeat(24)));
        assert_eq!(
            fs::metadata(directory.join("machine-key"))
                .expect("mode")
                .mode()
                & 0o777,
            0o600
        );
        let record = fs::read_to_string(directory.join("machine.json")).expect("the record");
        assert!(record.contains("\"sandboxId\":\"bx_abc123\""));
        assert_eq!(
            fs::metadata(directory.join("machine.json"))
                .expect("mode")
                .mode()
                & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(&directory).expect("mode").mode() & 0o777,
            0o700
        );
        let _ = fs::remove_dir_all(&home);
    }
}

