//! A first install on a disposable home: the exact layout, the ledger the app's
//! updater later reads, and every refusal a user can reach from the CLI.

use std::fs;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::Command;

use junto_desktop_bootstrap::archive;
use junto_desktop_bootstrap::asar;
use junto_desktop_bootstrap::install::{
    activate_first_install, first_install_available, revalidate, stage,
};
use junto_desktop_bootstrap::release::{Descriptor, timestamp_ms};
use junto_desktop_bootstrap::trust::Trust;
use junto_desktop_bootstrap::verify::verify_release_files;
use serde_json::Value;

const VERSION: &str = "0.3.0";

fn fixture(path: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/fixtures/linux-install")
        .join(path)
}

fn archive_path() -> PathBuf {
    fixture("junto-runtime-0.3.0-linux-x64.tar.gz")
}

fn load(path: &Path) -> Value {
    serde_json::from_slice(
        &fs::read(path).unwrap_or_else(|cause| panic!("{}: {cause}", path.display())),
    )
    .unwrap_or_else(|cause| panic!("{}: {cause}", path.display()))
}

fn fixture_trust() -> Trust {
    Trust::decode(&load(&fixture("trust.json"))).expect("fixture trust")
}

fn now_after_release() -> i64 {
    timestamp_ms("2026-02-01T00:00:00.000Z").expect("now")
}

fn temp_home(label: &str) -> PathBuf {
    let unique = format!(
        "junto-bootstrap-{label}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    );
    let home = std::env::temp_dir().join(unique);
    fs::create_dir(&home).expect("temp home");
    fs::set_permissions(&home, fs::Permissions::from_mode(0o700)).expect("home mode");
    home
}

fn verified() -> junto_desktop_bootstrap::verify::Verified {
    verify_release_files(
        &fixture("release.json"),
        &archive_path(),
        &fixture_trust(),
        now_after_release(),
    )
    .expect("signed fixture")
}

fn expected_launcher(home: &Path, generation: &str) -> String {
    let executable = home
        .join(".local/opt/junto-alpha")
        .join(generation)
        .join("junto");
    format!(
        "#!/bin/sh\n# Junto managed Linux desktop launcher\n# generation: {generation}\nexec '{}' \"$@\"\n",
        executable.display()
    )
}

fn expected_desktop(home: &Path) -> String {
    let executable = home.join(".local/bin/junto-desktop");
    format!(
        "[Desktop Entry]\nType=Application\nName=Junto\nComment=Junto desktop\nExec=\"{}\" %U\nTerminal=false\nCategories=Development;\nStartupWMClass=junto\n",
        executable.display()
    )
}

#[test]
fn installs_one_generation_and_publishes_the_launcher_once() {
    let home = temp_home("install");
    let verified = verified();
    assert_eq!(verified.descriptor.version, VERSION);
    first_install_available(Some(&home)).expect("creates nothing, admits");
    let staged = stage(&verified, &archive_path(), Some(&home)).expect("stages");
    revalidate(&staged).expect("revalidates");
    let executable = activate_first_install(&staged).expect("activates");

    let generation = format!("{VERSION}-{}", staged.archive_sha256);
    let root = home.join(".local/opt/junto-alpha");
    assert_eq!(executable, root.join(&generation).join("junto"));
    let executable_metadata = fs::metadata(&executable).expect("executable");
    assert!(executable_metadata.is_file());
    assert_ne!(executable_metadata.mode() & 0o111, 0);
    assert!(root.join(&generation).join("resources/app.asar").is_file());

    let launcher = home.join(".local/bin/junto-desktop");
    assert_eq!(
        fs::read_to_string(&launcher).expect("launcher"),
        expected_launcher(&home, &generation)
    );
    assert_eq!(
        fs::metadata(&launcher).expect("launcher").mode() & 0o777,
        0o755
    );
    let desktop = home.join(".local/share/applications/junto.desktop");
    assert_eq!(
        fs::read_to_string(&desktop).expect("desktop"),
        expected_desktop(&home)
    );
    assert_eq!(
        fs::metadata(&desktop).expect("desktop").mode() & 0o777,
        0o644
    );

    // The attempt is retired and the generation keeps one admitted ledger row.
    let names: Vec<String> = fs::read_dir(&root)
        .expect("root")
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| entry.file_name().to_str().map(str::to_owned))
        .collect();
    assert!(
        names.iter().all(|name| !name.starts_with(".stage-")),
        "{names:?}"
    );
    let allocation = fs::read_to_string(
        root.join(".install-storage/allocations")
            .join(format!("{generation}.json")),
    )
    .expect("allocation");
    let allocation: Value = serde_json::from_str(&allocation).expect("allocation json");
    assert_eq!(allocation["kind"], "generation");
    assert_eq!(allocation["phase"], "admitted");
    assert_eq!(allocation["version"], VERSION);
    assert_eq!(allocation["archiveSha256"], staged.archive_sha256);

    // A second first install refuses the launcher it just published.
    let refusal = first_install_available(Some(&home)).expect_err("refuses");
    assert_eq!(
        refusal.message(),
        "First install refuses an existing desktop launcher"
    );

    // The packaged identity inside the staged generation still matches.
    asar::admit(
        &root.join(&generation).join("resources/app.asar"),
        VERSION,
        &verified.descriptor.source_revision,
    )
    .expect("identity");
    let mismatch = asar::admit(
        &root.join(&generation).join("resources/app.asar"),
        "9.9.9",
        &verified.descriptor.source_revision,
    )
    .expect_err("wrong version");
    assert_eq!(
        mismatch.message(),
        "Packaged update version or source identity does not match the signed release"
    );

    fs::remove_dir_all(&home).expect("cleanup");
}

