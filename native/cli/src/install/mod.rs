//! What runs on a machine's own files: install, uninstall and a Boat machine's
//! key, ported from src/cli/hosts (install, uninstall, machine-local) so the
//! bundle needs no Node entry for them. The work is local to the machine: an
//! install bundle is verified and copied, a service written and proven
//! quiescent, and the running set asked on the incumbent's own socket.
//!
//! Nothing here trusts an argument with a path it did not admit, and every
//! message that carries another process's words scrubs them first.

mod boat;
mod bundle;
mod hold;
mod homelock;
mod lock;
mod paths;
mod prune;
mod quiesce;
mod restore;
mod run;
mod service;
mod status;

use std::fs;
use std::io::{Read, Write};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::envelope::{self, Answer};
use crate::error::{ErrorType, Failure};
use crate::input;

use self::bundle::{BundleFile, Manifest, inspect_bundle};
use self::paths::{ensure_machine_directory, machine_home_path, owned_machine_file};
use self::service::Provider;
use self::status::OwnStatus;

/// An install or uninstall refusal: its words, and what it proved about the
/// running seats.
#[derive(Debug, Clone)]
pub struct Refused {
    pub message: String,
    pub running_seats: Option<u32>,
    pub running_seats_unknown: bool,
}

impl Refused {
    pub fn new(message: impl Into<String>) -> Self {
        Refused {
            message: message.into(),
            running_seats: None,
            running_seats_unknown: false,
        }
    }

    pub fn with_running_seats(message: impl Into<String>, seats: u32) -> Self {
        Refused {
            running_seats: Some(seats),
            ..Refused::new(message)
        }
    }

    pub fn with_running_seats_unknown(message: impl Into<String>) -> Self {
        Refused {
            running_seats_unknown: true,
            ..Refused::new(message)
        }
    }
}

impl From<std::io::Error> for Refused {
    fn from(error: std::io::Error) -> Self {
        Refused::new(error.to_string())
    }
}

