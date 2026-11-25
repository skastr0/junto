//! `junto-desktop-bootstrap-linux-x64`: help, version, and one authenticated
//! first install. Every failure is one JSON object on stderr and exit 1.

use std::path::PathBuf;
use std::process::ExitCode;

use serde::Serialize;

use junto_desktop_bootstrap::error::{ActivationError, Error, Result, error};
use junto_desktop_bootstrap::install::{
    activate_first_install, first_install_available, revalidate, stage,
};
use junto_desktop_bootstrap::trust::Trust;
use junto_desktop_bootstrap::verify::verify_release_files;

const COMMAND: &str = "linux-desktop-bootstrap";
const BOOTSTRAP_VERSION: &str = "1.0.0";
const HELP: &str = "Junto Linux desktop bootstrap 1.0.0

Authenticate signed first-install inputs with this independently obtained
program. Do not extract or execute the candidate archive.

Usage:
  junto-desktop-bootstrap-linux-x64 --release FILE --archive FILE

Options:
  --release FILE   Downloaded signed release.json
  --archive FILE   Downloaded Linux x64 runtime archive
  --version        Print embedded bootstrap and release-trust identity
  --help           Show this help
";

const RECOVERY_FRESH: &str = "Obtain the independently authenticated bootstrap or a reviewed source checkout. Check the signed release inputs and supported host. An existing managed installation must update through the app.";
const RECOVERY_ACTIVATED: &str = "The Linux desktop launcher was already published before this failure; first install is complete on disk. Do not re-run the bootstrap or replace the launcher. Open ~/.local/bin/junto-desktop when ready; future updates come from the app.";

enum Args {
    Help,
    Version,
    Install { release: PathBuf, archive: PathBuf },
}

fn parse(args: &[String]) -> Result<Args> {
    if args.len() == 1 && args[0] == "--help" {
        return Ok(Args::Help);
    }
    if args.len() == 1 && args[0] == "--version" {
        return Ok(Args::Version);
    }
    let mut values: Vec<(&str, PathBuf)> = Vec::new();
    let mut index = 0;
    while index < args.len() {
        let current = args[index].as_str();
        if current != "--release" && current != "--archive" {
            return error(format!("unknown bootstrap option: {current}"));
        }
        let Some(value) = args.get(index + 1) else {
            return error(format!("missing or duplicate bootstrap option: {current}"));
        };
        if value.starts_with("--") || values.iter().any(|(flag, _)| *flag == current) {
            return error(format!("missing or duplicate bootstrap option: {current}"));
        }
        values.push((current, PathBuf::from(value)));
        index += 2;
    }
    let release = values
        .iter()
        .find(|(flag, _)| *flag == "--release")
        .map(|(_, path)| path.clone());
    let archive = values
        .iter()
        .find(|(flag, _)| *flag == "--archive")
        .map(|(_, path)| path.clone());
    match (release, archive) {
        (Some(release), Some(archive)) => Ok(Args::Install { release, archive }),
        _ => error("usage: --release FILE --archive FILE"),
    }
}

#[derive(Serialize)]
struct IdentityData {
    bootstrap_version: &'static str,
    keyring_revision: u64,
    trusted_keyring_sha256: String,
    trusted_key_id: String,
    trusted_key_fingerprint_sha256: String,
}

impl IdentityData {
    fn load() -> Result<IdentityData> {
        let identity = Trust::embedded()?.identity();
        Ok(IdentityData {
            bootstrap_version: BOOTSTRAP_VERSION,
            keyring_revision: identity.keyring_revision,
            trusted_keyring_sha256: identity.keyring_sha256,
            trusted_key_id: identity.key_id,
            trusted_key_fingerprint_sha256: identity.key_fingerprint_sha256,
        })
    }
}

#[derive(Serialize)]
struct VersionEnvelope {
    ok: bool,
    command: &'static str,
    data: IdentityData,
}

#[derive(Serialize)]
struct InstallData {
    #[serde(flatten)]
    identity: IdentityData,
    version: String,
    archive_sha256: String,
    executable_path: String,
    launched: bool,
    next_step: String,
}

#[derive(Serialize)]
struct InstallEnvelope {
    ok: bool,
    command: &'static str,
    data: InstallData,
}

#[derive(Serialize)]
struct FailureDetails {
    next_step: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    activated: Option<bool>,
}

#[derive(Serialize)]
struct FailureBody {
    r#type: &'static str,
    message: String,
    details: FailureDetails,
}

#[derive(Serialize)]
struct FailureEnvelope {
    ok: bool,
    command: &'static str,
    error: FailureBody,
}

