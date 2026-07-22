import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const pathsFile = join(root, "scripts/app-paths.sh");
const install = read(pathsFile.replace("app-paths.sh", "install-app.sh"));
const paths = read(pathsFile);
const launchd = read(pathsFile.replace("app-paths.sh", "install-launchd.sh"));

function read(path: string): string {
  return readFileSync(path, "utf8");
}

const temporaryRoots: string[] = [];
const makeSandbox = (): string => {
  const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "vellum-install-test.")));
  temporaryRoots.push(sandbox);
  mkdirSync(join(sandbox, "Applications"));
  return sandbox;
};

const forbiddenEnvironment = [
  "VELLUM_APP_DST",
  "VELLUM_PLIST",
  "VELLUM_LOG_DIR",
  "VELLUM_BIN_DIR",
  "VELLUM_LAUNCHD_LABEL",
  "VELLUM_PRODUCT_NAME",
  "VELLUM_APP_ID",
  "VELLUM_APP_SRC",
  "VELLUM_INSTALL_SANDBOX_ROOT",
] as const;

const runPaths = (
  sandbox: string,
  script: string,
  extraEnvironment: NodeJS.ProcessEnv = {},
) => {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const variable of forbiddenEnvironment) delete environment[variable];
  Object.assign(environment, {
    NODE_ENV: "test",
    VELLUM_INSTALL_SANDBOX_ROOT: sandbox,
    ...extraEnvironment,
  });
  return spawnSync("/bin/bash", ["-c", script, "vellum-path-test", pathsFile], {
    cwd: root,
    env: environment,
    encoding: "utf8",
  });
};

const position = (source: string, needle: string): number => {
  const index = source.indexOf(needle);
  expect(index, `missing ${needle}`).toBeGreaterThanOrEqual(0);
  return index;
};

