//! The service an install owns, as it is written and read: one launchd job on macOS (Aqua, or Background when no graphical
//! domain answers) or one systemd user unit on Linux, its exact bytes, its exact
//! loaded paths and home, and nothing else ever acted on. The bytes are the seam
//! tests/fixtures/link-service-bodies.json holds, so a link's start and an
//! install's writer agree.

use std::fs;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use super::Check;
use super::Refused;
use super::paths::{
    home, owned_machine_file, remove_machine_service_file, write_machine_service_file,
};
use super::run::{Runner, System};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Provider {
    Launchd,
    SystemdUser,
}

/// What one observation proved about the service.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Observed {
    pub loaded: bool,
    pub pid: u32,
    pub matches_desired_placement: bool,
}

/// A notice the window owns the words for.
pub const LINGER_NOT_ENABLED: &str = "linger-not-enabled";

pub trait Service {
    fn provider(&self) -> Provider;
    fn reconcile(&mut self) -> Result<Vec<&'static str>, Refused>;
    fn observe(&mut self) -> Result<Observed, Refused>;
    fn stop(&mut self) -> Result<(), Refused>;
    fn start(&mut self) -> Result<(), Refused>;
    fn remove_definition(&mut self) -> Result<(), Refused>;
}

/// The one service label shape Junto mints; it is spliced into launchctl and
/// systemctl targets, so nothing else is ever accepted.
pub fn admit_label(label: &str) -> Result<(), Refused> {
    let Some(rest) = label.strip_prefix("dev.junto.machine.") else {
        return Err(
            Refused::new("The machine service label is not one Junto minted")
                .with_check(Check::ServiceNotOurs),
        );
    };
    if rest.len() != 16
        || !rest
            .chars()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&(c as u8)))
    {
        return Err(
            Refused::new("The machine service label is not one Junto minted")
                .with_check(Check::ServiceNotOurs),
        );
    }
    Ok(())
}

/// The label one install owns: the first 16 hex of sha256 over
/// "<installRoot>\0<juntoHome>".
pub fn service_label(install_root: &Path, junto_home: &Path) -> String {
    let mut digest = Sha256::new();
    digest.update(install_root.to_string_lossy().as_bytes());
    digest.update([0u8]);
    digest.update(junto_home.to_string_lossy().as_bytes());
    let hex: String = digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    format!("dev.junto.machine.{}", &hex[..16])
}

fn xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// One plist body, for the session domain it runs in.
pub fn plist_body(root: &Path, home: &Path, label: &str, session: &str) -> String {
    let node = root.join("current/bin/node");
    let entry = root.join("current/core/junto.cjs");
    let stdout = root.join("logs/stdout.log");
    let stderr = root.join("logs/stderr.log");
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\"><dict><key>Label</key><string>{label}</string><key>ProgramArguments</key><array><string>{}</string><string>{}</string></array><key>EnvironmentVariables</key><dict><key>JUNTO_HOME</key><string>{}</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ProcessType</key><string>Background</string><key>LimitLoadToSessionType</key><string>{session}</string><key>StandardOutPath</key><string>{}</string><key>StandardErrorPath</key><string>{}</string></dict></plist>\n",
        xml(&node.to_string_lossy()),
        xml(&entry.to_string_lossy()),
        xml(&home.to_string_lossy()),
        xml(&stdout.to_string_lossy()),
        xml(&stderr.to_string_lossy()),
    )
}

/// systemd's own quoting for one value in a unit line.
pub fn unit(value: &str) -> String {
    let mut out = String::from("\"");
    for c in value.chars() {
        match c {
            '%' => out.push_str("%%"),
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            other => out.push(other),
        }
    }
    out.push('"');
    out
}

/// The unit this build writes, and the legacy one it replaces.
pub fn systemd_bodies(root: &Path, home: &Path) -> (String, String) {
    let node = root.join("current/bin/node");
    let entry = root.join("current/core/junto.cjs");
    let exec = format!(
        ":{} {}",
        unit(&node.to_string_lossy()),
        unit(&entry.to_string_lossy())
    );
    let environment = unit(&format!("JUNTO_HOME={}", home.to_string_lossy()));
    (
        format!(
            "[Unit]\nDescription=Junto\nAfter=network.target\nStartLimitIntervalSec=0\n\n[Service]\nType=simple\nExecStart={exec}\nEnvironment={environment}\nRestart=on-failure\nRestartSec=10\nTimeoutStopSec=30\nUMask=0077\n\n[Install]\nWantedBy=default.target\n"
        ),
        format!(
            "[Unit]\nDescription=Junto\nAfter=network.target\n\n[Service]\nType=simple\nExecStart={exec}\nEnvironment={environment}\nRestart=on-failure\nRestartSec=2\nTimeoutStopSec=30\nUMask=0077\n\n[Install]\nWantedBy=default.target\n"
        ),
    )
}

/// The service this install owns, by the platform it runs on.
pub fn machine_service(
    root: &Path,
    junto_home: &Path,
    label: &str,
) -> Result<Box<dyn Service>, Refused> {
    admit_label(label)?;
    if cfg!(target_os = "macos") {
        return Ok(Box::new(Launchd::new(
            root,
            junto_home,
            label,
            Box::new(System),
        )?));
    }
    if cfg!(target_os = "linux") {
        return Ok(Box::new(Systemd::new(
            root,
            junto_home,
            label,
            Box::new(System),
        )));
    }
    Err(Refused::new("machine services support macOS and Linux")
        .with_check(Check::ServicePlatformUnsupported))
}

fn uid() -> u32 {
    rustix::process::getuid().as_raw()
}

// --- launchd ------------------------------------------------------------------

struct Launchd {
    label: String,
    file: PathBuf,
    node: String,
    entry: String,
    home: String,
    gui: String,
    user: String,
    background: String,
    aqua: String,
    domain: String,
    desired: String,
    admitted: Option<Job>,
    runner: Box<dyn Runner>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Job {
    domain: String,
    pid: u32,
    definition: String,
}

impl Launchd {
    fn new(
        root: &Path,
        junto_home: &Path,
        label: &str,
        runner: Box<dyn Runner>,
    ) -> Result<Self, Refused> {
        let file = home()
            .join("Library/LaunchAgents")
            .join(format!("{label}.plist"));
        Launchd::at(root, junto_home, label, file, runner)
    }

    fn at(
        root: &Path,
        junto_home: &Path,
        label: &str,
        file: PathBuf,
        runner: Box<dyn Runner>,
    ) -> Result<Self, Refused> {
        admit_label(label)?;
        let node = root.join("current/bin/node").to_string_lossy().into_owned();
        let entry = root
            .join("current/core/junto.cjs")
            .to_string_lossy()
            .into_owned();
        let home_text = junto_home.to_string_lossy().into_owned();
        let gui = format!("gui/{}", uid());
        let user = format!("user/{}", uid());
        let background = plist_body(root, junto_home, label, "Background");
        let aqua = plist_body(root, junto_home, label, "Aqua");
        let domain = match runner.run("/bin/launchctl", &["print", &gui]) {
            Ok(_) => gui.clone(),
            Err(failure) if failure.exit_is(112) => user.clone(),
            Err(failure) => return Err(Refused::new(failure.message)),
        };
        let desired = if domain == gui {
            aqua.clone()
        } else {
            background.clone()
        };
        super::paths::ensure_machine_directory(file.parent().unwrap_or(&file), false)?;
        let service = Launchd {
            label: label.to_string(),
            file,
            node,
            entry,
            home: home_text,
            gui,
            user,
            background,
            aqua,
            domain,
            desired,
            admitted: None,
            runner,
        };
        service.definition()?;
        Ok(service)
    }