#[test]
fn refuses_a_foreign_desktop_entry_and_a_foreign_launcher() {
    let home = temp_home("foreign");
    let applications = home.join(".local/share/applications");
    fs::create_dir_all(&applications).expect("applications");
    fs::set_permissions(&applications, fs::Permissions::from_mode(0o700)).expect("mode");
    fs::write(
        applications.join("junto.desktop"),
        "[Desktop Entry]\nName=Other\n",
    )
    .expect("desktop");
    let refusal = first_install_available(Some(&home)).expect_err("foreign desktop");
    assert_eq!(
        refusal.message(),
        "Refusing to replace an unrelated desktop entry"
    );

    fs::remove_file(applications.join("junto.desktop")).expect("remove");
    let bin = home.join(".local/bin");
    fs::create_dir_all(&bin).expect("bin");
    fs::set_permissions(&bin, fs::Permissions::from_mode(0o700)).expect("mode");
    fs::write(bin.join("junto-desktop"), "#!/bin/sh\nexit 0\n").expect("launcher");
    fs::set_permissions(bin.join("junto-desktop"), fs::Permissions::from_mode(0o755))
        .expect("mode");
    let refusal = first_install_available(Some(&home)).expect_err("foreign launcher");
    assert_eq!(
        refusal.message(),
        "First install refuses an existing desktop launcher"
    );

    fs::remove_dir_all(&home).expect("cleanup");
}

#[test]
fn refuses_a_tampered_archive_before_extraction() {
    let home = temp_home("tampered");
    let tampered = home.join("junto-runtime-0.3.0-linux-x64.tar.gz");
    let mut changed = fs::read(archive_path()).expect("archive");
    let last = changed.len() - 1;
    changed[last] ^= 0xff;
    fs::write(&tampered, changed).expect("tamper");
    let refusal = verify_release_files(
        &fixture("release.json"),
        &tampered,
        &fixture_trust(),
        now_after_release(),
    )
    .expect_err("tampered bytes");
    assert_eq!(
        refusal.message(),
        "local release bytes differ from the signed descriptor"
    );
    fs::remove_dir_all(&home).expect("cleanup");
}