impl From<run::RunFailed> for Refused {
    fn from(failure: run::RunFailed) -> Self {
        Refused::new(failure.message)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Disposition {
    Staged,
    Activated,
    Uncertain,
    RolledBack,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Transition {
    pub step: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub build: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub service: Option<&'static str>,
}

impl Transition {
    fn step(step: &str, build: Option<String>) -> Self {
        Transition {
            step: step.to_string(),
            build,
            pid: None,
            start_key: None,
            service: None,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallResult {
    build: String,
    junto_home: String,
    install_root: String,
    directory: String,
    service_label: String,
    provider: &'static str,
    updated: bool,
    disposition: &'static str,
    installation_id: String,
    machine_name: String,
    pid: i64,
    transitions: Vec<Transition>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    notices: Vec<&'static str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UninstallResult {
    junto_home: String,
    install_root: String,
    service_label: String,
    disposition: &'static str,
    definition_removed: bool,
    transitions: Vec<Transition>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstallInput {
    bundle: String,
    #[serde(default)]
    junto_home: Option<String>,
    #[serde(default)]
    install_root: Option<String>,
    #[serde(default)]
    expected_installation_id: Option<String>,
    #[serde(default)]
    stop_running_seats: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalPaths {
    #[serde(default)]
    junto_home: Option<String>,
    #[serde(default)]
    install_root: Option<String>,
}

/// A path a machine command admits: absolute, bounded, no control character.
fn absolute_path(value: &str) -> Result<PathBuf, Refused> {
    let control = value.chars().any(|c| c.is_control());
    if value.is_empty() || value.chars().count() > 2048 || !value.starts_with('/') || control {
        return Err(Refused::new(format!(
            "machine paths are absolute, at most 2048 characters, and hold no control character: {value}"
        )));
    }
    Ok(PathBuf::from(value))
}

fn provider_text(provider: Provider) -> &'static str {
    match provider {
        Provider::Launchd => "launchd",
        Provider::SystemdUser => "systemd-user",
    }
}

/// What a finished install answers, named once so the two ready paths (an
/// idempotent resend and a fresh selection) build it the same way.
struct Ready<'a> {
    manifest: &'a Manifest,
    junto_home: &'a Path,
    install_root: &'a Path,
    directory: &'a Path,
    label: &'a str,
    provider: Provider,
    updated: bool,
    status: OwnStatus,
    transitions: Vec<Transition>,
    notices: Vec<&'static str>,
}

impl InstallResult {
    fn ready(ready: Ready<'_>) -> Self {
        InstallResult {
            build: ready.manifest.build.clone(),
            junto_home: ready.junto_home.to_string_lossy().into_owned(),
            install_root: ready.install_root.to_string_lossy().into_owned(),
            directory: ready.directory.to_string_lossy().into_owned(),
            service_label: ready.label.to_string(),
            provider: provider_text(ready.provider),
            updated: ready.updated,
            disposition: "ready",
            installation_id: ready.status.installation_id.clone(),
            machine_name: ready.status.machine_name.clone(),
            pid: ready.status.pid,
            transitions: ready.transitions,
            notices: ready.notices,
        }
    }
}

/// One install's own state: what it proved, and where it reached.
struct Flow {
    junto_home: PathBuf,
    install_root: PathBuf,
    transitions: Vec<Transition>,
    disposition: Disposition,
}

impl Flow {
    fn record(&mut self, transition: Transition) {
        let mut event = json!({
            "event": "machine-install",
            "juntoHome": self.junto_home.to_string_lossy(),
            "installRoot": self.install_root.to_string_lossy(),
        });
        if let (Some(target), Ok(serde_json::Value::Object(fields))) =
            (event.as_object_mut(), serde_json::to_value(&transition))
        {
            for (key, value) in fields {
                target.insert(key, value);
            }
        }
        envelope::warn(&event.to_string());
        self.transitions.push(transition);
    }
}

/// The install's own copy: the bundle's files, each with its own mode, under
/// directories this user alone may enter.
fn copy_bundle(source: &Path, destination: &Path, files: &[BundleFile]) -> Result<(), Refused> {
    let mut pending: Vec<PathBuf> = vec![PathBuf::new()];
    while let Some(relative) = pending.pop() {
        let directory = source.join(&relative);
        let mut entries: Vec<PathBuf> = fs::read_dir(&directory)
            .map_err(Refused::from)?
            .map(|entry| entry.map(|entry| entry.path()).map_err(Refused::from))
            .collect::<Result<_, _>>()?;
        entries.sort();
        for absolute in entries {
            let child = absolute
                .strip_prefix(source)
                .map(Path::to_path_buf)
                .unwrap_or_else(|_| absolute.clone());
            let target = destination.join(&child);
            let metadata = fs::symlink_metadata(&absolute).map_err(Refused::from)?;
            if target.exists() {
                return Err(Refused::new("install copy destination already exists"));
            }
            if metadata.is_dir() && !metadata.file_type().is_symlink() {
                fs::DirBuilder::new()
                    .mode(0o700)
                    .create(&target)
                    .map_err(Refused::from)?;
                pending.push(child);
            } else {
                let body = fs::read(&absolute).map_err(Refused::from)?;
                let mut options = fs::OpenOptions::new();
                options
                    .write(true)
                    .create_new(true)
                    .mode(0o600)
                    .custom_flags(rustix::fs::OFlags::NOFOLLOW.bits() as i32);
                let mut handle = options.open(&target).map_err(Refused::from)?;
                handle.write_all(&body).map_err(Refused::from)?;
                drop(handle);
                let text = child
                    .to_string_lossy()
                    .replace(std::path::MAIN_SEPARATOR, "/");
                let mode = files
                    .iter()
                    .find(|file| file.path == text)
                    .map(|file| file.mode)
                    .unwrap_or(metadata.mode() & 0o777);
                fs::set_permissions(&target, fs::Permissions::from_mode(mode & 0o777))
                    .map_err(Refused::from)?;
            }
        }
    }
    Ok(())
}

/// The installed copy is exactly the bundle this machine sent: every file its
/// own, and every manifest field the same.
fn verify_generation(path: &Path, admitted: &Manifest) -> Result<(), Refused> {
    paths::check_machine_tree(path)?;
    let installed = inspect_bundle(path)?;
    if &installed != admitted {
        return Err(Refused::new(
            "installed bundle differs from the bundle this machine sent",
        ));
    }
    Ok(())
}

/// The last words the service wrote, scrubbed, for a failure a person reads.
fn service_error_tail(install_root: &Path) -> String {
    let path = install_root.join("logs/stderr.log");
    let Ok(true) = owned_machine_file(&path) else {
        return String::new();
    };
    let Ok(metadata) = fs::metadata(&path) else {
        return String::new();
    };
    let size = metadata.len();
    let count = size.min(4096) as usize;
    let mut bytes = vec![0u8; count];
    let Ok(mut handle) = fs::File::open(&path) else {
        return String::new();
    };
    if size > count as u64 {
        use std::io::Seek;
        if handle
            .seek(std::io::SeekFrom::Start(size - count as u64))
            .is_err()
        {
            return String::new();
        }
    }
    if handle.read_exact(&mut bytes).is_err() {
        return String::new();
    }
    let text = crate::scrub::scrub_text(&String::from_utf8_lossy(&bytes));
    let trimmed = text.trim();
    let lines: Vec<&str> = trimmed.lines().collect();
    let tail = lines[lines.len().saturating_sub(12)..].join("\n");
    let characters: Vec<char> = tail.chars().collect();
    if characters.len() > 3000 {
        characters[characters.len() - 3000..].iter().collect()
    } else {
        tail
    }
}

fn scrub(message: &str) -> String {
    crate::scrub::scrub_message(message)
}

/// `machine install-local`: verify, copy, quiesce, select, start, prove ready.
fn install_flow(
    input: InstallInput,
) -> Result<InstallResult, (Refused, Disposition, Vec<Transition>)> {
    let bundle_path = match absolute_path(&input.bundle) {
        Ok(path) => path,
        Err(refused) => return Err((refused, Disposition::Staged, Vec::new())),
    };
    let junto_home_value = match input.junto_home.as_deref().map(absolute_path).transpose() {
        Ok(value) => value,
        Err(refused) => return Err((refused, Disposition::Staged, Vec::new())),
    };
    let install_root_value = match input.install_root.as_deref().map(absolute_path).transpose() {
        Ok(value) => value,
        Err(refused) => return Err((refused, Disposition::Staged, Vec::new())),
    };
    let junto_home = match machine_home_path(junto_home_value.unwrap_or_else(paths::home), true) {
        Ok(path) => path,
        Err(refused) => return Err((refused, Disposition::Staged, Vec::new())),
    };
    let install_root = match machine_home_path(
        install_root_value.unwrap_or_else(|| paths::home().join(".junto/machine")),
        false,
    ) {
        Ok(path) => path,
        Err(refused) => return Err((refused, Disposition::Staged, Vec::new())),
    };
    let mut flow = Flow {
        junto_home: junto_home.clone(),
        install_root: install_root.clone(),
        transitions: Vec::new(),
        disposition: Disposition::Staged,
    };
    let run = |flow: &mut Flow| -> Result<InstallResult, Refused> {
        let label = service::service_label(&install_root, &junto_home);
        service::admit_label(&label)?;
        ensure_machine_directory(&install_root, false)?;
        let expected = lock::owner_marker(&label, &junto_home);
        let marker = install_root.join("owner.json");
        if owned_machine_file(&marker)? {
            let held = fs::read_to_string(&marker)?;
            if held != expected {
                return Err(Refused::new(
                    "install directory belongs to another machine home",
                ));
            }
        } else {
            if !lock::only_lock_here(&install_root)? {
                return Err(Refused::new(
                    "install directory contains files not owned by this installation",
                ));
            }
            lock::write_owner_marker(&install_root, &expected)?;
        }
        lock::admit_install_lock_root(&install_root, &expected)?;
        // The lock comes before anything that touches the state directory: a
        // second installer must be refused while the first still owns a restore.
        let _lease = lock::acquire_install_lock(&install_root)?;
        // A restore a crash interrupted finishes before this install reads anything.
        restore::finish_interrupted_restore(&restore::machine_state_directory(&junto_home))?;
        let manifest = inspect_bundle(&bundle_path)?;
        if manifest.target != bundle::this_target() {
            return Err(Refused::new(format!(
                "bundle {} does not match this machine",
                manifest.target
            )));
        }
        ensure_machine_directory(&junto_home, true)?;
        ensure_machine_directory(&install_root.join("logs"), false)?;
        for name in ["stdout.log", "stderr.log"] {
            owned_machine_file(&install_root.join("logs").join(name))?;
        }
        ensure_machine_directory(&install_root.join("builds"), false)?;
        let current = install_root.join("current");
        let pointer = paths::optional_metadata(&current)?;
        let mut previous: Option<String> = None;
        if let Some(pointer) = pointer {
            if !pointer.file_type().is_symlink()
                || pointer.uid() != rustix::process::getuid().as_raw()
            {
                return Err(Refused::new(
                    "current must be an owned build selection link",
                ));
            }
            let target = fs::read_link(&current)?;
            let text = target.to_string_lossy().into_owned();
            if !generation_path(&text) {
                return Err(Refused::new("current selects an invalid build directory"));
            }
            paths::check_machine_tree(&install_root.join(&text))?;
            previous = Some(text);
        }
        let generation = format!("builds/{}-{}", manifest.build, manifest.target);
        let directory = install_root.join(&generation);
        if paths::optional_metadata(&directory)?.is_none() {
            let stage = install_root.join(format!("incoming-{}", restore_uuid()?));
            let staged = (|| -> Result<(), Refused> {
                fs::DirBuilder::new()
                    .mode(0o700)
                    .create(&stage)
                    .map_err(Refused::from)?;
                fs::set_permissions(&stage, fs::Permissions::from_mode(0o700))?;
                copy_bundle(&bundle_path, &stage, &manifest.files)?;
                verify_generation(&stage, &manifest)?;
                fs::rename(&stage, &directory)?;
                Ok(())
            })();
            let _ = fs::remove_dir_all(&stage);
            staged?;
        }
        verify_generation(&directory, &manifest)?;
        flow.record(Transition::step("verified", Some(manifest.build.clone())));
        let mut service = service::machine_service(&install_root, &junto_home, &label)?;
        let mut notices = service.reconcile()?;
        notices.sort_unstable();
        notices.dedup();
        let before = service.observe()?;
        let mut installation_id = input.expected_installation_id.clone();
        if before.pid > 0 {
            let Some(previous) = previous.clone() else {
                return Err(Refused::new(
                    "running service has no admitted build selection",
                ));
            };
            let incumbent =
                status::read_installed_status(&install_root.join(&previous), &junto_home)?;
            if incumbent.pid != before.pid as i64
                || incumbent.junto_home != junto_home.to_string_lossy()
            {
                return Err(Refused::new("running core does not match this install"));
            }
            if installation_id
                .as_deref()
                .is_some_and(|expected| incumbent.installation_id != expected)
            {
                return Err(Refused::new("running core installation identity changed"));
            }
            installation_id = Some(incumbent.installation_id.clone());
            if previous == generation
                && incumbent.build == manifest.build
                && incumbent.ready
                && before.matches_desired_placement
            {
                flow.record(Transition {
                    pid: Some(incumbent.pid),
                    ..Transition::step("ready", None)
                });
                return Ok(InstallResult::ready(Ready {
                    manifest: &manifest,
                    junto_home: &junto_home,
                    install_root: &install_root,
                    directory: &directory,
                    label: &label,
                    provider: service.provider(),
                    updated: false,
                    status: incumbent,
                    transitions: flow.transitions.clone(),
                    notices: notices.clone(),
                }));
            }
        }
        // The live set is the incumbent core's to observe on its own term
        // control socket. The lease closes create admission; hold it through the
        // quiesce so a seat cannot start between the count and the stop.
        let mut lease = if before.pid > 0 {
            Some(hold::hold_incumbent_for_update(
                &junto_home,
                input.stop_running_seats == Some(true),
            ))
        } else {
            None
        };
        match lease.as_ref() {
            Some(hold::Hold::Refused { running_seats }) => {
                return Err(hold::running_seats_refusal(*running_seats));
            }
            Some(hold::Hold::Unknown) => return Err(hold::running_seats_unknown()),
            Some(hold::Hold::Lease(_)) => {}
            None => {}
        }
        let quiesced = {
            let outcome = quiesce::quiesce_machine_service(&mut *service, &before, || {
                flow.disposition = Disposition::Uncertain;
            });
            // The lease is released once the stop is proven, as the TypeScript does.
            lease.take();
            outcome?
        };
        // Quiescent, so the family cannot change under the copy. The home lock
        // proves no other core is on it: the candidate takes the same lock at
        // its own boot, so it is released before the candidate starts.
        let state_directory = restore::machine_state_directory(&junto_home);
        let home_lock = lock_for_copy(&state_directory, &mut *service)?;
        let point = match restore::make_restore_point(&state_directory) {
            Ok(point) => point,
            Err(error) => {
                drop(home_lock);
                let _ = service.start();
                return Err(Refused::new(
                    "Junto could not keep a copy of this machine's database, so nothing was changed",
                )
                .with_cause(&error));
            }
        };
        flow.record(Transition {
            build: previous
                .as_deref()
                .map(|previous| previous.trim_start_matches("builds/"))
                .map(|previous| previous.chars().take(64).collect()),
            pid: quiesced.pid.map(i64::from),
            start_key: quiesced.start_key.clone(),
            service: Some(quiesced.service),
            ..Transition::step("quiescent", None)
        });
        let updated = previous.as_deref() != Some(generation.as_str());
        if updated {
            let next = install_root.join(format!("current-{}", restore_uuid()?));
            let linked = std::os::unix::fs::symlink(&generation, &next)
                .map_err(Refused::from)
                .and_then(|()| fs::rename(&next, &current).map_err(Refused::from));
            let _ = fs::remove_file(&next);
            linked?;
        }
        // The candidate takes the home lock at its own boot.
        drop(home_lock);
        // The candidate can open state from here; errors never roll back or retry.
        flow.disposition = Disposition::Activated;
        flow.record(Transition::step("selected", Some(manifest.build.clone())));
        let started = (|| -> Result<OwnStatus, Refused> {
            service.start()?;
            flow.record(Transition::step("started", None));
            let deadline = Instant::now() + Duration::from_secs(30);
            let mut detail = "core has not reported ready".to_string();
            while Instant::now() < deadline {
                match status::read_installed_status(&directory, &junto_home) {
                    Ok(observed) => {
                        let _ = service.reconcile();
                        let seen = service.observe()?;
                        if observed.build != manifest.build
                            || observed.junto_home != junto_home.to_string_lossy()
                            || observed.pid != seen.pid as i64
                        {
                            return Err(Refused::new(
                                "core build, home, or service process does not match the candidate",
                            ));
                        }
                        if installation_id
                            .as_deref()
                            .is_some_and(|expected| observed.installation_id != expected)
                        {
                            return Err(Refused::new("candidate installation identity changed"));
                        }
                        if observed.ready {
                            return Ok(observed);
                        }
                    }
                    Err(error) => detail = scrub(&error.message),
                }
                std::thread::sleep(Duration::from_millis(200));
            }
            Err(Refused::new(detail))
        })();
        match started {
            Ok(observed) => {
                if let Some(point) = point.as_ref() {
                    let _ = restore::discard_restore_point(point);
                }
                // The generation names, not their selection paths: prune compares
                // the directory names it reads.
                let keep = vec![
                    format!("{}-{}", manifest.build, manifest.target),
                    previous
                        .as_deref()
                        .map(|previous| previous.trim_start_matches("builds/").to_string())
                        .unwrap_or_default(),
                ];
                let _ = prune::prune_machine_builds(&install_root, &keep);
                flow.record(Transition {
                    pid: Some(observed.pid),
                    ..Transition::step("ready", None)
                });
                Ok(InstallResult::ready(Ready {
                    manifest: &manifest,
                    junto_home: &junto_home,
                    install_root: &install_root,
                    directory: &directory,
                    label: &label,
                    provider: service.provider(),
                    updated,
                    status: observed,
                    transitions: flow.transitions.clone(),
                    notices: notices.clone(),
                }))
            }
            Err(error) => {
                flow.disposition = Disposition::Uncertain;
                let diagnostics = service_error_tail(&install_root);
                let stopped = stop_machine_service(&mut *service);
                if let Err(stop) = stopped {
                    let kept = point
                        .as_ref()
                        .map(|point| {
                            format!(
                                " The kept database copy is at {}.",
                                point.directory.display()
                            )
                        })
                        .unwrap_or_default();
                    let said: String = scrub(&stop.message).chars().take(800).collect();
                    return Err(Refused::new(format!(
                        "Junto did not start, and stopping it could not be confirmed. Check this machine before sending again.{kept} {said}{}",
                        if diagnostics.is_empty() {
                            String::new()
                        } else {
                            format!("\n{diagnostics}")
                        }
                    )));
                }
                if let Some(point) = point.as_ref() {
                    let restored = (|| -> Result<(), Refused> {
                        if let (Some(previous), true) = (previous.as_deref(), updated) {
                            let next = install_root.join(format!("current-{}", restore_uuid()?));
                            let linked = std::os::unix::fs::symlink(previous, &next)
                                .map_err(Refused::from)
                                .and_then(|()| fs::rename(&next, &current).map_err(Refused::from));
                            let _ = fs::remove_file(&next);
                            linked?;
                        }
                        restore_under_home_lock(point, &state_directory, &mut *service)
                    })();
                    if let Err(restore_error) = restored {
                        let said: String =
                            scrub(&restore_error.message).chars().take(800).collect();
                        return Err(Refused::new(format!(
                            "Junto did not start on the new build, and its database restore could not finish. The kept copy is at {}; the next boot finishes the restore before opening Junto. {said}",
                            point.directory.display()
                        )));
                    }
                    if previous.is_some() && before.pid > 0 {
                        let _ = service.start();
                    }
                    flow.disposition = Disposition::RolledBack;
                    let said = if diagnostics.is_empty() {
                        scrub(&error.message).chars().take(1000).collect()
                    } else {
                        diagnostics.clone()
                    };
                    return Err(Refused::new(format!(
                        "Junto did not start on the new build. The previous build and its database are back.\n{said}"
                    )));
                }
                let _ = service.remove_definition();
                flow.disposition = Disposition::Activated;
                let said = if diagnostics.is_empty() {
                    scrub(&error.message).chars().take(1000).collect()
                } else {
                    diagnostics.clone()
                };
                Err(Refused::new(format!(
                    "Junto is installed but did not start. Nothing is running there. Send a fixed build to recover.\n{said}"
                )))
            }
        }
    };
    match run(&mut flow) {
        Ok(result) => Ok(result),
        Err(refused) => Err((refused, flow.disposition, flow.transitions)),
    }
}

impl Refused {
    fn with_cause(self, cause: &Refused) -> Refused {
        Refused {
            message: format!("{}: {}", self.message, scrub(&cause.message)),
            ..self
        }
    }
}

/// `builds/<64 hex>-<target>`, as the selection link must name it.
fn generation_path(text: &str) -> bool {
    let Some(rest) = text.strip_prefix("builds/") else {
        return false;
    };
    build_generation(rest)
}

/// `<64 hex>-<target>`, as a generation directory is named.
fn build_generation(name: &str) -> bool {
    let hash = ["-darwin-arm64", "-linux-x64"]
        .iter()
        .find_map(|suffix| name.strip_suffix(suffix))
        .filter(|hash| {
            hash.len() == 64
                && hash
                    .chars()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&(c as u8)))
        });
    hash.is_some()
}

/// What `machine restore-finish` answers: whether a restore was owed.
#[derive(Serialize)]
pub struct FinishRestore {
    pub finished: bool,
}

/// Why a boot could not finish a restore: an install holds the home, or the
/// restore itself refused.
#[derive(Debug)]
pub enum RestoreFinish {
    Updating(Failure),
    Fault(Refused),
}

/// `machine restore-finish`: the core's boot step, after it holds the home lock
/// and before it reads the database. The env names the home and the install
/// root; no argument and no input, and the caller reads the exit code alone.
pub fn restore_finish() -> Result<FinishRestore, RestoreFinish> {
    let junto_home = std::env::var_os("JUNTO_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| paths::home().join(".junto"));
    let junto_home = junto_home_for_restore(&junto_home).map_err(RestoreFinish::Fault)?;
    let install_root = std::env::var_os("JUNTO_INSTALL_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| junto_home.join(".junto/machine"));
    restore_finish_at(&junto_home, Some(&install_root))
}

fn junto_home_for_restore(value: &Path) -> Result<PathBuf, Refused> {
    let home = machine_home_path(value, true)?;
    Ok(home)
}

/// The boot step against named paths: finish an interrupted restore under the
/// install lock when a marker is there, and answer updating when an install
/// holds it. No home lock is taken here: the core holds it already.
pub fn restore_finish_at(
    junto_home: &Path,
    install_root: Option<&Path>,
) -> Result<FinishRestore, RestoreFinish> {
    let state_directory = restore::machine_state_directory(junto_home);
    let pending = restore::restore_pending(&state_directory).map_err(RestoreFinish::Fault)?;
    if !pending {
        return Ok(FinishRestore { finished: false });
    }
    let mut _lease = None;
    if let Some(install_root) = install_root {
        let marker = install_root.join("owner.json");
        let owned = owned_machine_file(&marker).map_err(RestoreFinish::Fault)?;
        if owned {
            let expected = lock::owner_marker(
                &service::service_label(install_root, junto_home),
                junto_home,
            );
            let held = fs::read_to_string(&marker).map_err(|error| {
                RestoreFinish::Fault(Refused::new(format!(
                    "the install marker could not be read: {error}"
                )))
            })?;
            // A root that serves another home is not this boot's serialization.
            if held == expected {
                match lock::try_install_lock(install_root).map_err(RestoreFinish::Fault)? {
                    Some(lease) => _lease = Some(lease),
                    None => {
                        return Err(RestoreFinish::Updating(Failure::new(
                            ErrorType::RuntimeDown,
                            "an install is sending Junto to this machine, so this boot cannot finish a database restore",
                        )));
                    }
                }
            }
        }
    }
    restore::finish_interrupted_restore(&state_directory).map_err(RestoreFinish::Fault)?;
    Ok(FinishRestore { finished: true })
}

fn restore_uuid() -> Result<String, Refused> {
    // The one uuid source the install already has: the restore module's.
    restore::new_uuid()
}

/// The home lock before the family is copied. A lock a core holds means the
/// database can still change, so nothing is copied and the service this run
/// stopped is started again.
fn lock_for_copy(
    state_directory: &Path,
    service: &mut dyn service::Service,
) -> Result<homelock::HomeDatabaseLock, Refused> {
    match homelock::try_lock_home_database(state_directory) {
        Ok(Some(lock)) => Ok(lock),
        Ok(None) => {
            let _ = service.start();
            Err(Refused::new(homelock::HELD_WORDS))
        }
        Err(error) => {
            let _ = service.start();
            Err(Refused::new(
                "this machine's database is not private to this user, so nothing was changed",
            )
            .with_cause(&error))
        }
    }
}

/// The restore after a candidate did not start: the marker first, under the
/// install lock this run holds, then the home lock, one more stop and one more
/// try, and the double-failure words that leave the marker for the next boot.
fn restore_under_home_lock(
    point: &restore::RestorePoint,
    state_directory: &Path,
    service: &mut dyn service::Service,
) -> Result<(), Refused> {
    restore::write_restore_marker(point)?;
    let mut lock = homelock::try_lock_home_database(state_directory)?;
    if lock.is_none() {
        let _ = stop_machine_service(service);
        lock = homelock::try_lock_home_database(state_directory)?;
    }
    let Some(_lock) = lock else {
        return Err(Refused::new(format!(
            "Junto did not start on the new build, and something else is still using this machine's database. The restore is owed and finishes on the next boot, which takes the home lock first. The kept copy is at {}.",
            point.directory.display()
        )));
    };
    restore::restore_database_marker(point)
}

/// Prove the service stopped, once: reconcile against the process table and
/// quiesce what it reports.
fn stop_machine_service(service: &mut dyn service::Service) -> Result<(), Refused> {
    service.reconcile()?;
    let seen = service.observe()?;
    quiesce::quiesce_machine_service(service, &seen, || {}).map(|_| ())
}

/// `machine uninstall-local`: retain package and product bytes, remove only the
/// proven owned service.
fn uninstall_flow(
    input: LocalPaths,
) -> Result<UninstallResult, (Refused, Disposition, Vec<Transition>)> {
    let junto_home_value = match input.junto_home.as_deref().map(absolute_path).transpose() {
        Ok(value) => value,
        Err(refused) => return Err((refused, Disposition::Staged, Vec::new())),
    };
    let install_root_value = match input.install_root.as_deref().map(absolute_path).transpose() {
        Ok(value) => value,
        Err(refused) => return Err((refused, Disposition::Staged, Vec::new())),
    };
    let junto_home = match machine_home_path(junto_home_value.unwrap_or_else(paths::home), true) {
        Ok(path) => path,
        Err(refused) => return Err((refused, Disposition::Staged, Vec::new())),
    };
    let install_root = match machine_home_path(
        install_root_value.unwrap_or_else(|| paths::home().join(".junto/machine")),
        false,
    ) {
        Ok(path) => path,
        Err(refused) => return Err((refused, Disposition::Staged, Vec::new())),
    };
    let mut disposition = Disposition::Staged;
    let mut transitions: Vec<Transition> = Vec::new();
    let label = service::service_label(&install_root, &junto_home);
    let run = |disposition: &mut Disposition,
               transitions: &mut Vec<Transition>|
     -> Result<UninstallResult, Refused> {
        service::admit_label(&label)?;
        let marker = install_root.join("owner.json");
        let expected = lock::owner_marker(&label, &junto_home);
        if !owned_machine_file(&marker)? || fs::read_to_string(&marker)? != expected {
            return Err(Refused::new(
                "install directory ownership is not established",
            ));
        }
        lock::admit_install_lock_root(&install_root, &expected)?;
        let _lease = lock::acquire_install_lock(&install_root)?;
        let pointer = paths::optional_metadata(&install_root.join("current"))?;
        let pointer =
            pointer.ok_or_else(|| Refused::new("current must be an owned build selection link"))?;
        if !pointer.file_type().is_symlink() || pointer.uid() != rustix::process::getuid().as_raw()
        {
            return Err(Refused::new(
                "current must be an owned build selection link",
            ));
        }
        let generation = fs::read_link(install_root.join("current"))?;
        let generation = generation.to_string_lossy().into_owned();
        if !generation_path(&generation) {
            return Err(Refused::new("current selects an invalid build directory"));
        }
        paths::check_machine_tree(&install_root.join(&generation))?;
        let mut service = service::machine_service(&install_root, &junto_home, &label)?;
        // Linux reconcile enables linger; uninstall leaves linger as it finds it.
        if service.provider() == Provider::Launchd {
            service.reconcile()?;
        }
        let before = service.observe()?;
        if before.pid > 0 {
            let core = status::read_installed_status(&install_root.join(&generation), &junto_home)?;
            if core.pid != before.pid as i64 || core.junto_home != junto_home.to_string_lossy() {
                return Err(Refused::new("running core does not match this install"));
            }
        }
        let quiesced = quiesce::quiesce_machine_service(&mut *service, &before, || {
            *disposition = Disposition::Uncertain;
        })?;
        transitions.push(Transition {
            build: Some(
                generation
                    .trim_start_matches("builds/")
                    .chars()
                    .take(64)
                    .collect(),
            ),
            pid: quiesced.pid.map(i64::from),
            start_key: quiesced.start_key.clone(),
            service: Some(quiesced.service),
            ..Transition::step("quiescent", None)
        });
        *disposition = Disposition::Uncertain;
        service.remove_definition()?;
        Ok(UninstallResult {
            junto_home: junto_home.to_string_lossy().into_owned(),
            install_root: install_root.to_string_lossy().into_owned(),
            service_label: label.to_string(),
            disposition: "stopped",
            definition_removed: true,
            transitions: transitions.clone(),
        })
    };
    match run(&mut disposition, &mut transitions) {
        Ok(result) => Ok(result),
        Err(refused) => Err((refused, disposition, transitions)),
    }
}

/// The failure envelope a refused install prints, as src/shared/machine-install.ts
/// MachineInstallError carries it.
fn install_failure(
    refused: &Refused,
    disposition: Disposition,
    transitions: &[Transition],
) -> Failure {
    let mut details = json!({
        "retryable": disposition == Disposition::Staged,
        "disposition": disposition,
        "transitions": transitions,
    });
    if let (Some(target), Some(seats)) = (details.as_object_mut(), refused.running_seats) {
        target.insert("runningSeats".into(), json!(seats));
    }
    if let (Some(target), true) = (details.as_object_mut(), refused.running_seats_unknown) {
        target.insert("runningSeatsUnknown".into(), json!(true));
    }
    Failure::new(ErrorType::MachineInstallError, &refused.message).with(details)
}

/// `machine install-local` at the command line.
pub fn install_local(input_text: &str) -> Answer {
    let (text, source) = input::read(input_text)?;
    let input: InstallInput = input::decode_text(&text, &source)?;
    match install_flow(input) {
        Ok(result) => envelope::ok(&result),
        Err((refused, disposition, transitions)) => {
            Err(install_failure(&refused, disposition, &transitions))
        }
    }
}

/// `machine uninstall-local` at the command line.
pub fn uninstall_local(input_text: &str) -> Answer {
    let (text, source) = input::read(input_text)?;
    let input: LocalPaths = input::decode_text(&text, &source)?;
    match uninstall_flow(input) {
        Ok(result) => envelope::ok(&result),
        Err((refused, disposition, transitions)) => {
            Err(install_failure(&refused, disposition, &transitions))
        }
    }
}

/// `machine boat-key-local`: the machine key from stdin into this Junto home,
/// 0600, and an answer that never carries the key.
pub fn boat_key_local() -> Answer {
    let mut bytes = Vec::new();
    let read = std::io::stdin()
        .lock()
        .take(4096)
        .read_to_end(&mut bytes)
        .is_ok();
    let text = if read {
        String::from_utf8(bytes).ok()
    } else {
        None
    };
    let Some(text) = text else {
        return Err(not_placed("The machine key could not be read from stdin"));
    };
    let delivery: boat::BoatMachineKeyDelivery = match serde_json::from_str(&text) {
        Ok(delivery) => delivery,
        Err(_) => return Err(not_placed("The machine key did not match its shape")),
    };
    let home = boat::resolve_junto_home();
    if boat::place_machine_key(&home, &delivery).is_err() {
        return Err(not_placed(
            "The machine key could not be written in this Junto home",
        ));
    }
    envelope::ok(&json!({ "placed": true, "sandboxId": delivery.sandbox_id }))
}

/// Fixed words: a key that fails to decode never shows in the failure.
fn not_placed(message: &str) -> Failure {
    Failure::new(ErrorType::BoatKeyNotPlaced, message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_generation_is_a_build_and_a_target() {
        assert!(generation_path(&format!(
            "builds/{}-linux-x64",
            "a".repeat(64)
        )));
        assert!(generation_path(&format!(
            "builds/{}-darwin-arm64",
            "b".repeat(64)
        )));
        for bad in [
            "builds/short-linux-x64",
            "builds/incoming-1",
            "elsewhere/builds/a",
            &format!("builds/{}-linux-x64/", "a".repeat(64)),
        ] {
            assert!(!generation_path(bad), "{bad}");
        }
    }

    #[test]
    fn an_install_path_is_absolute_and_bounded() {
        assert!(absolute_path("/Users/someone/.junto/machine").is_ok());
        for bad in ["", "relative/path", "/tmp/\u{7}"] {
            assert!(absolute_path(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_refusal_carries_the_running_seats_it_proved() {
        let failure = install_failure(
            &Refused::with_running_seats("2 seats are running", 2),
            Disposition::Staged,
            &[],
        );
        let details = failure.details.expect("details");
        assert_eq!(details["runningSeats"], json!(2));
        assert_eq!(details["retryable"], json!(true));
        let unknown = install_failure(
            &Refused::with_running_seats_unknown("no answer"),
            Disposition::Uncertain,
            &[],
        );
        let details = unknown.details.expect("details");
        assert_eq!(details["runningSeatsUnknown"], json!(true));
        assert_eq!(details["retryable"], json!(false));
        assert_eq!(details["disposition"], json!("uncertain"));
    }

    // --- the home lock, at each of the two points an install meets it ---

    /// A service that answers, and counts what it was asked, so a test can see
    /// that the flow started the stopped service again and stopped it once more.
    struct FakeService {
        starts: usize,
        stops: usize,
        running: bool,
        stop_guard: Option<crate::install::homelock::HomeDatabaseLock>,
    }

    impl FakeService {
        fn new() -> Self {
            Self {
                starts: 0,
                stops: 0,
                running: false,
                stop_guard: None,
            }
        }
    }

    impl service::Service for FakeService {
        fn provider(&self) -> service::Provider {
            service::Provider::SystemdUser
        }
        fn reconcile(&mut self) -> Result<Vec<&'static str>, Refused> {
            Ok(Vec::new())
        }
        fn observe(&mut self) -> Result<service::Observed, Refused> {
            Ok(service::Observed {
                loaded: self.running,
                pid: 0,
                matches_desired_placement: true,
            })
        }
        fn stop(&mut self) -> Result<(), Refused> {
            self.stops += 1;
            self.running = false;
            if let Some(guard) = self.stop_guard.take() {
                drop(guard);
            }
            Ok(())
        }
        fn start(&mut self) -> Result<(), Refused> {
            self.starts += 1;
            self.running = true;
            Ok(())
        }
        fn remove_definition(&mut self) -> Result<(), Refused> {
            Ok(())
        }
    }

    fn private(root: &Path) {
        let mut builder = std::fs::DirBuilder::new();
        builder
            .recursive(true)
            .mode(0o700)
            .create(root)
            .expect("a private directory");
        fs::set_permissions(root, fs::Permissions::from_mode(0o700)).expect("private");
    }

    fn installed(root: &Path) -> (PathBuf, PathBuf) {
        let junto_home = root.join("home");
        let install_root = root.join("machine");
        private(&junto_home);
        private(&install_root);
        let label = service::service_label(&install_root, &junto_home);
        lock::write_owner_marker(&install_root, &lock::owner_marker(&label, &junto_home))
            .expect("the owner marker");
        (junto_home, install_root)
    }

    fn family(state: &Path) {
        private(state);
        for (name, body) in [("junto.db", "kept"), ("junto.db-wal", "kept-wal")] {
            let file = state.join(name);
            fs::write(&file, body).expect("a member");
            fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).expect("private");
        }
    }

    /// The database family's bytes, the only files a restore moves.
    fn bytes(state: &Path) -> Vec<(String, Vec<u8>)> {
        let mut read: Vec<(String, Vec<u8>)> = fs::read_dir(state)
            .expect("the state directory")
            .filter_map(|entry| {
                let entry = entry.expect("an entry");
                let name = entry.file_name().to_string_lossy().into_owned();
                name.starts_with("junto.db")
                    .then(|| (name, fs::read(entry.path()).expect("a family member")))
            })
            .collect();
        read.sort();
        read
    }

    #[test]
    fn a_held_home_lock_at_the_copy_starts_the_service_again_and_changes_nothing() {
        let root = paths::home().join(format!(".junto-held-copy-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let (_home, _install_root) = installed(&root);
        let state = root.join("state");
        family(&state);
        let before = bytes(&state);
        let holder = homelock::try_lock_home_database(&state)
            .expect("readable")
            .expect("the holder");
        let mut service = FakeService::new();
        let refused = match lock_for_copy(&state, &mut service) {
            Err(refused) => refused,
            Ok(_) => panic!("a held lock is not a lock this install holds"),
        };
        assert_eq!(refused.message, homelock::HELD_WORDS);
        assert_eq!(service.starts, 1, "the service it stopped is started again");
        assert_eq!(bytes(&state), before, "nothing was changed");
        drop(holder);
        assert!(lock_for_copy(&state, &mut service).is_ok());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_home_lock_held_through_the_second_stop_leaves_the_restore_owed() {
        let root = paths::home().join(format!(".junto-held-restore-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let state = root.join("state");
        family(&state);
        let before = bytes(&state);
        let point = restore::make_restore_point(&state)
            .expect("a point")
            .expect("a database");
        // The candidate replaced the family and left it that way.
        fs::write(state.join("junto.db"), b"candidate").expect("a candidate");
        let holder = homelock::try_lock_home_database(&state)
            .expect("readable")
            .expect("the holder");
        let mut service = FakeService::new();
        service.running = true;
        let refused = match restore_under_home_lock(&point, &state, &mut service) {
            Err(refused) => refused,
            Ok(_) => panic!("the family must not move under a held lock"),
        };
        assert!(
            refused.message.contains("The restore is owed"),
            "{}",
            refused.message
        );
        assert_eq!(service.stops, 1, "one more stop before the second try");
        assert!(
            restore::restore_pending(&state).expect("readable"),
            "the marker stays for the next boot"
        );
        assert_eq!(
            fs::read(state.join("junto.db")).expect("the db"),
            b"candidate"
        );
        drop(holder);
        // The next boot's finish is the same restore, under the lock it holds.
        let finished = restore::finish_interrupted_restore(&state)
            .expect("the finish")
            .expect("a restore to finish");
        let _ = finished;
        assert!(!restore::restore_pending(&state).expect("readable"));
        assert_eq!(
            bytes(&state)
                .into_iter()
                .filter(|(name, _)| name == "junto.db")
                .collect::<Vec<_>>(),
            before
                .into_iter()
                .filter(|(name, _)| name == "junto.db")
                .collect::<Vec<_>>()
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_home_lock_the_second_stop_releases_is_retried_and_the_restore_finishes() {
        let root = paths::home().join(format!(".junto-late-restore-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let state = root.join("state");
        family(&state);
        let point = restore::make_restore_point(&state)
            .expect("a point")
            .expect("a database");
        fs::write(state.join("junto.db"), b"candidate").expect("a candidate");
        let holder = homelock::try_lock_home_database(&state)
            .expect("readable")
            .expect("the holder");
        let mut service = FakeService::new();
        service.running = true;
        service.stop_guard = Some(holder);
        restore_under_home_lock(&point, &state, &mut service).expect("the retry restores");
        assert_eq!(service.stops, 1);
        assert!(!restore::restore_pending(&state).expect("readable"));
        assert_eq!(fs::read(state.join("junto.db")).expect("the db"), b"kept");
        let _ = fs::remove_dir_all(&root);
    }

    // --- the boot step ---

    #[test]
    fn a_boot_with_no_marker_answers_without_taking_anything() {
        let root = paths::home().join(format!(".junto-boot-none-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let junto_home = root.join("home");
        private(&junto_home);
        let data = restore_finish_at(&junto_home, None).expect("nothing owed");
        assert!(!data.finished);
        assert!(!junto_home.join(".junto/state/home.lock").exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_boot_with_a_marker_and_a_held_install_lock_answers_updating() {
        let root = paths::home().join(format!(".junto-boot-held-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let (junto_home, install_root) = installed(&root);
        let state = restore::machine_state_directory(&junto_home);
        family(&state);
        let point = restore::make_restore_point(&state)
            .expect("a point")
            .expect("a database");
        restore::write_restore_marker(&point).expect("the marker is written");
        let lease = lock::acquire_install_lock(&install_root).expect("the install lock");
        match restore_finish_at(&junto_home, Some(&install_root)) {
            Err(RestoreFinish::Updating(error)) => {
                assert!(error.message.contains("cannot finish a database restore"));
            }
            _ => panic!("an install holds the home, so the boot says so"),
        }
        assert!(restore::restore_pending(&state).expect("readable"));
        drop(lease);
        let data = restore_finish_at(&junto_home, Some(&install_root)).expect("the finish");
        assert!(data.finished);
        assert!(!restore::restore_pending(&state).expect("readable"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_boot_whose_kept_copy_is_gone_refuses_with_the_path_a_local_log_can_name() {
        let root = paths::home().join(format!(".junto-boot-gone-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let junto_home = root.join("home");
        private(&junto_home);
        let state = restore::machine_state_directory(&junto_home);
        family(&state);
        let point = restore::make_restore_point(&state)
            .expect("a point")
            .expect("a database");
        restore::write_restore_marker(&point).expect("the marker is written");
        fs::remove_dir_all(&point.directory).expect("the kept copy is gone");
        match restore_finish_at(&junto_home, None) {
            Err(RestoreFinish::Fault(refused)) => {
                assert!(
                    refused
                        .message
                        .contains(&point.directory.display().to_string()),
                    "{}",
                    refused.message
                );
            }
            _ => panic!("a marker whose copy is gone refuses the boot"),
        }
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn an_install_meets_a_held_lock_before_it_reads_anything_and_changes_nothing() {
        let root = paths::home().join(format!(".junto-gap-a-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let (junto_home, install_root) = installed(&root);
        let state = restore::machine_state_directory(&junto_home);
        family(&state);
        let point = restore::make_restore_point(&state)
            .expect("a point")
            .expect("a database");
        restore::write_restore_marker(&point).expect("the marker is written");
        let before = bytes(&state);
        let lease = lock::acquire_install_lock(&install_root).expect("the install lock");
        let input = json!({
            "bundle": root.join("no-bundle").display().to_string(),
            "juntoHome": junto_home.display().to_string(),
            "installRoot": install_root.display().to_string(),
        })
        .to_string();
        let refused = install_local(&input)
            .err()
            .expect("a second installer is refused");
        assert!(
            refused.message.contains("already being sent"),
            "{}",
            refused.message
        );
        assert_eq!(
            bytes(&state),
            before,
            "the marker, the kept copy and the family are untouched"
        );
        assert!(restore::restore_pending(&state).expect("readable"));
        drop(lease);
        let _ = fs::remove_dir_all(&root);
    }
}