    fn definition(&self) -> Result<Option<String>, Refused> {
        if !owned_machine_file(&self.file)? {
            return Ok(None);
        }
        let value = fs::read_to_string(&self.file).map_err(Refused::from)?;
        if value != self.background && value != self.aqua {
            return Err(
                Refused::new("existing service definition belongs to a different install")
                    .with_check(Check::ServiceNotOurs),
            );
        }
        Ok(Some(value))
    }

    fn snapshot(&self) -> Result<Vec<Job>, Refused> {
        let value = self.definition()?;
        let mut jobs = Vec::new();
        for candidate in [self.user.clone(), self.gui.clone()] {
            let target = format!("{candidate}/{}", self.label);
            let output = match self.runner.run("/bin/launchctl", &["print", &target]) {
                Ok(output) => output,
                Err(failure) => {
                    let skip =
                        failure.exit_is(113) || (candidate == self.gui && failure.exit_is(112));
                    if skip {
                        continue;
                    }
                    return Err(Refused::new(failure.message));
                }
            };
            let lines: Vec<String> = output
                .split('\n')
                .map(|line| line.trim().to_string())
                .collect();
            let arguments = argument_lines(&output);
            let has = |line: &str| lines.iter().any(|held| held == line);
            let path_line = format!("path = {}", self.file.display());
            let program_line = format!("program = {}", self.node);
            let home_line = format!("JUNTO_HOME => {}", self.home);
            let arguments_match = arguments.as_ref().is_some_and(|args| {
                args.len() == 2 && args[0] == self.node && args[1] == self.entry
            });
            if value.is_none()
                || !has(&path_line)
                || !has(&program_line)
                || !has(&home_line)
                || !arguments_match
            {
                return Err(
                    Refused::new("loaded service does not belong to this install")
                        .with_check(Check::ServiceNotOurs),
                );
            }
            jobs.push(Job {
                domain: candidate,
                pid: pid_of(&output),
                definition: value.clone().unwrap_or_default(),
            });
        }
        Ok(jobs)
    }

    fn quiesce_job(&mut self, job: &Job) -> Result<(), Refused> {
        // The job's own answer is the stop's proof: the domain it lives in.
        let current = self
            .snapshot()?
            .into_iter()
            .find(|held| held.domain == job.domain);
        let Some(current) = current else {
            return Ok(());
        };
        if current.pid != job.pid || current.definition != job.definition {
            return Err(
                Refused::new("service changed after admission; stopping refused")
                    .with_check(Check::ServiceNotOurs),
            );
        }
        let target = format!("{}/{}", job.domain, self.label);
        self.runner
            .run("/bin/launchctl", &["bootout", &target])
            .map(|_| ())
            .map_err(|failure| Refused::new(failure.message))
    }
}

impl Launchd {
    /// A graphical session exists and its job is running, so it is the one that
    /// stays: the fallback job goes, the session is the desired one, and the
    /// definition on disk is the Aqua body. Answers whether it found one.
    fn adopt_gui(&mut self) -> Result<bool, Refused> {
        let jobs = self.snapshot()?;
        if !jobs.iter().any(|job| job.domain == self.gui) {
            return Ok(false);
        }
        if let Some(fallback) = jobs.iter().find(|job| job.domain == self.user).cloned() {
            self.quiesce_job(&fallback)?;
        }
        self.domain = self.gui.clone();
        self.desired = self.aqua.clone();
        let previous = self.definition()?;
        if let Some(previous) = previous.filter(|held| held != &self.desired) {
            remove_machine_service_file(&self.file, &previous)?;
        }
        write_machine_service_file(&self.file, &self.desired)?;
        Ok(true)
    }
}

/// The `arguments = { ... }` block launchctl prints for a job.
fn argument_lines(output: &str) -> Option<Vec<String>> {
    let mut inside = false;
    let mut lines = Vec::new();
    for line in output.split('\n') {
        let trimmed = line.trim();
        if !inside {
            if trimmed.starts_with("arguments = {") {
                inside = true;
            }
            continue;
        }
        if trimmed.starts_with('}') {
            return Some(lines);
        }
        if !trimmed.is_empty() {
            lines.push(trimmed.to_string());
        }
    }
    None
}

/// The `pid = N` a launchctl print shows, or 0 when the job is not running.
fn pid_of(output: &str) -> u32 {
    for line in output.split('\n') {
        let trimmed = line.trim();
        if let Some(pid) = trimmed
            .strip_prefix("pid = ")
            .and_then(|rest| rest.trim().parse::<u32>().ok())
        {
            return pid;
        }
    }
    0
}

impl Service for Launchd {
    fn provider(&self) -> Provider {
        Provider::Launchd
    }

    fn reconcile(&mut self) -> Result<Vec<&'static str>, Refused> {
        self.adopt_gui()?;
        Ok(Vec::new())
    }

    fn observe(&mut self) -> Result<Observed, Refused> {
        let jobs = self.snapshot()?;
        let admitted = jobs
            .iter()
            .find(|job| job.domain == self.gui)
            .or_else(|| jobs.first())
            .cloned();
        let observed = Observed {
            loaded: admitted.is_some(),
            pid: admitted.as_ref().map(|job| job.pid).unwrap_or(0),
            matches_desired_placement: jobs.len() == 1
                && admitted
                    .as_ref()
                    .is_some_and(|job| job.domain == self.domain && job.definition == self.desired),
        };
        self.admitted = admitted;
        Ok(observed)
    }

    fn stop(&mut self) -> Result<(), Refused> {
        let jobs = self.snapshot()?;
        if jobs.is_empty() {
            return Ok(());
        }
        let current = self
            .admitted
            .as_ref()
            .and_then(|admitted| jobs.iter().find(|job| job.domain == admitted.domain));
        let changed = self.admitted.is_none()
            || current.is_some_and(|current| {
                let admitted = self.admitted.as_ref().expect("admitted");
                admitted.pid != current.pid || admitted.definition != current.definition
            });
        if changed {
            return Err(
                Refused::new("service changed after admission; stopping refused")
                    .with_check(Check::ServiceNotOurs),
            );
        }
        for job in jobs {
            self.quiesce_job(&job)?;
        }
        Ok(())
    }

    fn start(&mut self) -> Result<(), Refused> {
        if !self.snapshot()?.is_empty() {
            return Err(
                Refused::new("Junto service must be quiescent before starting")
                    .with_check(Check::ServiceNotQuiescent),
            );
        }
        let previous = self.definition()?;
        if let Some(previous) = previous.filter(|held| held != &self.desired) {
            remove_machine_service_file(&self.file, &previous)?;
        }
        write_machine_service_file(&self.file, &self.desired)?;
        let file = self.file.to_string_lossy().into_owned();
        if let Err(failure) = self
            .runner
            .run("/bin/launchctl", &["bootstrap", &self.domain, &file])
        {
            // A login can land between the session probe and this bootstrap,
            // starting the graphical job the operator's own login owns. Then
            // the fallback is the one to stop, never the job just started.
            if !self.adopt_gui()? {
                return Err(Refused::new(failure.message));
            }
        }
        // A login that landed while this start was running owns the session:
        // the fallback goes and the job is kicked in the session that stays.
        self.reconcile()?;
        let target = format!("{}/{}", self.domain, self.label);
        self.runner
            .run("/bin/launchctl", &["kickstart", &target])
            .map_err(|failure| Refused::new(failure.message))?;
        self.reconcile()?;
        Ok(())
    }