fn tar_with_symlink(path: &Path) {
    let file = fs::File::create(path).expect("tar");
    let encoder = flate2::write::GzEncoder::new(file, flate2::Compression::default());
    let mut builder = tar::Builder::new(encoder);
    for (name, kind, mode, body) in [
        (
            "junto-runtime-0.3.0-linux-x64",
            tar::EntryType::Directory,
            0o755,
            &b""[..],
        ),
        (
            "junto-runtime-0.3.0-linux-x64/junto",
            tar::EntryType::Regular,
            0o755,
            &b"#!/bin/sh\n"[..],
        ),
    ] {
        let mut header = tar::Header::new_old();
        header.set_entry_type(kind);
        header.set_mode(mode);
        header.set_size(body.len() as u64);
        header.set_mtime(0);
        header.set_cksum();
        builder
            .append_data(&mut header, name, body)
            .expect("member");
    }
    let mut header = tar::Header::new_old();
    header.set_entry_type(tar::EntryType::Symlink);
    header.set_mode(0o777);
    header.set_size(0);
    header.set_link_name("/etc/passwd").expect("link");
    header.set_cksum();
    builder
        .append_data(
            &mut header,
            "junto-runtime-0.3.0-linux-x64/resources",
            &[][..],
        )
        .expect("symlink");
    builder.finish().expect("finish");
}

#[test]
fn refuses_links_in_the_archive() {
    let home = temp_home("links");
    let archive_path = home.join("junto-runtime-0.3.0-linux-x64.tar.gz");
    tar_with_symlink(&archive_path);
    let mut descriptor: Descriptor = verified().descriptor;
    descriptor.archive =
        junto_desktop_bootstrap::verify::fingerprint_file(&archive_path).expect("fingerprint");
    let attempt = home.join(".stage-test");
    fs::create_dir(&attempt).expect("attempt");
    let refusal = archive::extract(
        &archive_path,
        &attempt,
        &descriptor.archive,
        &descriptor.version,
    )
    .expect_err("symlink refused");
    assert_eq!(
        refusal.message(),
        "Linux desktop archive permits regular files and directories only"
    );
    fs::remove_dir_all(&home).expect("cleanup");
}

#[test]
fn cli_prints_identity_and_structured_failure() {
    let binary = env!("CARGO_BIN_EXE_junto-desktop-bootstrap-linux-x64");
    let version = Command::new(binary)
        .arg("--version")
        .output()
        .expect("version");
    assert!(version.status.success());
    let envelope: Value = serde_json::from_slice(&version.stdout).expect("json");
    assert_eq!(envelope["ok"], true);
    assert_eq!(envelope["command"], "linux-desktop-bootstrap");
    assert_eq!(envelope["data"]["bootstrap_version"], "1.0.0");
    assert_eq!(envelope["data"]["trusted_key_id"], "junto-linux-2026a");
    assert_eq!(version.stdout.last(), Some(&b'\n'));

    let help = Command::new(binary).arg("--help").output().expect("help");
    assert!(help.status.success());
    assert!(String::from_utf8_lossy(&help.stdout).contains("--release FILE --archive FILE"));

    let refusal = Command::new(binary)
        .args(["--trust", "attacker.json"])
        .output()
        .expect("refusal");
    assert_eq!(refusal.status.code(), Some(1));
    let envelope: Value = serde_json::from_slice(&refusal.stderr).expect("json");
    assert_eq!(envelope["ok"], false);
    assert_eq!(envelope["error"]["type"], "LinuxDesktopInstallError");
    assert_eq!(
        envelope["error"]["message"],
        "unknown bootstrap option: --trust"
    );
    assert!(
        envelope["error"]["details"]["next_step"]
            .as_str()
            .is_some_and(|step| step.contains("Obtain the independently authenticated bootstrap"))
    );
    assert!(envelope["error"]["details"].get("activated").is_none());

    let missing = Command::new(binary)
        .args(["--release"])
        .output()
        .expect("missing");
    assert_eq!(missing.status.code(), Some(1));
    let envelope: Value = serde_json::from_slice(&missing.stderr).expect("json");
    assert_eq!(
        envelope["error"]["message"],
        "missing or duplicate bootstrap option: --release"
    );
}
