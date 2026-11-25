//! The service an install owns, as src/cli/hosts/install-service.ts writes and
//! reads it: one launchd job on macOS (Aqua, or Background when no graphical
//! domain answers) or one systemd user unit on Linux, its exact bytes, its exact
//! loaded paths and home, and nothing else ever acted on. The bytes are the seam
//! tests/fixtures/link-service-bodies.json holds, so a link's start and an
//! install's writer agree.

use std::fs;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

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
        return Err(Refused::new(
            "The machine service label is not one Junto minted",
        ));
    };
    if rest.len() != 16
        || !rest
            .chars()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&(c as u8)))
    {
        return Err(Refused::new(
            "The machine service label is not one Junto minted",
        ));
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
    Err(Refused::new("machine services support macOS and Linux"))
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
        let file = home()
            .join("Library/LaunchAgents")
            .join(format!("{label}.plist"));
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
            return Err(Refused::new(
                "existing service definition belongs to a different install",
            ));
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
                return Err(Refused::new(
                    "loaded service does not belong to this install",
                ));
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
            return Err(Refused::new(
                "service changed after admission; stopping refused",
            ));
        }
        let target = format!("{}/{}", job.domain, self.label);
        self.runner
            .run("/bin/launchctl", &["bootout", &target])
            .map(|_| ())
            .map_err(|failure| Refused::new(failure.message))
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
        let jobs = self.snapshot()?;
        if !jobs.iter().any(|job| job.domain == self.gui) {
            return Ok(Vec::new());
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
            return Err(Refused::new(
                "service changed after admission; stopping refused",
            ));
        }
        for job in jobs {
            self.quiesce_job(&job)?;
        }
        Ok(())
    }

    fn start(&mut self) -> Result<(), Refused> {
        if !self.snapshot()?.is_empty() {
            self.reconcile()?;
            return Err(Refused::new(
                "Junto service must be quiescent before starting",
            ));
        }
        let previous = self.definition()?;
        if let Some(previous) = previous.filter(|held| held != &self.desired) {
            remove_machine_service_file(&self.file, &previous)?;
        }
        write_machine_service_file(&self.file, &self.desired)?;
        let file = self.file.to_string_lossy().into_owned();
        self.runner
            .run("/bin/launchctl", &["bootstrap", &self.domain, &file])
            .map_err(|failure| Refused::new(failure.message))?;
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
            ));
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
        let (body, legacy) = systemd_bodies(root, junto_home);
        let file = home()
            .join(".config/systemd/user")
            .join(format!("{label}.service"));
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
            return Err(Refused::new(
                "existing service definition belongs to a different install",
            ));
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
            return Err(Refused::new(
                "loaded service does not belong to this install",
            ));
        }
        let digits = !pid_text.is_empty()
            && pid_text.chars().next().is_some_and(|c| c.is_ascii_digit())
            && !pid_text.starts_with('0')
            && pid_text.chars().all(|c| c.is_ascii_digit());
        if !digits && pid_text != "0" {
            return Err(Refused::new("service returned an invalid process id"));
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
}
