//! One service start behind `junto link` (link.rs). The link key is a forced
//! command that fixes JUNTO_HOME and the binary; the install wrote the service
//! definition and owns the install lock. This module starts that definition
//! exactly as the install wrote it, and never writes or recreates it.
//!
//! One invocation runs at most `launchctl bootstrap` then `launchctl
//! kickstart` for the checked label (bootstrap alone refuses a job that is
//! loaded but not running), or one `systemctl --user start`. Then the socket
//! is polled for [`CONNECT_BOUND`]. The install lease is held from before the
//! definition is read until a core connects, so an install sent in that
//! window refuses rather than swapping the definition mid-start.
//!
//! Refusals are two: the install lock is held (machine updating), or this
//! binary is not inside an owned install whose definition is the exact one the
//! install writes (core not running). No path, label or owner content crosses
//! to the far end.

use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use rustix::fs::{FlockOperation, OFlags, flock};
use rustix::process::getuid;
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::envelope;

use super::STARTING;

/// The service manager's own start may take this long before it is abandoned.
const START_BOUND: Duration = Duration::from_secs(5);
/// After the one start, the core may take this long to answer on its socket.
const CONNECT_BOUND: Duration = Duration::from_secs(8);
const CONNECT_POLL: Duration = Duration::from_millis(100);
/// The only two ways a start is refused. Neither is a relay failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Refusal {
    /// An install or update holds the install lease: start nothing.
    Updating,
    /// No owned definition to start, or the one start did not bring a core up.
    NotRunning,
}

/// Runs one service manager invocation. Tests pass a double; production uses
/// the absolute paths and one attempt in [`SystemRunner`].
trait Runner {
    fn run(&self, program: &Path, args: &[OsString]) -> io::Result<ExitStatus>;
}

/// The production runner: no shell, a closed stderr, and a bound on one start.
struct SystemRunner;

impl Runner for SystemRunner {
    fn run(&self, program: &Path, args: &[OsString]) -> io::Result<ExitStatus> {
        let mut child = Command::new(program)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()?;
        let deadline = Instant::now() + START_BOUND;
        loop {
            if let Some(status) = child.try_wait()? {
                return Ok(status);
            }
            if Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "service start did not finish",
                ));
            }
            thread::sleep(Duration::from_millis(25));
        }
    }
}

/// One service-manager command, built only from the checked label and
/// definition.
#[derive(Debug, PartialEq, Eq)]
struct Step {
    program: &'static str,
    args: Vec<OsString>,
}

/// What the one start attempt runs: a bootstrap that refuses an already
/// loaded job, then the kickstart the install also runs, on that refusal only.
#[derive(Debug, PartialEq, Eq)]
struct Plan {
    first: Step,
    retry: Option<Step>,
}

impl Plan {
    fn start(&self, runner: &impl Runner) -> io::Result<()> {
        let status = runner.run(Path::new(self.first.program), &self.first.args)?;
        if !status.success()
            && let Some(retry) = &self.retry
        {
            runner.run(Path::new(retry.program), &retry.args)?;
        }
        Ok(())
    }
}

fn launchd_plan(label: &str, file: &Path, graphical: bool) -> Plan {
    let domain = if graphical { "gui" } else { "user" };
    let target = format!("{domain}/{}", getuid().as_raw());
    Plan {
        first: Step {
            program: "/bin/launchctl",
            args: vec![
                OsString::from("bootstrap"),
                OsString::from(&target),
                file.as_os_str().to_owned(),
            ],
        },
        // install-service.ts runs bootstrap then kickstart; bootstrap alone
        // refuses a job that is loaded but not running.
        retry: Some(Step {
            program: "/bin/launchctl",
            args: vec![
                OsString::from("kickstart"),
                OsString::from(format!("{target}/{label}")),
            ],
        }),
    }
}

fn systemd_plan(label: &str) -> Plan {
    Plan {
        first: Step {
            program: "/usr/bin/systemctl",
            args: vec![
                OsString::from("--user"),
                OsString::from("start"),
                OsString::from(format!("{label}.service")),
            ],
        },
        retry: None,
    }
}

/// This machine's installed layout rooted at `root`: the owner marker and the
/// label both name `home`, the JUNTO_HOME the link key fixed.
struct Install {
    root: PathBuf,
    home: PathBuf,
    account_home: PathBuf,
    label: String,
}