    fn remove_definition(&mut self) -> Result<(), Refused> {
        if !self.snapshot()?.is_empty() {
            return Err(Refused::new(
                "Junto service must be quiescent before removing its definition",
            )
            .with_check(Check::ServiceNotQuiescent));
        }
        if let Some(value) = self.definition()? {
            remove_machine_service_file(&self.file, &value)?;
        }
        Ok(())
    }
}

// --- systemd user -------------------------------------------------------------

struct Systemd {
    file: PathBuf,
    name: String,
    node: String,
    body: String,
    legacy: String,
    linger: Option<Vec<&'static str>>,
    runner: Box<dyn Runner>,
}

impl Systemd {
    fn new(root: &Path, junto_home: &Path, label: &str, runner: Box<dyn Runner>) -> Self {
        let file = home()
            .join(".config/systemd/user")
            .join(format!("{label}.service"));
        Systemd::at(root, junto_home, label, file, runner)
    }

    fn at(
        root: &Path,
        junto_home: &Path,
        label: &str,
        file: PathBuf,
        runner: Box<dyn Runner>,
    ) -> Self {
        let (body, legacy) = systemd_bodies(root, junto_home);
        Systemd {
            file,
            name: format!("{label}.service"),
            node: root.join("current/bin/node").to_string_lossy().into_owned(),
            body,
            legacy,
            linger: None,
            runner,
        }
    }

    fn definition(&self) -> Result<Option<String>, Refused> {
        if !owned_machine_file(&self.file)? {
            return Ok(None);
        }
        let value = fs::read_to_string(&self.file).map_err(Refused::from)?;
        if value != self.body && value != self.legacy {
            return Err(
                Refused::new("existing service definition belongs to a different install")
                    .with_check(Check::ServiceNotOurs),
            );
        }
        Ok(Some(value))
    }

    fn systemctl(&self, args: &[&str]) -> Result<String, Refused> {
        self.runner
            .run("/usr/bin/systemctl", args)
            .map_err(|failure| Refused::new(failure.message))
    }

    fn linger_state(&self) -> &'static str {
        match self.runner.run(
            "/usr/bin/loginctl",
            &["show-user", &uid().to_string(), "-p", "Linger"],
        ) {
            Ok(output) => {
                for line in output.split('\n') {
                    let trimmed = line.trim_end();
                    if trimmed == "Linger=yes" {
                        return "yes";
                    }
                    if trimmed == "Linger=no" {
                        return "no";
                    }
                }
                "unknown"
            }
            Err(_) => "unknown",
        }
    }

    fn enable_linger(&self) -> Vec<&'static str> {
        if self.linger_state() == "yes" {
            return Vec::new();
        }
        if self
            .runner
            .run("/usr/bin/loginctl", &["enable-linger", &uid().to_string()])
            .is_err()
        {
            return vec![LINGER_NOT_ENABLED];
        }
        if self.linger_state() == "yes" {
            Vec::new()
        } else {
            vec![LINGER_NOT_ENABLED]
        }
    }
}

impl Service for Systemd {
    fn provider(&self) -> Provider {
        Provider::SystemdUser
    }