fn target_refusal() -> Option<&'static str> {
    if std::env::consts::OS != "linux" || std::env::consts::ARCH != "x86_64" {
        return Some("Linux desktop updates require Ubuntu 24.04 x64 with glibc 2.39 or newer");
    }
    let release = std::fs::read_to_string("/etc/os-release").ok()?;
    let mut id = None;
    let mut version = None;
    for line in release.lines() {
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let value = value.trim_matches('"');
        match key {
            "ID" => id = Some(value.to_owned()),
            "VERSION_ID" => version = Some(value.to_owned()),
            _ => {}
        }
    }
    let glibc = glibc_version()?;
    let mut parts = glibc.split('.');
    let major = parts.next().and_then(|part| part.parse::<u64>().ok());
    let minor = parts.next().and_then(|part| part.parse::<u64>().ok());
    let supported = id.as_deref() == Some("ubuntu")
        && version.as_deref() == Some("24.04")
        && major.is_some_and(|major| major >= 2)
        && minor.is_some_and(|minor| minor >= 39);
    if !supported {
        return Some("Linux desktop updates require Ubuntu 24.04 x64 with glibc 2.39 or newer");
    }
    if rustix::process::getuid().as_raw() == 0 || rustix::process::geteuid().as_raw() == 0 {
        return Some(
            "Linux desktop installation and updates require an ordinary user with non-root real and effective user IDs",
        );
    }
    None
}

#[cfg(target_env = "gnu")]
fn glibc_version() -> Option<String> {
    // The loaded C library's own version, never a filename or a shell.
    let pointer = unsafe { libc::gnu_get_libc_version() };
    if pointer.is_null() {
        return None;
    }
    unsafe { std::ffi::CStr::from_ptr(pointer) }
        .to_str()
        .ok()
        .map(str::to_owned)
}

#[cfg(not(target_env = "gnu"))]
fn glibc_version() -> Option<String> {
    None
}

fn install(release: PathBuf, archive: PathBuf) -> Result<Display> {
    if let Some(refusal) = target_refusal() {
        return error(refusal);
    }
    let home = first_install_available(None)?;
    let trust = Trust::embedded()?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0);
    let verified = verify_release_files(&release, &archive, &trust, now)?;
    let staged = stage(&verified, &archive, Some(&home))?;
    revalidate(&staged)?;
    match activate_first_install(&staged) {
        Ok(executable) => Ok(Display::Installed(InstallData {
            identity: IdentityData::load()?,
            version: staged.version.clone(),
            archive_sha256: staged.archive_sha256.clone(),
            executable_path: executable.to_string_lossy().into_owned(),
            launched: false,
            next_step: "Close any running Junto app, then open ~/.local/bin/junto-desktop. Future updates are installed from the app.".to_owned(),
        })),
        Err(ActivationError { message, activated }) => Err(Error::new(message).attach_activation(activated)),
    }
}

enum Display {
    Help,
    Version(IdentityData),
    Installed(InstallData),
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let outcome = parse(&args).and_then(|parsed| match parsed {
        Args::Help => Ok(Display::Help),
        Args::Version => IdentityData::load().map(Display::Version),
        Args::Install { release, archive } => install(release, archive),
    });
    match outcome {
        Ok(Display::Help) => {
            print!("{HELP}");
            ExitCode::SUCCESS
        }
        Ok(Display::Version(data)) => {
            match serde_json::to_string(&VersionEnvelope {
                ok: true,
                command: COMMAND,
                data,
            }) {
                Ok(text) => {
                    println!("{text}");
                    ExitCode::SUCCESS
                }
                Err(cause) => {
                    failure(Error::new(cause.to_string()));
                    ExitCode::FAILURE
                }
            }
        }
        Ok(Display::Installed(data)) => {
            match serde_json::to_string(&InstallEnvelope {
                ok: true,
                command: COMMAND,
                data,
            }) {
                Ok(text) => {
                    println!("{text}");
                    ExitCode::SUCCESS
                }
                Err(cause) => {
                    failure(Error::new(cause.to_string()));
                    ExitCode::FAILURE
                }
            }
        }
        Err(cause) => {
            failure(cause);
            ExitCode::FAILURE
        }
    }
}

fn failure(cause: Error) {
    let activated = cause.activated();
    let envelope = FailureEnvelope {
        ok: false,
        command: COMMAND,
        error: FailureBody {
            r#type: "LinuxDesktopInstallError",
            message: cause.message().to_owned(),
            details: FailureDetails {
                next_step: if activated == Some(true) {
                    RECOVERY_ACTIVATED
                } else {
                    RECOVERY_FRESH
                },
                activated,
            },
        },
    };
    match serde_json::to_string(&envelope) {
        Ok(text) => eprintln!("{text}"),
        Err(_) => eprintln!(
            "{{\"ok\":false,\"command\":\"{COMMAND}\",\"error\":{{\"type\":\"LinuxDesktopInstallError\",\"message\":\"serialization failed\"}}}}"
        ),
    }
}