impl Install {
    fn new(root: PathBuf, home: PathBuf, account_home: PathBuf) -> Result<Self, Refusal> {
        owned_directory(&root)?;
        root.to_str().ok_or(Refusal::NotRunning)?;
        let home_text = home.to_str().ok_or(Refusal::NotRunning)?;
        let label = service_label(&root, &home);
        let marker = root.join("owner.json");
        if read_owned(&marker, 0o022)? != owner_json(&label, home_text) {
            return Err(Refusal::NotRunning);
        }
        Ok(Self {
            root,
            home,
            account_home,
            label,
        })
    }

    /// The install lease, taken non-blocking and held through the start.
    fn lease(&self) -> Result<File, Refusal> {
        owned_directory(&self.root.join(".install-lock"))?;
        let path = self.root.join(".install-lock/lease");
        let file = open_owned(&path, true)?;
        let metadata = file.metadata().map_err(|_| Refusal::NotRunning)?;
        if !metadata.is_file()
            || metadata.uid() != uid()
            || metadata.nlink() != 1
            || metadata.mode() & 0o077 != 0
        {
            return Err(Refusal::NotRunning);
        }
        match flock(&file, FlockOperation::NonBlockingLockExclusive) {
            Ok(()) => Ok(file),
            Err(rustix::io::Errno::WOULDBLOCK) => Err(Refusal::Updating),
            Err(_) => Err(Refusal::NotRunning),
        }
    }

    fn definition(&self) -> PathBuf {
        if cfg!(target_os = "macos") {
            self.account_home
                .join("Library/LaunchAgents")
                .join(format!("{}.plist", self.label))
        } else {
            self.account_home
                .join(".config/systemd/user")
                .join(format!("{}.service", self.label))
        }
    }

    /// The definition the install wrote, read at its fixed path and accepted
    /// only as its exact current or legacy bytes.
    fn read_definition(&self) -> Result<Plan, Refusal> {
        let path = self.definition();
        let body = read_owned(&path, 0o022)?;
        if cfg!(target_os = "macos") {
            let (background, aqua) = launchd_bodies(&self.root, &self.home, &self.label);
            if body == aqua {
                return Ok(launchd_plan(&self.label, &path, true));
            }
            if body == background {
                return Ok(launchd_plan(&self.label, &path, false));
            }
            return Err(Refusal::NotRunning);
        }
        let (current, legacy) = systemd_bodies(&self.root, &self.home);
        if body == current || body == legacy {
            Ok(systemd_plan(&self.label))
        } else {
            Err(Refusal::NotRunning)
        }
    }
}

/// One start attempt, then the core may answer for [`CONNECT_BOUND`]. The
/// lease is held from before the definition is read until a core connects.
pub(super) fn start_and_connect(home: &Path, socket: &Path) -> Result<UnixStream, Refusal> {
    let exe = std::env::current_exe().map_err(|_| Refusal::NotRunning)?;
    let root = install_root(&exe).ok_or(Refusal::NotRunning)?;
    let account_home = std::env::home_dir().ok_or(Refusal::NotRunning)?;
    let install = Install::new(root, home.to_path_buf(), account_home)?;
    let _lease = install.lease()?;
    let plan = install.read_definition()?;
    envelope::warn(STARTING);
    // One attempt, whatever it says: the socket poll is the only wait.
    let _ = plan.start(&SystemRunner);
    connect_within(socket, CONNECT_BOUND).ok_or(Refusal::NotRunning)
}

fn connect_within(path: &Path, bound: Duration) -> Option<UnixStream> {
    let deadline = Instant::now() + bound;
    loop {
        if let Ok(socket) = UnixStream::connect(path) {
            return Some(socket);
        }
        let now = Instant::now();
        if now >= deadline {
            return None;
        }
        thread::sleep(CONNECT_POLL.min(deadline - now));
    }
}

fn uid() -> u32 {
    getuid().as_raw()
}

/// A canonical executable inside an install root: `<root>/current/bin/junto`
/// or `<root>/builds/<64hex>-<target>/bin/junto`. Nothing else may start.
fn install_root(exe: &Path) -> Option<PathBuf> {
    strip_install_root(&exe.canonicalize().ok()?)
}