    fn reconcile(&mut self) -> Result<Vec<&'static str>, Refused> {
        if self.linger.is_none() {
            self.linger = Some(self.enable_linger());
        }
        Ok(self.linger.clone().unwrap_or_default())
    }

    fn observe(&mut self) -> Result<Observed, Refused> {
        let output = self.systemctl(&[
            "--user",
            "show",
            &self.name,
            "--property=LoadState,MainPID,FragmentPath,ExecStart",
        ])?;
        let mut fields = std::collections::BTreeMap::new();
        for line in output.trim().split('\n') {
            if let Some((key, value)) = line.split_once('=') {
                fields.insert(key.to_string(), value.to_string());
            }
        }
        let load = fields.get("LoadState").cloned().unwrap_or_default();
        let pid_text = fields.get("MainPID").cloned().unwrap_or_default();
        if load == "not-found" && pid_text == "0" {
            return Ok(Observed {
                loaded: false,
                pid: 0,
                matches_desired_placement: true,
            });
        }
        let fragment = fields.get("FragmentPath").cloned().unwrap_or_default();
        let exec = fields.get("ExecStart").cloned().unwrap_or_default();
        if load != "loaded"
            || fragment != self.file.to_string_lossy()
            || !exec.contains(&format!("path={} ;", self.node))
        {
            return Err(
                Refused::new("loaded service does not belong to this install")
                    .with_check(Check::ServiceNotOurs),
            );
        }
        let digits = !pid_text.is_empty()
            && pid_text.chars().next().is_some_and(|c| c.is_ascii_digit())
            && !pid_text.starts_with('0')
            && pid_text.chars().all(|c| c.is_ascii_digit());
        if !digits && pid_text != "0" {
            return Err(Refused::new("service returned an invalid process id")
                .with_check(Check::ServiceNotOurs));
        }
        Ok(Observed {
            loaded: true,
            pid: pid_text.parse().unwrap_or(0),
            matches_desired_placement: true,
        })
    }

    fn stop(&mut self) -> Result<(), Refused> {
        self.systemctl(&["--user", "stop", &self.name]).map(|_| ())
    }

    fn start(&mut self) -> Result<(), Refused> {
        let previous = self.definition()?;
        if let Some(previous) = previous.filter(|held| held != &self.body) {
            remove_machine_service_file(&self.file, &previous)?;
        }
        write_machine_service_file(&self.file, &self.body)?;
        self.systemctl(&["--user", "daemon-reload"])?;
        self.systemctl(&["--user", "enable", &self.name])?;
        self.systemctl(&["--user", "start", &self.name]).map(|_| ())
    }

    fn remove_definition(&mut self) -> Result<(), Refused> {
        let value = self.definition()?;
        if let Some(value) = value {
            self.systemctl(&["--user", "disable", &self.name])?;
            remove_machine_service_file(&self.file, &value)?;
            self.systemctl(&["--user", "daemon-reload"])?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::super::run::RunFailed;
    use super::*;
    use std::collections::BTreeMap;
    use std::sync::Mutex;

    /// The host's answers, keyed by the command line, so a writer is proven
    /// without a host.
    struct Canned {
        answers: Mutex<BTreeMap<String, Result<String, RunFailed>>>,
        calls: Mutex<Vec<String>>,
    }

    impl Runner for Canned {
        fn run(&self, program: &str, args: &[&str]) -> Result<String, RunFailed> {
            let key = format!("{program} {}", args.join(" "));
            self.calls.lock().expect("calls").push(key.clone());
            self.answers
                .lock()
                .expect("answers")
                .get(&key)
                .cloned()
                .unwrap_or_else(|| {
                    Err(RunFailed {
                        exit: None,
                        message: format!("no canned answer for {key}"),
                    })
                })
        }
    }

    fn fixture() -> serde_json::Value {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/fixtures/link-service-bodies.json");
        let text = fs::read_to_string(&path).expect("the service bodies fixture");
        serde_json::from_str(&text).expect("the fixture is JSON")
    }

    /// The writer's bytes are the fixture's, byte for byte: a link's start
    /// (native/cli/src/commands/pipes/link/start.rs) writes the same ones.
    #[test]
    fn the_unit_bodies_carry_no_private_network() {
        // The home lock's name is an abstract socket, which lives in a network
        // namespace: a hardened unit that isolated the network would split the
        // lock in two and let a second core open the database.
        let (body, legacy) =
            systemd_bodies(Path::new("/home/peer/machine"), Path::new("/home/peer"));
        for unit in [body, legacy] {
            assert!(
                !unit.contains("PrivateNetwork"),
                "a unit with PrivateNetwork would split the home lock: {unit}"
            );
        }
        let plist = plist_body(
            Path::new("/Users/peer/machine"),
            Path::new("/Users/peer"),
            "dev.junto.machine.0123456789abcdef",
            "Aqua",
        );
        assert!(!plist.to_lowercase().contains("privatenetwork"));
    }

    #[test]
    fn the_writers_produce_the_fixture_bodies_exactly() {
        let fixture = fixture();
        let root = PathBuf::from(fixture["root"].as_str().expect("root"));
        let home = PathBuf::from(fixture["home"].as_str().expect("home"));
        let label = fixture["label"].as_str().expect("label");
        assert_eq!(
            plist_body(&root, &home, label, "Aqua"),
            fixture["launchd"]["aqua"].as_str().expect("aqua")
        );
        assert_eq!(
            plist_body(&root, &home, label, "Background"),
            fixture["launchd"]["background"]
                .as_str()
                .expect("background")
        );
        let (body, legacy) = systemd_bodies(&root, &home);
        assert_eq!(
            body,
            fixture["systemd"]["current"].as_str().expect("current")
        );
        assert_eq!(
            legacy,
            fixture["systemd"]["legacy"].as_str().expect("legacy")
        );
    }

    #[test]
    fn the_label_is_the_first_sixteen_hex_of_root_and_home() {
        let fixture = fixture();
        let root = PathBuf::from(fixture["root"].as_str().expect("root"));
        let home = PathBuf::from(fixture["home"].as_str().expect("home"));
        assert_eq!(
            service_label(&root, &home),
            fixture["label"].as_str().expect("label")
        );
        assert!(admit_label("dev.junto.machine.26d96d7bc0190e7e").is_ok());
        for bad in [
            "",
            "dev.junto.machine.",
            "dev.junto.machine.ABCDEF0123456789",
            "launchd.1",
        ] {
            assert!(admit_label(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_linux_unit_whose_fragment_or_exec_is_elsewhere_is_refused() {
        let root = home().join(".junto-service-test");
        let together = home();
        let label = service_label(&root, &together);
        let file = home()
            .join(".config/systemd/user")
            .join(format!("{label}.service"));
        let node = root.join("current/bin/node").to_string_lossy().into_owned();
        let mut answers = BTreeMap::new();
        answers.insert(
            "/usr/bin/systemctl --user show ".to_string() + &format!("{label}.service") + " --property=LoadState,MainPID,FragmentPath,ExecStart",
            Ok(format!(
                "LoadState=loaded\nMainPID=42\nFragmentPath={}\nExecStart={{ path={node} ; argv[]={node} /x ; }}",
                file.display()
            )),
        );
        let canned = Canned {
            answers: Mutex::new(answers),
            calls: Mutex::new(Vec::new()),
        };
        let mut service = Systemd::new(&root, &together, &label, Box::new(canned));
        let observed = service.observe().expect("this install's unit");
        assert_eq!(observed.pid, 42);
        assert!(observed.loaded);
        // Another fragment path is not this install.
        let elsewhere = {
            let mut answers = BTreeMap::new();
            answers.insert(
                "/usr/bin/systemctl --user show ".to_string() + &format!("{label}.service") + " --property=LoadState,MainPID,FragmentPath,ExecStart",
                Ok(format!(
                    "LoadState=loaded\nMainPID=42\nFragmentPath=/elsewhere\nExecStart={{ path={node} ; }}"
                )),
            );
            Canned {
                answers: Mutex::new(answers),
                calls: Mutex::new(Vec::new()),
            }
        };
        let mut service = Systemd::new(&root, &together, &label, Box::new(elsewhere));
        assert!(service.observe().is_err());
    }

    #[test]
    fn a_launchd_job_block_is_read_as_its_arguments_and_pid() {
        let output = "gui/501/dev.junto.machine.26d96d7bc0190e7e = {\n\tpath = /Users/x/Library/LaunchAgents/dev.junto.machine.26d96d7bc0190e7e.plist\n\tprogram = /Users/x/.junto/machine/current/bin/node\n\targuments = {\n\t\t/Users/x/.junto/machine/current/bin/node\n\t\t/Users/x/.junto/machine/current/core/junto.cjs\n\t}\n\tpid = 1234\n}\n";
        assert_eq!(
            argument_lines(output),
            Some(vec![
                "/Users/x/.junto/machine/current/bin/node".to_string(),
                "/Users/x/.junto/machine/current/core/junto.cjs".to_string(),
            ])
        );
        assert_eq!(pid_of(output), 1234);
        assert_eq!(pid_of("no pid here"), 0);
    }

    // --- the host, as launchctl and systemctl answer it ---

    use super::super::paths;
    use std::os::unix::fs::PermissionsExt;
    use std::sync::{Arc, Mutex as ArcMutex};

    #[derive(Clone)]
    struct FakeJob {
        pid: u32,
        path: String,
        program: String,
        args: Vec<String>,
        home: String,
    }

    /// A launchd host: the graphical session, the jobs in each session, the
    /// file the plist is written to, and every call made. Cloned into the
    /// service, so a test sees what the service asked for.
    #[derive(Clone)]
    struct Hosted {
        gui: Arc<ArcMutex<bool>>,
        jobs: Arc<ArcMutex<BTreeMap<String, FakeJob>>>,
        calls: Arc<ArcMutex<Vec<String>>>,
        failure: Arc<ArcMutex<Option<String>>>,
        inject_login: Arc<ArcMutex<bool>>,
        file: PathBuf,
        node: String,
        entry: String,
        home: String,
    }

    impl Hosted {
        fn new(root: &Path, home: &Path, file: PathBuf, gui: bool) -> Hosted {
            Hosted {
                gui: Arc::new(ArcMutex::new(gui)),
                jobs: Arc::new(ArcMutex::new(BTreeMap::new())),
                calls: Arc::new(ArcMutex::new(Vec::new())),
                failure: Arc::new(ArcMutex::new(None)),
                inject_login: Arc::new(ArcMutex::new(false)),
                file,
                node: root.join("current/bin/node").to_string_lossy().into_owned(),
                entry: root
                    .join("current/core/junto.cjs")
                    .to_string_lossy()
                    .into_owned(),
                home: home.to_string_lossy().into_owned(),
            }
        }

        fn own_job(&self, pid: u32) -> FakeJob {
            FakeJob {
                pid,
                path: self.file.to_string_lossy().into_owned(),
                program: self.node.clone(),
                args: vec![self.node.clone(), self.entry.clone()],
                home: self.home.clone(),
            }
        }

        /// The calls that change something, by their launchctl arguments.
        fn mutations(&self) -> Vec<String> {
            self.calls
                .lock()
                .expect("calls")
                .iter()
                .filter_map(|call| call.split_once(' ').map(|(_, rest)| rest.to_string()))
                .filter(|call| !call.starts_with("print "))
                .collect()
        }

        fn clear(&self) {
            self.calls.lock().expect("calls").clear();
        }

        fn seed(&self, pid: u32) {
            let domain = self.domain();
            self.jobs
                .lock()
                .expect("jobs")
                .insert(domain, self.own_job(pid));
        }

        fn domain(&self) -> String {
            if *self.gui.lock().expect("gui") {
                format!("gui/{}", uid())
            } else {
                format!("user/{}", uid())
            }
        }

        fn jobs(&self) -> usize {
            self.jobs.lock().expect("jobs").len()
        }

        fn has(&self, domain: &str) -> bool {
            self.jobs.lock().expect("jobs").contains_key(domain)
        }

        fn gui(&self) -> String {
            format!("gui/{}", uid())
        }

        fn user(&self) -> String {
            format!("user/{}", uid())
        }

        fn file(&self) -> PathBuf {
            self.file.clone()
        }
    }

    impl Runner for Hosted {
        fn run(&self, program: &str, args: &[&str]) -> Result<String, RunFailed> {
            assert_eq!(program, "/bin/launchctl", "the plist writer's only tool");
            self.calls
                .lock()
                .expect("calls")
                .push(format!("{} {}", program, args.join(" ")));
            let op = args[0];
            if self.failure.lock().expect("failure").as_deref() == Some(op) {
                return Err(RunFailed {
                    exit: Some(5),
                    message: "launchctl 5".to_string(),
                });
            }
            let target = args.get(1).copied().unwrap_or_default();
            if op == "print" && target == self.gui() {
                return if *self.gui.lock().expect("gui") {
                    Ok("gui exists".to_string())
                } else {
                    Err(RunFailed {
                        exit: Some(112),
                        message: "launchctl 112".to_string(),
                    })
                };
            }
            let domain = if target.starts_with("gui/") {
                self.gui()
            } else {
                self.user()
            };
            if domain == self.gui() && !*self.gui.lock().expect("gui") {
                if *self.inject_login.lock().expect("login") {
                    let body = fs::read_to_string(&self.file).expect("the definition");
                    assert!(
                        body.contains("<string>Aqua</string>"),
                        "the Aqua body is written before the login is observed"
                    );
                    *self.inject_login.lock().expect("login") = false;
                    *self.gui.lock().expect("gui") = true;
                    let job = self.own_job(73);
                    self.jobs.lock().expect("jobs").insert(self.gui(), job);
                }
                return Err(RunFailed {
                    exit: Some(112),
                    message: "launchctl 112".to_string(),
                });
            }
            match op {
                "print" => {
                    let jobs = self.jobs.lock().expect("jobs");
                    let Some(job) = jobs.get(&domain) else {
                        return Err(RunFailed {
                            exit: Some(113),
                            message: "launchctl 113".to_string(),
                        });
                    };
                    let arguments: Vec<String> =
                        job.args.iter().map(|arg| format!("  {arg}")).collect();
                    Ok(format!(
                        "service = {{\n path = {}\n program = {}\n arguments = {{\n{}\n }}\n environment = {{\n JUNTO_HOME => {}\n }}\n pid = {}\n}}",
                        job.path,
                        job.program,
                        arguments.join("\n"),
                        job.home,
                        job.pid
                    ))
                }
                "bootstrap" => {
                    if self.jobs.lock().expect("jobs").contains_key(&domain) {
                        return Err(RunFailed {
                            exit: Some(5),
                            message: "launchctl 5".to_string(),
                        });
                    }
                    let job = self.own_job(72);
                    self.jobs.lock().expect("jobs").insert(domain, job);
                    Ok(String::new())
                }
                "bootout" => {
                    self.jobs.lock().expect("jobs").remove(&domain);
                    Ok(String::new())
                }
                "kickstart" => Ok(String::new()),
                other => panic!("unexpected launchctl {other}"),
            }
        }
    }

    fn hosting(name: &str, gui: bool) -> (PathBuf, Hosted, String) {
        let root = paths::home().join(format!(".junto-service-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("a root");
        let home = root.join("home");
        super::super::paths::ensure_machine_directory(&home, true).expect("a home");
        let label = "dev.junto.machine.0123456789abcdef".to_string();
        let file = root.join("machine.plist");
        let host = Hosted::new(&root.join("machine"), &home, file, gui);
        (root, host, label)
    }

    fn launchd(host: &Hosted, root: &Path, label: &str) -> Launchd {
        Launchd::at(
            &root.join("machine"),
            &root.join("home"),
            label,
            host.file(),
            Box::new(host.clone()),
        )
        .expect("a service")
    }

    #[test]
    fn labels_that_are_not_juntos_are_refused() {
        for bad in [
            "",
            "dev.junto.machine.",
            "dev.junto.machine.0123456789abcdeF",
            "dev.junto.machine.0123456789abcdef/x",
            "x</string><key>",
        ] {
            assert!(admit_label(bad).is_err(), "{bad:?} must not be a label");
        }
        assert!(admit_label("dev.junto.machine.0123456789abcdef").is_ok());
    }

    #[test]
    fn the_label_is_the_install_and_home_the_fixture_names() {
        let fixture = fixture();
        let root = Path::new(fixture["root"].as_str().expect("root"));
        let home = Path::new(fixture["home"].as_str().expect("home"));
        let label = fixture["label"].as_str().expect("label");
        assert_eq!(service_label(root, home), label);
    }

    #[test]
    fn starts_in_the_graphical_session_with_an_aqua_autostart() {
        let (root, host, label) = hosting("aqua", true);
        let mut service = launchd(&host, &root, &label);
        service.start().expect("the start");
        assert_eq!(
            service.observe().expect("observe"),
            Observed {
                loaded: true,
                pid: 72,
                matches_desired_placement: true,
            }
        );
        let body = fs::read_to_string(host.file()).expect("the definition");
        assert!(body.contains("<key>LimitLoadToSessionType</key><string>Aqua</string>"));
        assert!(body.contains("<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>"));
        assert_eq!(
            host.mutations(),
            vec![
                format!("bootstrap {} {}", host.gui(), host.file().display()),
                format!("kickstart {}/{label}", host.gui()),
            ]
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn uses_the_background_autostart_when_no_graphical_session_exists() {
        let (root, host, label) = hosting("background", false);
        let mut service = launchd(&host, &root, &label);
        service.start().expect("the start");
        assert_eq!(service.observe().expect("observe").pid, 72);
        let body = fs::read_to_string(host.file()).expect("the definition");
        assert!(body.contains("<key>LimitLoadToSessionType</key><string>Background</string>"));
        assert_eq!(
            host.mutations(),
            vec![
                format!("bootstrap {} {}", host.user(), host.file().display()),
                format!("kickstart {}/{label}", host.user()),
            ]
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_loaded_job_is_not_started_over_and_nothing_moves() {
        let (root, host, label) = hosting("loaded", false);
        launchd(&host, &root, &label)
            .start()
            .expect("the first start");
        host.seed(71);
        *host.gui.lock().expect("gui") = true;
        let mut service = launchd(&host, &root, &label);
        let observed = service.observe().expect("observe");
        assert!(observed.loaded);
        assert!(!observed.matches_desired_placement);
        host.clear();
        assert!(service.start().is_err(), "starting over a running job");
        assert_eq!(host.mutations(), Vec::<String>::new());
        assert!(
            fs::read_to_string(host.file())
                .expect("the body")
                .contains("Background")
        );
        service.stop().expect("the stop");
        assert_eq!(host.jobs(), 0);
        assert_eq!(
            host.mutations(),
            vec![format!("bootout {}/{label}", host.user())]
        );
        host.clear();
        service.start().expect("the restart");
        assert!(host.has(&host.gui()));
        assert!(!host.has(&host.user()));
        assert_eq!(
            host.mutations(),
            vec![
                format!("bootstrap {} {}", host.gui(), host.file().display()),
                format!("kickstart {}/{label}", host.gui()),
            ]
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn falls_back_to_user_when_the_graphical_session_goes_and_replaces_an_unloaded_aqua_body() {
        let (root, host, label) = hosting("fallback", true);
        let mut first = launchd(&host, &root, &label);
        first.start().expect("the first start");
        *host.gui.lock().expect("gui") = false;
        host.jobs.lock().expect("jobs").clear();
        host.clear();
        let mut next = launchd(&host, &root, &label);
        assert!(!next.observe().expect("observe").loaded);
        next.start().expect("the fallback start");
        assert!(host.has(&host.user()));
        assert!(
            fs::read_to_string(host.file())
                .expect("the body")
                .contains("<string>Background</string>")
        );
        assert_eq!(
            host.mutations(),
            vec![
                format!("bootstrap {} {}", host.user(), host.file().display()),
                format!("kickstart {}/{label}", host.user()),
            ]
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn keeps_a_graphical_job_that_appears_after_user_was_selected() {
        let (root, host, label) = hosting("late-gui", true);
        let mut first = launchd(&host, &root, &label);
        first.start().expect("the first start");
        first.observe().expect("observe");
        first.stop().expect("the stop");
        *host.gui.lock().expect("gui") = false;
        let mut next = launchd(&host, &root, &label);
        // A login returns after selection, and RunAtLoad starts the old job.
        *host.gui.lock().expect("gui") = true;
        let job = host.own_job(73);
        host.jobs.lock().expect("jobs").insert(host.gui(), job);
        host.clear();
        next.reconcile().expect("the repair");
        assert_eq!(
            next.observe().expect("observe"),
            Observed {
                loaded: true,
                pid: 73,
                matches_desired_placement: true,
            }
        );
        assert!(host.has(&host.gui()));
        assert!(!host.has(&host.user()));
        assert_eq!(host.mutations(), Vec::<String>::new());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn activation_never_changes_its_selected_session() {
        let (root, host, label) = hosting("activation", true);
        let mut service = launchd(&host, &root, &label);
        *host.gui.lock().expect("gui") = false;
        assert!(service.start().is_err(), "the session is gone");
        assert_eq!(host.jobs(), 0);
        assert_eq!(
            host.mutations(),
            vec![format!(
                "bootstrap {} {}",
                host.gui(),
                host.file().display()
            )]
        );
        service.remove_definition().expect("the cleanup");
        assert!(!host.file().exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn repairs_a_login_that_lands_after_the_last_session_scan() {
        let (root, host, label) = hosting("late-login", true);
        let mut first = launchd(&host, &root, &label);
        first.start().expect("the first start");
        first.observe().expect("observe");
        first.stop().expect("the stop");
        *host.gui.lock().expect("gui") = false;
        let mut next = launchd(&host, &root, &label);
        next.observe().expect("observe");
        host.clear();
        *host.inject_login.lock().expect("login") = true;
        next.start().expect("the start repairs the login");
        assert!(!*host.inject_login.lock().expect("login"));
        assert_eq!(host.jobs(), 1);
        assert!(host.has(&host.gui()));
        assert!(!host.has(&host.user()));
        assert_eq!(next.observe().expect("observe").pid, 73);
        assert!(
            fs::read_to_string(host.file())
                .expect("the body")
                .contains("<string>Aqua</string>")
        );
        assert!(
            host.mutations()
                .contains(&format!("bootout {}/{label}", host.user()))
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn an_unexpected_session_probe_failure_is_not_read_as_no_session() {
        let (root, host, label) = hosting("probe", true);
        *host.failure.lock().expect("failure") = Some("print".to_string());
        assert!(Launchd::new(&root, &root.join("home"), &label, Box::new(host.clone())).is_err());
        assert_eq!(host.mutations(), Vec::<String>::new());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_loaded_job_that_is_not_ours_is_refused_and_left_alone() {
        let (root, host, label) = hosting("foreign", false);
        host.seed(71);
        *host.gui.lock().expect("gui") = true;
        let mut service = launchd(&host, &root, &label);
        for field in ["path", "program", "args", "home"] {
            {
                let mut jobs = host.jobs.lock().expect("jobs");
                let job = jobs.get_mut(&host.user()).expect("the job");
                match field {
                    "args" => job.args = vec![job.program.clone(), "/foreign/core.cjs".to_string()],
                    "path" => job.path = "/foreign".to_string(),
                    "program" => job.program = "/foreign".to_string(),
                    _ => job.home = "/foreign".to_string(),
                }
            }
            host.clear();
            assert!(service.observe().is_err(), "{field}");
            assert!(service.start().is_err(), "{field}");
            assert!(service.remove_definition().is_err(), "{field}");
            assert_eq!(host.mutations(), Vec::<String>::new(), "{field}");
            assert_eq!(host.jobs(), 1, "{field}");
        }
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_running_job_with_no_owned_definition_is_refused() {
        let (root, host, label) = hosting("no-definition", true);
        let mut service = launchd(&host, &root, &label);
        service.start().expect("the start");
        fs::remove_file(host.file()).expect("the definition goes");
        host.clear();
        assert!(service.observe().is_err());
        assert_eq!(host.mutations(), Vec::<String>::new());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_foreign_definition_is_refused_and_not_modified() {
        let (root, host, label) = hosting("foreign-definition", true);
        let mut service = launchd(&host, &root, &label);
        service.start().expect("the start");
        fs::write(host.file(), "foreign").expect("a foreign body");
        host.clear();
        assert!(service.observe().is_err());
        assert_eq!(
            fs::read_to_string(host.file()).expect("the body"),
            "foreign"
        );
        assert_eq!(host.mutations(), Vec::<String>::new());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn two_owned_jobs_are_repaired_by_stopping_the_fallback() {
        let (root, host, label) = hosting("pair", true);
        let mut service = launchd(&host, &root, &label);
        service.start().expect("the start");
        let job = host.own_job(71);
        host.jobs.lock().expect("jobs").insert(host.user(), job);
        host.clear();
        service.reconcile().expect("the repair");
        assert_eq!(
            service.observe().expect("observe"),
            Observed {
                loaded: true,
                pid: 72,
                matches_desired_placement: true,
            }
        );
        assert_eq!(
            host.mutations(),
            vec![format!("bootout {}/{label}", host.user())]
        );
        assert_eq!(host.jobs(), 1);
        assert!(host.has(&host.gui()));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_foreign_job_in_an_owned_pair_is_refused() {
        for foreign in ["user", "gui"] {
            let (root, host, label) = hosting("foreign-pair", true);
            let mut service = launchd(&host, &root, &label);
            service.start().expect("the start");
            let job = host.own_job(71);
            host.jobs.lock().expect("jobs").insert(host.user(), job);
            let domain = if foreign == "user" {
                host.user()
            } else {
                host.gui()
            };
            host.jobs
                .lock()
                .expect("jobs")
                .get_mut(&domain)
                .expect("the job")
                .args = vec!["/foreign".to_string()];
            let before = fs::read_to_string(host.file()).expect("the body");
            host.clear();
            assert!(service.reconcile().is_err(), "{foreign}");
            assert_eq!(host.mutations(), Vec::<String>::new(), "{foreign}");
            assert_eq!(host.jobs(), 2, "{foreign}");
            assert_eq!(fs::read_to_string(host.file()).expect("the body"), before);
            let _ = fs::remove_dir_all(&root);
        }
    }

    #[test]
    fn an_uncertain_fallback_stop_keeps_both_jobs_and_the_repair_waits() {
        let (root, host, label) = hosting("pair-stuck", true);
        let mut service = launchd(&host, &root, &label);
        service.start().expect("the start");
        let job = host.own_job(71);
        host.jobs.lock().expect("jobs").insert(host.user(), job);
        *host.failure.lock().expect("failure") = Some("bootout".to_string());
        assert!(service.reconcile().is_err());
        assert_eq!(host.jobs(), 2);
        *host.failure.lock().expect("failure") = None;
        service.reconcile().expect("the repair");
        assert_eq!(host.jobs(), 1);
        assert!(host.has(&host.gui()));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_late_login_pair_is_repaired_before_uninstall() {
        let (root, host, label) = hosting("late-pair", false);
        let mut service = launchd(&host, &root, &label);
        service.start().expect("the start");
        *host.gui.lock().expect("gui") = true;
        let job = host.own_job(73);
        host.jobs.lock().expect("jobs").insert(host.gui(), job);
        host.clear();
        service.reconcile().expect("the repair");
        service.observe().expect("observe");
        service.stop().expect("the stop");
        service.remove_definition().expect("the removal");
        assert_eq!(host.jobs(), 0);
        assert_eq!(
            host.mutations(),
            vec![
                format!("bootout {}/{label}", host.user()),
                format!("bootout {}/{label}", host.gui()),
            ]
        );
        assert!(!host.file().exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_login_after_a_fallback_incumbent_was_admitted_quiesces_both() {
        let (root, host, label) = hosting("login-after-admission", false);
        let mut service = launchd(&host, &root, &label);
        service.start().expect("the start");
        service.observe().expect("the incumbent is admitted");
        *host.gui.lock().expect("gui") = true;
        let job = host.own_job(73);
        host.jobs.lock().expect("jobs").insert(host.gui(), job);
        host.clear();
        service.stop().expect("the stop");
        assert_eq!(host.jobs(), 0);
        assert_eq!(
            host.mutations(),
            vec![
                format!("bootout {}/{label}", host.user()),
                format!("bootout {}/{label}", host.gui()),
            ]
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_replacement_job_after_admission_is_not_stopped() {
        let (root, host, label) = hosting("replacement", true);
        let mut service = launchd(&host, &root, &label);
        service.start().expect("the start");
        service.observe().expect("admitted");
        let job = host.own_job(99);
        host.jobs.lock().expect("jobs").insert(host.gui(), job);
        host.clear();
        assert!(
            service.stop().is_err(),
            "a replacement is not the admitted job"
        );
        assert_eq!(host.mutations(), Vec::<String>::new());
        assert_eq!(
            host.jobs
                .lock()
                .expect("jobs")
                .get(&host.gui())
                .expect("the job")
                .pid,
            99
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_definition_is_not_removed_while_its_job_is_loaded() {
        let (root, host, label) = hosting("loaded-removal", true);
        let mut service = launchd(&host, &root, &label);
        service.start().expect("the start");
        host.clear();
        assert!(service.remove_definition().is_err());
        assert_eq!(host.mutations(), Vec::<String>::new());
        assert!(
            fs::read_to_string(host.file())
                .expect("the body")
                .contains(&label)
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn either_placement_uninstalls_and_the_second_uninstall_asks_for_nothing() {
        for graphical in [true, false] {
            let (root, host, label) = hosting("uninstall", graphical);
            let mut service = launchd(&host, &root, &label);
            service.start().expect("the start");
            *host.gui.lock().expect("gui") = true;
            host.clear();
            let mut next = launchd(&host, &root, &label);
            next.observe().expect("observe");
            next.stop().expect("the stop");
            next.remove_definition().expect("the removal");
            assert_eq!(host.jobs(), 0);
            assert!(!host.file().exists());
            let domain = if graphical { host.gui() } else { host.user() };
            assert_eq!(
                host.mutations(),
                vec![format!("bootout {domain}/{label}")],
                "graphical={graphical}"
            );
            host.clear();
            let mut again = launchd(&host, &root, &label);
            again.observe().expect("observe");
            again.stop().expect("the stop");
            again.remove_definition().expect("the removal");
            assert_eq!(host.mutations(), Vec::<String>::new());
            let _ = fs::remove_dir_all(&root);
        }
    }

    #[test]
    fn a_failed_bootstrap_leaves_only_its_owned_candidate_to_clean() {
        for op in ["bootstrap", "kickstart"] {
            let (root, host, label) = hosting("failed-start", true);
            *host.failure.lock().expect("failure") = Some(op.to_string());
            let mut service = launchd(&host, &root, &label);
            assert!(service.start().is_err(), "{op}");
            *host.failure.lock().expect("failure") = None;
            if service.observe().expect("observe").loaded {
                service.stop().expect("the stop");
            }
            service.remove_definition().expect("the removal");
            assert_eq!(host.jobs(), 0);
            assert!(!host.file().exists());
            assert!(
                !host
                    .mutations()
                    .iter()
                    .any(|call| call.contains(&format!("user/{}/", uid()))),
                "{op}: nothing touched the fallback session"
            );
            let _ = fs::remove_dir_all(&root);
        }
    }

    #[test]
    fn an_uncertain_stop_retains_the_old_definition_and_blocks_the_start() {
        let (root, host, label) = hosting("stop-fails", false);
        let mut service = launchd(&host, &root, &label);
        service.start().expect("the start");
        let previous = fs::read_to_string(host.file()).expect("the body");
        *host.gui.lock().expect("gui") = true;
        let mut next = launchd(&host, &root, &label);
        next.observe().expect("observe");
        *host.failure.lock().expect("failure") = Some("bootout".to_string());
        assert!(next.stop().is_err());
        assert!(next.start().is_err(), "a loaded job is not started over");
        assert_eq!(fs::read_to_string(host.file()).expect("the body"), previous);
        assert!(host.has(&host.user()));
        let _ = fs::remove_dir_all(&root);
    }

    // --- systemd ---

    #[derive(Clone)]
    struct Managed {
        file: PathBuf,
        node: String,
        entry: String,
        pid: Arc<ArcMutex<u32>>,
        linger: Arc<ArcMutex<&'static str>>,
        calls: Arc<ArcMutex<Vec<String>>>,
    }

    impl Managed {
        fn new(root: &Path, file: PathBuf) -> Managed {
            Managed {
                file,
                node: root.join("current/bin/node").to_string_lossy().into_owned(),
                entry: root
                    .join("current/core/junto.cjs")
                    .to_string_lossy()
                    .into_owned(),
                pid: Arc::new(ArcMutex::new(0)),
                linger: Arc::new(ArcMutex::new("no")),
                calls: Arc::new(ArcMutex::new(Vec::new())),
            }
        }

        fn clear(&self) {
            self.calls.lock().expect("calls").clear();
        }

        fn calls(&self) -> Vec<String> {
            self.calls.lock().expect("calls").clone()
        }
    }

    impl Runner for Managed {
        fn run(&self, program: &str, args: &[&str]) -> Result<String, RunFailed> {
            self.calls
                .lock()
                .expect("calls")
                .push(format!("{} {}", program, args.join(" ")));
            if program == "/usr/bin/loginctl" {
                let mode = *self.linger.lock().expect("linger");
                if mode == "fail" {
                    return Err(RunFailed {
                        exit: Some(1),
                        message: "loginctl unavailable".to_string(),
                    });
                }
                return match args[0] {
                    "enable-linger" => {
                        *self.linger.lock().expect("linger") = "yes";
                        Ok(String::new())
                    }
                    "show-user" => Ok(format!(
                        "Linger={}\n",
                        if mode == "yes" { "yes" } else { "no" }
                    )),
                    other => panic!("unexpected loginctl {other}"),
                };
            }
            assert_eq!(program, "/usr/bin/systemctl");
            match args[1] {
                "show" => {
                    if !self.file.exists() {
                        return Ok("LoadState=not-found\nMainPID=0\n".to_string());
                    }
                    Ok(format!(
                        "LoadState=loaded\nMainPID={}\nFragmentPath={}\nExecStart={{ path={} ; argv[]={} }}\n",
                        *self.pid.lock().expect("pid"),
                        self.file.display(),
                        self.node,
                        self.entry
                    ))
                }
                "daemon-reload" | "enable" | "disable" => Ok(String::new()),
                "start" => {
                    if !self.file.exists() {
                        return Err(RunFailed {
                            exit: Some(5),
                            message: "Unit file not found".to_string(),
                        });
                    }
                    *self.pid.lock().expect("pid") = 71;
                    Ok(String::new())
                }
                "stop" => {
                    *self.pid.lock().expect("pid") = 0;
                    Ok(String::new())
                }
                other => panic!("unexpected systemctl {other}"),
            }
        }
    }

    fn managed(name: &str) -> (PathBuf, Managed, String) {
        let root = paths::home().join(format!(".junto-systemd-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("a root");
        let label = "dev.junto.machine.0123456789abcdef".to_string();
        let file = root.join(format!("{label}.service"));
        let managed = Managed::new(&root.join("machine"), file);
        (root, managed, label)
    }

    fn systemd(host: &Managed, root: &Path, label: &str) -> Systemd {
        Systemd::at(
            &root.join("machine"),
            &root.join("home"),
            label,
            host.file.clone(),
            Box::new(host.clone()),
        )
    }

    #[test]
    fn a_unit_that_never_hits_the_start_limit_restarts_slowly_and_starts_once() {
        let (root, host, label) = managed("start");
        let mut service = systemd(&host, &root, &label);
        service.start().expect("the start");
        let body = fs::read_to_string(&host.file).expect("the unit");
        assert!(body.contains("StartLimitIntervalSec=0"));
        assert!(body.contains("Restart=on-failure\nRestartSec=10\n"));
        assert!(!body.contains("RestartSec=2"));
        assert_eq!(
            host.calls(),
            vec![
                "/usr/bin/systemctl --user daemon-reload".to_string(),
                format!("/usr/bin/systemctl --user enable {label}.service"),
                format!("/usr/bin/systemctl --user start {label}.service"),
            ]
        );
        assert_eq!(
            service.observe().expect("observe"),
            Observed {
                loaded: true,
                pid: 71,
                matches_desired_placement: true,
            }
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_legacy_unit_is_admitted_and_rewritten_on_start() {
        let (root, host, label) = managed("legacy");
        let mut service = systemd(&host, &root, &label);
        let (_, legacy) = systemd_bodies(&root.join("machine"), &root.join("home"));
        fs::create_dir_all(host.file.parent().expect("the directory")).expect("a directory");
        fs::write(&host.file, &legacy).expect("the legacy unit");
        fs::set_permissions(&host.file, fs::Permissions::from_mode(0o600)).expect("private");
        host.clear();
        service.start().expect("the start");
        let body = fs::read_to_string(&host.file).expect("the unit");
        assert!(body.contains("StartLimitIntervalSec=0"));
        assert!(body.contains("RestartSec=10"));
        assert!(
            host.calls()
                .contains(&format!("/usr/bin/systemctl --user start {label}.service"))
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_legacy_unit_is_removed_without_being_rewritten() {
        let (root, host, label) = managed("legacy-removal");
        let mut service = systemd(&host, &root, &label);
        let (_, legacy) = systemd_bodies(&root.join("machine"), &root.join("home"));
        fs::create_dir_all(host.file.parent().expect("the directory")).expect("a directory");
        fs::write(&host.file, &legacy).expect("the legacy unit");
        fs::set_permissions(&host.file, fs::Permissions::from_mode(0o600)).expect("private");
        host.clear();
        service.remove_definition().expect("the removal");
        assert!(!host.file.exists());
        assert_eq!(
            host.calls(),
            vec![
                format!("/usr/bin/systemctl --user disable {label}.service"),
                "/usr/bin/systemctl --user daemon-reload".to_string(),
            ]
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn linger_is_enabled_once_and_never_reported_when_it_takes() {
        let (root, host, label) = managed("linger");
        let mut service = systemd(&host, &root, &label);
        assert_eq!(
            service.reconcile().expect("first"),
            Vec::<&'static str>::new()
        );
        assert_eq!(
            service.reconcile().expect("second"),
            Vec::<&'static str>::new()
        );
        assert_eq!(
            host.calls()
                .iter()
                .filter(|call| call.starts_with("/usr/bin/loginctl"))
                .cloned()
                .collect::<Vec<_>>(),
            vec![
                format!("/usr/bin/loginctl show-user {} -p Linger", uid()),
                format!("/usr/bin/loginctl enable-linger {}", uid()),
                format!("/usr/bin/loginctl show-user {} -p Linger", uid()),
            ]
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_manager_that_already_lingers_is_not_asked_again() {
        let (root, host, label) = managed("linger-yes");
        *host.linger.lock().expect("linger") = "yes";
        let mut service = systemd(&host, &root, &label);
        assert_eq!(
            service.reconcile().expect("the reconcile"),
            Vec::<&'static str>::new()
        );
        assert!(
            !host
                .calls()
                .iter()
                .any(|call| call.contains("enable-linger"))
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_machine_without_linger_reports_the_notice_and_still_starts() {
        let (root, host, label) = managed("linger-fail");
        *host.linger.lock().expect("linger") = "fail";
        let mut service = systemd(&host, &root, &label);
        assert_eq!(
            service.reconcile().expect("the reconcile"),
            vec![LINGER_NOT_ENABLED]
        );
        service.start().expect("the start");
        assert_eq!(service.observe().expect("observe").pid, 71);
        let _ = fs::remove_dir_all(&root);
    }
}