afterEach(() => {
  for (const sandbox of temporaryRoots.splice(0)) {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

describe("hardened app installer", () => {
  it("audits candidate, staged, and installed copies before declaring success", () => {
    const candidate = position(install, 'audit_app_bundle "$APP_SRC"');
    const stageCopy = position(install, 'ditto --rsrc "$APP_SRC" "$STAGE"');
    const staged = position(install, 'audit_app_bundle "$STAGE"');
    const quiesce = position(install, "unload_launchd");
    const replace = position(install, 'mv "$STAGE" "$APP_DST"');
    const installed = position(install, 'audit_app_bundle "$APP_DST"');
    const success = position(install, 'log "installed $APP_DST"');

    expect(candidate).toBeLessThan(stageCopy);
    expect(stageCopy).toBeLessThan(staged);
    expect(staged).toBeLessThan(quiesce);
    expect(quiesce).toBeLessThan(replace);
    expect(replace).toBeLessThan(installed);
    expect(installed).toBeLessThan(success);
  });

  it("fixes production identities and write targets while retaining read-only candidate selection", () => {
    expect(paths).toContain('LABEL="skastr0.vellum"');
    expect(paths).toContain('PRODUCT_NAME="Vellum Command"');
    expect(paths).toContain('APP_BUNDLE_ID="skastr0.vellum"');
    expect(paths).toContain("installer identities are fixed");
    expect(paths).toContain("installer write targets are derived");
    expect(paths).toContain('APP_SRC="$(read_config_value VELLUM_APP_SRC');
    expect(paths).not.toContain('APP_DST="${VELLUM_APP_DST');
    expect(paths).not.toContain('PLIST="${VELLUM_PLIST');
    expect(paths).not.toContain('LOG_DIR="${VELLUM_LOG_DIR');
    expect(install).not.toContain("VELLUM_BIN_DIR:-");
  });

  it("uses one canonical test-only sandbox capability for every writable path", () => {
    const sandbox = makeSandbox();
    const result = runPaths(
      sandbox,
      `set -euo pipefail
source "$1"
assert_installer_path_capabilities
ensure_scoped_directory "log directory" "$LOG_DIR"
ensure_scoped_directory "CLI directory" "$BIN_DIR"
ensure_scoped_directory "LaunchAgents directory" "$INSTALL_USER_ROOT/Library/LaunchAgents"
derive_install_transaction_paths 4242
mkdir -m 0700 "$STAGE_ROOT"
bind_transaction_tree stage
assert_install_transaction_capabilities
safe_remove_transaction_tree stage
printf '%s\n' "$APP_DST" "$PLIST" "$LOG_DIR" "$BIN_DIR"`,
    );

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      join(sandbox, "Applications", "Vellum Command.app"),
      join(sandbox, "Library", "LaunchAgents", "skastr0.vellum.plist"),
      join(sandbox, "Library", "Logs", "Vellum Command"),
      join(sandbox, ".local", "bin"),
    ]);
  });

  it.each([
    ["root", "/"],
    ["account home", realpathSync(homedir())],
    ["repository", root],
    ["applications", "/Applications"],
    ["empty", ""],
  ])("refuses a %s sandbox root", (_name, sandboxOverride) => {
    const sandbox = makeSandbox();
    const result = runPaths(
      sandbox,
      'set -euo pipefail; source "$1"; assert_installer_path_capabilities',
      { VELLUM_INSTALL_SANDBOX_ROOT: sandboxOverride },
    );
    expect(result.status).not.toBe(0);
  });

  it("refuses sandbox mode outside the explicit test environment", () => {
    const sandbox = makeSandbox();
    const result = runPaths(
      sandbox,
      'set -euo pipefail; source "$1"; assert_installer_path_capabilities',
      { NODE_ENV: "production" },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("available only with NODE_ENV=test");
  });

  it("refuses an arbitrary canonical directory even in test mode", () => {
    const sandbox = makeSandbox();
    const nested = join(sandbox, "vellum-install-test.abcdef");
    mkdirSync(nested, { mode: 0o700 });
    mkdirSync(join(nested, "Applications"));
    const result = runPaths(
      sandbox,
      'set -euo pipefail; source "$1"; assert_installer_path_capabilities',
      { VELLUM_INSTALL_SANDBOX_ROOT: nested },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("OS user temporary root");
  });

  it("keeps filesystem-only sandbox mode away from product lifecycle controls", () => {
    expect(position(paths, 'launchd_loaded() {\n  if [[ -n "$INSTALL_SANDBOX_ROOT" ]]')).toBeGreaterThan(0);
    expect(position(paths, 'unload_launchd() {\n  if [[ -n "$INSTALL_SANDBOX_ROOT" ]]')).toBeGreaterThan(0);
    expect(position(paths, 'quit_running_app() {\n  if [[ -n "$INSTALL_SANDBOX_ROOT" ]]')).toBeGreaterThan(0);
    const sandboxRefusal = position(
      launchd,
      'if [[ -n "$INSTALL_SANDBOX_ROOT" ]]; then\n  err "LaunchAgent installation is unavailable',
    );
    expect(sandboxRefusal).toBeLessThan(position(launchd, "if launchd_loaded; then"));
    expect(install).toContain("sandbox installs cannot launch or supervise the app");
  });

  it.each([
    ["VELLUM_APP_DST", "/"],
    ["VELLUM_PLIST", ""],
    ["VELLUM_LOG_DIR", "../escape"],
    ["VELLUM_BIN_DIR", "/tmp/bin;touch-pwned"],
  ])("refuses the ambient writable override %s", (variable, value) => {
    const sandbox = makeSandbox();
    const result = runPaths(
      sandbox,
      'set -euo pipefail; source "$1"; assert_installer_path_capabilities',
      { [variable]: value },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("installer write targets are derived");
  });

  it.each([
    ["VELLUM_PRODUCT_NAME", 'Vellum"; touch pwned'],
    ["VELLUM_LAUNCHD_LABEL", "../../LaunchAgents/evil"],
    ["VELLUM_APP_ID", ""],
  ])("refuses the ambient identity override %s", (variable, value) => {
    const sandbox = makeSandbox();
    const result = runPaths(sandbox, 'set -euo pipefail; source "$1"', {
      [variable]: value,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("installer identities are fixed");
  });

  it("refuses parent traversal and metacharacters in reusable path validation", () => {
    const sandbox = makeSandbox();
    for (const candidate of [
      `${sandbox}/Applications/../Vellum Command.app`,
      `${sandbox}/Applications/evil;name/Vellum Command.app`,
    ]) {
      const result = runPaths(
        sandbox,
        'set -euo pipefail; source "$1"; assert_safe_absolute_path_text candidate "$CANDIDATE"',
        { CANDIDATE: candidate },
      );
      expect(result.status).not.toBe(0);
    }
  });

  it("refuses symlink escapes in app and user-scoped parents", () => {
    const appSandbox = makeSandbox();
    const appOutside = mkdtempSync(join(tmpdir(), "vellum-install-outside."));
    temporaryRoots.push(appOutside);
    rmSync(join(appSandbox, "Applications"), { recursive: true });
    symlinkSync(appOutside, join(appSandbox, "Applications"), "dir");
    const appResult = runPaths(
      appSandbox,
      'set -euo pipefail; source "$1"; assert_installer_path_capabilities',
    );
    expect(appResult.status).not.toBe(0);
    expect(appResult.stderr).toContain("non-symlink directory");

    const logSandbox = makeSandbox();
    const logOutside = mkdtempSync(join(tmpdir(), "vellum-log-outside."));
    temporaryRoots.push(logOutside);
    mkdirSync(join(logSandbox, "Library"));
    symlinkSync(logOutside, join(logSandbox, "Library", "Logs"), "dir");
    const logResult = runPaths(
      logSandbox,
      'set -euo pipefail; source "$1"; assert_installer_path_capabilities',
    );
    expect(logResult.status).not.toBe(0);
    expect(logResult.stderr).toContain("crosses symlink component");
  });

  it("refuses substituted or symlinked recursive transaction targets", () => {
    const sandbox = makeSandbox();
    const marker = join(sandbox, "do-not-remove");
    writeFileSync(marker, "retained");
    const substitution = runPaths(
      sandbox,
      `set -euo pipefail
source "$1"
assert_installer_path_capabilities
derive_install_transaction_paths 4242
STAGE_ROOT="$INSTALL_SANDBOX_ROOT"
safe_remove_transaction_tree stage`,
    );
    expect(substitution.status).not.toBe(0);
    expect(readFileSync(marker, "utf8")).toBe("retained");

    const outside = mkdtempSync(join(tmpdir(), "vellum-transaction-outside."));
    temporaryRoots.push(outside);
    const stageRoot = join(
      sandbox,
      "Applications",
      "Vellum Command.app.new.4242",
    );
    symlinkSync(outside, stageRoot, "dir");
    const symlink = runPaths(
      sandbox,
      `set -euo pipefail
source "$1"
assert_installer_path_capabilities
derive_install_transaction_paths 4242`,
    );
    expect(symlink.status).not.toBe(0);
  });

  it("refuses a canonical directory substituted after transaction binding", () => {
    const sandbox = makeSandbox();
    const result = runPaths(
      sandbox,
      `set -euo pipefail
source "$1"
assert_installer_path_capabilities
derive_install_transaction_paths 4242
mkdir -m 0700 "$STAGE_ROOT"
bind_transaction_tree stage
mv "$STAGE_ROOT" "\${STAGE_ROOT}.away"
mkdir -m 0700 "$STAGE_ROOT"
printf retained > "$STAGE_ROOT/marker"
safe_remove_transaction_tree stage`,
    );
    expect(result.status).not.toBe(0);
    expect(readFileSync(join(sandbox, "Applications", "Vellum Command.app.new.4242", "marker"), "utf8")).toBe(
      "retained",
    );
  });

  it("rejects empty or invalid candidates before installer mutation", () => {
    const sandbox = makeSandbox();
    const empty = runPaths(sandbox, 'set -euo pipefail; source "$1"', {
      VELLUM_APP_SRC: "",
    });
    expect(empty.status).not.toBe(0);
    expect(empty.stderr).toContain("VELLUM_APP_SRC must not be empty");

    const missing = runPaths(
      sandbox,
      'set -euo pipefail; source "$1"; assert_installer_path_capabilities; assert_app_bundle "$APP_SRC"',
      { VELLUM_APP_SRC: join(sandbox, "missing.app") },
    );
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain("missing app bundle");
  });

  it("revalidates every recursive removal and app move through transaction capabilities", () => {
    expect(install).toContain('derive_install_transaction_paths "$$"');
    expect(install.match(/assert_install_transaction_capabilities/gu)?.length).toBeGreaterThan(5);
    expect(install).not.toContain('rm -rf "$APP_DST"');
    expect(install).not.toContain('rm -rf "$STAGE_ROOT"');
    expect(paths.match(/rm -rf/gu)).toHaveLength(1);
    expect(paths).toContain('safe_remove_transaction_tree()');
    const stageMove = position(install, 'mv "$STAGE" "$APP_DST"');
    expect(install.lastIndexOf("assert_install_transaction_capabilities", stageMove)).toBeGreaterThan(0);
    expect(position(install, 'STAGED_APP_ID="$(path_identity "$STAGE")"')).toBeLessThan(stageMove);
  });

  it("writes and removes only the exact derived LaunchAgent plist", () => {
    expect(launchd).toContain("assert_installer_path_capabilities");
    expect(launchd).toContain('PLIST_STAGE="${PLIST}.new.$$"');
    expect(launchd).toContain("set -o noclobber");
    expect(launchd).toContain('exec 3> "$PLIST_STAGE"');
    expect(launchd).toContain("cat >&3 <<PLIST_EOF");
    expect(launchd).toContain("PLIST_STAGE_ID");
    expect(launchd).toContain("PLIST_BACKUP_ID");
    expect(launchd).toContain('if [[ "$(path_identity "$PLIST" 2>/dev/null)" != "$PLIST_STAGE_ID" ]]');
    expect(launchd).toContain('mv "$PLIST_BACKUP" "$PLIST"');
    expect(launchd).toContain("PLIST_TRANSACTION_COMPLETE=1");
    expect(launchd).toContain("PREVIOUS_LAUNCHD_LOADED");
    expect(launchd).toContain("restore_previous_launchd_job");
    expect(launchd).not.toContain('cat > "$PLIST"');
    expect(launchd).toContain("safe_remove_installer_file plist");
    expect(launchd).not.toContain('rm -f "$PLIST"');
  });

  it("routes supervised installation through the hardened installer", () => {
    expect(launchd).toContain('bash "$SCRIPT_DIR/install-app.sh"');
    expect(launchd).toContain('bash "$SCRIPT_DIR/install-app.sh" --skip-build');
    expect(position(install, 'audit_app_bundle "$APP_DST"')).toBeLessThan(
      position(install, 'bash "$SCRIPT_DIR/install-launchd.sh" --skip-build'),
    );
  });

  it("activates rollback before the first app destination move", () => {
    const backupMove = position(install, 'mv "$APP_DST" "$BACKUP"');
    const replacementActive = position(install, "REPLACEMENT_ACTIVE=1");
    const stagedMove = position(install, 'mv "$STAGE" "$APP_DST"');
    expect(replacementActive).toBeLessThan(backupMove);
    expect(backupMove).toBeLessThan(stagedMove);
    expect(install).toContain('if [[ "$NEW_APP_INSTALLED" -eq 1 && -e "$APP_DST" ]]');
    expect(position(install, "HAD_PREVIOUS=1")).toBeLessThan(backupMove);
    expect(position(install, "NEW_APP_MOVE_PENDING=1")).toBeLessThan(stagedMove);
  });

  it("does not roll CLI links back after the app transaction commits", () => {
    expect(install).toContain('if [[ "$status" -ne 0 && "$INSTALL_COMPLETE" -ne 1 ]]');
    expect(position(install, "INSTALL_COMPLETE=1")).toBeLessThan(
      position(install, 'bash "$SCRIPT_DIR/install-launchd.sh" --skip-build'),
    );
  });

  it("restores a previously loaded LaunchAgent on app-install failure and success", () => {
    expect(install).toContain("restore_previous_launchd_job()");
    expect(install).toContain(
      'if [[ "$status" -ne 0 && "$PREVIOUS_LAUNCHD_LOADED" -eq 1 ]] && ! restore_previous_launchd_job',
    );
    expect(install).toContain(
      'if [[ "$SUPERVISED" -eq 0 && "$PREVIOUS_LAUNCHD_LOADED" -eq 1 ]]',
    );
    expect(position(install, "restore_previous_launchd_job\nfi\n\nif [[ \"$SUPERVISED\"")).toBeGreaterThan(
      position(install, "REPLACEMENT_ACTIVE=0 INSTALL_COMPLETE=1"),
    );
  });
});