fn strip_install_root(exe: &Path) -> Option<PathBuf> {
    let text = exe.to_str()?;
    if let Some(root) = text.strip_suffix("/current/bin/junto") {
        return (!root.is_empty() && root.starts_with('/')).then(|| PathBuf::from(root));
    }
    let (root, rest) = text.rsplit_once("/builds/")?;
    let (generation, tail) = rest.split_once('/')?;
    if tail != "bin/junto" || !valid_generation(generation) {
        return None;
    }
    (!root.is_empty() && root.starts_with('/')).then(|| PathBuf::from(root))
}

fn valid_generation(generation: &str) -> bool {
    let Some((hash, target)) = generation.split_once('-') else {
        return false;
    };
    hash.len() == 64
        && hash.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
        && matches!(target, "darwin-arm64" | "linux-x64")
}

fn service_label(root: &Path, home: &Path) -> String {
    let mut digest = Sha256::new();
    digest.update(root.as_os_str().as_bytes());
    digest.update([0]);
    digest.update(home.as_os_str().as_bytes());
    let hex = format!("{:x}", digest.finalize());
    format!("dev.junto.machine.{}", &hex[..16])
}

#[derive(Serialize)]
struct Owner<'a> {
    #[serde(rename = "serviceLabel")]
    service_label: &'a str,
    #[serde(rename = "juntoHome")]
    junto_home: &'a str,
}

fn owner_json(label: &str, home: &str) -> String {
    serde_json::to_string(&Owner {
        service_label: label,
        junto_home: home,
    })
    .unwrap_or_default()
}

/// An owned real directory, never a link, that group and others cannot write.
fn owned_directory(path: &Path) -> Result<(), Refusal> {
    let metadata = fs::symlink_metadata(path).map_err(|_| Refusal::NotRunning)?;
    if !metadata.is_dir() || metadata.uid() != uid() || metadata.mode() & 0o022 != 0 {
        return Err(Refusal::NotRunning);
    }
    Ok(())
}

fn open_owned(path: &Path, write: bool) -> Result<File, Refusal> {
    OpenOptions::new()
        .read(true)
        .write(write)
        .custom_flags(OFlags::NOFOLLOW.bits() as i32)
        .open(path)
        .map_err(|_| Refusal::NotRunning)
}

/// A regular file of this user that others cannot write, read without
/// following a final link. Its contents may be anything.
fn read_owned(path: &Path, forbidden_mode: u32) -> Result<String, Refusal> {
    let mut file = open_owned(path, false)?;
    let metadata = file.metadata().map_err(|_| Refusal::NotRunning)?;
    if !metadata.is_file() || metadata.uid() != uid() || metadata.mode() & forbidden_mode != 0 {
        return Err(Refusal::NotRunning);
    }
    let mut text = String::new();
    file.read_to_string(&mut text)
        .map_err(|_| Refusal::NotRunning)?;
    Ok(text)
}

// --- the exact bytes the install writes (src/cli/hosts/install-service.ts) ---

fn xml(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&apos;"),
            other => escaped.push(other),
        }
    }
    escaped
}

fn unit(value: &str) -> String {
    let mut quoted = String::with_capacity(value.len() + 2);
    quoted.push('"');
    for character in value.chars() {
        match character {
            '%' => quoted.push_str("%%"),
            '\\' => quoted.push_str("\\\\"),
            '"' => quoted.push_str("\\\""),
            '\n' => quoted.push_str("\\n"),
            '\r' => quoted.push_str("\\r"),
            other => quoted.push(other),
        }
    }
    quoted.push('"');
    quoted
}

/// (Background, Aqua): the two exact launchd bodies the install writes.
fn launchd_bodies(root: &Path, home: &Path, label: &str) -> (String, String) {
    let node = root.join("current/bin/node");
    let entry = root.join("current/core/junto.cjs");
    let stdout = root.join("logs/stdout.log");
    let stderr = root.join("logs/stderr.log");
    let body = |session: &str| {
        format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\"><dict><key>Label</key><string>{label}</string><key>ProgramArguments</key><array><string>{}</string><string>{}</string></array><key>EnvironmentVariables</key><dict><key>JUNTO_HOME</key><string>{}</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ProcessType</key><string>Background</string><key>LimitLoadToSessionType</key><string>{session}</string><key>StandardOutPath</key><string>{}</string><key>StandardErrorPath</key><string>{}</string></dict></plist>\n",
            xml(&node.to_string_lossy()),
            xml(&entry.to_string_lossy()),
            xml(&home.to_string_lossy()),
            xml(&stdout.to_string_lossy()),
            xml(&stderr.to_string_lossy()),
        )
    };
    (body("Background"), body("Aqua"))
}

/// (current, legacy): the two exact systemd unit bodies the install writes.
fn systemd_bodies(root: &Path, home: &Path) -> (String, String) {
    let node = root.join("current/bin/node");
    let entry = root.join("current/core/junto.cjs");
    let body = |limits: &str, restart: u8| {
        format!(
            "[Unit]\nDescription=Junto\nAfter=network.target\n{limits}\n[Service]\nType=simple\nExecStart=:{} {}\nEnvironment={}\nRestart=on-failure\nRestartSec={restart}\nTimeoutStopSec=30\nUMask=0077\n\n[Install]\nWantedBy=default.target\n",
            unit(&node.to_string_lossy()),
            unit(&entry.to_string_lossy()),
            unit(&format!("JUNTO_HOME={}", home.to_string_lossy())),
        )
    };
    (body("StartLimitIntervalSec=0\n", 10), body("", 2))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::process::ExitStatusExt;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[derive(serde::Deserialize)]
    struct Fixture {
        root: String,
        home: String,
        label: String,
        launchd: Launchd,
        systemd: Systemd,
    }

    #[derive(serde::Deserialize)]
    struct Launchd {
        aqua: String,
        background: String,
    }

    #[derive(serde::Deserialize)]
    struct Systemd {
        current: String,
        legacy: String,
    }

    fn fixture() -> Fixture {
        serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../tests/fixtures/link-service-bodies.json"
        )))
        .expect("link service fixture")
    }

    struct Scratch(PathBuf);

    impl Scratch {
        fn new(name: &str) -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|elapsed| elapsed.as_nanos())
                .unwrap_or_default();
            let path = std::env::temp_dir()
                .join(format!("junto-link-{name}-{}-{nanos}", std::process::id()));
            fs::create_dir_all(&path).expect("scratch");
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn write(path: &Path, text: &str, mode: u32) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("parent");
        }
        let mut options = OpenOptions::new();
        options.write(true).create_new(true).mode(mode);
        use std::io::Write as _;
        options
            .open(path)
            .and_then(|mut file| file.write_all(text.as_bytes()))
            .expect("write");
    }

    fn install_root_layout(scratch: &Scratch) -> PathBuf {
        let root = scratch.path().join("machine");
        let generation = format!("{}-linux-x64", "b".repeat(64));
        let bin = root.join("builds").join(&generation).join("bin");
        fs::create_dir_all(&bin).expect("bin");
        write(&bin.join("junto"), "binary", 0o755);
        std::os::unix::fs::symlink(Path::new("builds").join(&generation), root.join("current"))
            .expect("current");
        root
    }

    fn owned_install(scratch: &Scratch) -> (Install, PathBuf) {
        let root = install_root_layout(scratch);
        let home = scratch.path().join("home");
        fs::create_dir_all(&home).expect("home");
        let label = service_label(&root, &home);
        write(
            &root.join("owner.json"),
            &owner_json(&label, home.to_str().expect("home")),
            0o600,
        );
        fs::create_dir_all(root.join(".install-lock")).expect("lock dir");
        fs::set_permissions(
            root.join(".install-lock"),
            fs::Permissions::from_mode(0o700),
        )
        .expect("lock mode");
        write(&root.join(".install-lock/lease"), "", 0o600);
        let install = Install::new(root, home, scratch.path().join("account")).expect("install");
        (install, scratch.path().join("account"))
    }

    #[test]
    fn strips_only_an_installed_executable_to_its_root() {
        let root = Path::new("/Users/example/.junto/machine");
        let generation = format!("{}-darwin-arm64", "a".repeat(64));
        assert_eq!(
            strip_install_root(&root.join("builds").join(&generation).join("bin/junto")),
            Some(root.to_path_buf())
        );
        assert_eq!(
            strip_install_root(&root.join("current/bin/junto")),
            Some(root.to_path_buf())
        );
        for foreign in [
            PathBuf::from("/usr/local/bin/junto"),
            root.join("builds/not-a-generation/bin/junto"),
            root.join("builds").join(&generation).join("bin/other"),
            root.join("current/bin/node"),
        ] {
            assert_eq!(strip_install_root(&foreign), None, "{foreign:?}");
        }
    }

    #[test]
    fn canonicalizes_an_executable_run_through_current() {
        let scratch = Scratch::new("canonical");
        let root = install_root_layout(&scratch);
        let canonical = fs::canonicalize(&root).expect("canonical root");
        assert_eq!(
            install_root(&root.join("current/bin/junto")),
            Some(canonical.clone())
        );
        assert_eq!(
            install_root(
                &root
                    .join("builds")
                    .join(format!("{}-linux-x64", "b".repeat(64)))
                    .join("bin/junto")
            ),
            Some(canonical)
        );
    }

    #[test]
    fn mints_the_same_label_as_the_install() {
        let fixture = fixture();
        assert_eq!(
            service_label(Path::new(&fixture.root), Path::new(&fixture.home)),
            fixture.label
        );
    }

    #[test]
    fn builds_the_exact_bodies_the_install_writes() {
        let fixture = fixture();
        let root = Path::new(&fixture.root);
        let home = Path::new(&fixture.home);
        let (background, aqua) = launchd_bodies(root, home, &fixture.label);
        assert_eq!(background, fixture.launchd.background);
        assert_eq!(aqua, fixture.launchd.aqua);
        let (current, legacy) = systemd_bodies(root, home);
        assert_eq!(current, fixture.systemd.current);
        assert_eq!(legacy, fixture.systemd.legacy);
    }

    #[test]
    fn takes_the_owner_marker_and_refuses_a_foreign_one() {
        let scratch = Scratch::new("owner");
        let (install, _) = owned_install(&scratch);
        assert_eq!(install.label, service_label(&install.root, &install.home));

        fs::remove_file(install.root.join("owner.json")).expect("remove owner");
        write(&install.root.join("owner.json"), "other", 0o600);
        assert_eq!(
            Install::new(
                install.root.clone(),
                install.home.clone(),
                scratch.path().join("account")
            )
            .err(),
            Some(Refusal::NotRunning)
        );
    }

    #[test]
    fn refuses_a_planted_owner_marker() {
        let scratch = Scratch::new("owner-planted");
        let (install, _) = owned_install(&scratch);
        let marker = install.root.join("owner.json");
        fs::remove_file(&marker).expect("remove");
        let outside = scratch.path().join("outside.json");
        write(
            &outside,
            &owner_json(&install.label, install.home.to_str().expect("home")),
            0o600,
        );
        std::os::unix::fs::symlink(&outside, &marker).expect("symlink");
        assert_eq!(
            Install::new(
                install.root.clone(),
                install.home.clone(),
                scratch.path().join("account")
            )
            .err(),
            Some(Refusal::NotRunning)
        );
    }

    #[test]
    fn the_install_lease_is_held_or_free() {
        let scratch = Scratch::new("lease");
        let (install, _) = owned_install(&scratch);
        let held = install.lease().expect("free lease");
        assert_eq!(install.lease().err(), Some(Refusal::Updating));
        drop(held);
        assert!(install.lease().is_ok());
    }

    #[test]
    fn an_unknown_or_unsafe_lease_refuses_without_starting() {
        let scratch = Scratch::new("lease-unsafe");
        let (install, _) = owned_install(&scratch);
        fs::remove_file(install.root.join(".install-lock/lease")).expect("remove");
        assert_eq!(install.lease().err(), Some(Refusal::NotRunning), "missing");

        write(&install.root.join(".install-lock/lease"), "", 0o644);
        assert_eq!(
            install.lease().err(),
            Some(Refusal::NotRunning),
            "group readable"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn reads_only_the_exact_linux_definition_at_its_fixed_path() {
        let scratch = Scratch::new("definition");
        let (install, account) = owned_install(&scratch);
        let path = install.definition();
        assert_eq!(
            path,
            account
                .join(".config/systemd/user")
                .join(format!("{}.service", install.label))
        );
        assert_eq!(install.read_definition().err(), Some(Refusal::NotRunning));

        let (current, legacy) = systemd_bodies(&install.root, &install.home);
        write(&path, &legacy, 0o600);
        assert_eq!(
            install.read_definition().ok(),
            Some(systemd_plan(&install.label))
        );

        fs::remove_file(&path).expect("remove legacy");
        write(&path, &current, 0o600);
        assert_eq!(
            install.read_definition().ok(),
            Some(systemd_plan(&install.label))
        );

        fs::remove_file(&path).expect("remove current");
        write(&path, "foreign", 0o600);
        assert_eq!(install.read_definition().err(), Some(Refusal::NotRunning));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn refuses_a_writable_or_linked_definition() {
        let scratch = Scratch::new("definition-unsafe");
        let (install, _) = owned_install(&scratch);
        let path = install.definition();
        let (current, _) = systemd_bodies(&install.root, &install.home);
        write(&path, &current, 0o622);
        fs::set_permissions(&path, fs::Permissions::from_mode(0o622)).expect("writable");
        assert_eq!(install.read_definition().err(), Some(Refusal::NotRunning));

        fs::remove_file(&path).expect("remove");
        let outside = scratch.path().join("outside.service");
        write(&outside, &current, 0o600);
        std::os::unix::fs::symlink(&outside, &path).expect("symlink");
        assert_eq!(install.read_definition().err(), Some(Refusal::NotRunning));
    }

    #[derive(Default)]
    struct FakeRunner {
        calls: RefCell<Vec<(PathBuf, Vec<OsString>)>>,
        statuses: RefCell<Vec<i32>>,
    }

    impl Runner for FakeRunner {
        fn run(&self, program: &Path, args: &[OsString]) -> io::Result<ExitStatus> {
            self.calls
                .borrow_mut()
                .push((program.to_path_buf(), args.to_vec()));
            let code = self.statuses.borrow_mut().pop().unwrap_or(0);
            Ok(ExitStatus::from_raw(code))
        }
    }

    #[test]
    fn starts_once_with_the_checked_label() {
        let fake = FakeRunner::default();
        let plan = systemd_plan("dev.junto.machine.26d96d7bc0190e7e");
        assert!(plan.start(&fake).is_ok());
        assert_eq!(
            *fake.calls.borrow(),
            vec![(
                PathBuf::from("/usr/bin/systemctl"),
                vec![
                    OsString::from("--user"),
                    OsString::from("start"),
                    OsString::from("dev.junto.machine.26d96d7bc0190e7e.service"),
                ],
            )]
        );

        let fake = FakeRunner::default();
        let file = Path::new(
            "/Users/example/Library/LaunchAgents/dev.junto.machine.26d96d7bc0190e7e.plist",
        );
        let plan = launchd_plan("dev.junto.machine.26d96d7bc0190e7e", file, true);
        assert!(plan.start(&fake).is_ok());
        assert_eq!(
            *fake.calls.borrow(),
            vec![(
                PathBuf::from("/bin/launchctl"),
                vec![
                    OsString::from("bootstrap"),
                    OsString::from(format!("gui/{}", uid())),
                    file.as_os_str().to_owned(),
                ],
            )]
        );

        // A loaded but stopped job refuses bootstrap; the install's kickstart
        // is the same start attempt.
        let fake = FakeRunner::default();
        *fake.statuses.borrow_mut() = vec![0, 1];
        let plan = launchd_plan("dev.junto.machine.26d96d7bc0190e7e", file, false);
        assert!(plan.start(&fake).is_ok());
        assert_eq!(
            *fake.calls.borrow(),
            vec![
                (
                    PathBuf::from("/bin/launchctl"),
                    vec![
                        OsString::from("bootstrap"),
                        OsString::from(format!("user/{}", uid())),
                        file.as_os_str().to_owned(),
                    ],
                ),
                (
                    PathBuf::from("/bin/launchctl"),
                    vec![
                        OsString::from("kickstart"),
                        OsString::from(format!(
                            "user/{}/dev.junto.machine.26d96d7bc0190e7e",
                            uid()
                        )),
                    ],
                ),
            ]
        );
    }

    #[test]
    fn the_bounded_start_commands_are_named_beside_the_attempt() {
        assert_eq!(START_BOUND, Duration::from_secs(5));
        assert_eq!(CONNECT_BOUND, Duration::from_secs(8));
    }
}
