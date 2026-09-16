import {
  chmodSync,
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
  const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "junto-install-test.")));
  temporaryRoots.push(sandbox);
  mkdirSync(join(sandbox, "Applications"));
  return sandbox;
};

const forbiddenEnvironment = [
  "JUNTO_APP_DST",
  "JUNTO_PLIST",
  "JUNTO_LOG_DIR",
  "JUNTO_BIN_DIR",
  "JUNTO_LAUNCHD_LABEL",
  "JUNTO_PRODUCT_NAME",
  "JUNTO_APP_ID",
  "JUNTO_APP_SRC",
  "JUNTO_INSTALL_SANDBOX_ROOT",
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
    JUNTO_INSTALL_SANDBOX_ROOT: sandbox,
    ...extraEnvironment,
  });
  return spawnSync(
    "/bin/bash",
    [
      "-c",
      script,
      "junto-path-test",
      pathsFile,
      sandbox,
      join(sandbox, ".junto", "state", "junto.db"),
    ],
    {
      cwd: root,
      env: environment,
      encoding: "utf8",
    },
  );
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
    const incumbentBind = install.lastIndexOf(
      "\nbind_unsupervised_incumbent\n",
    );
    const quiesce = position(install, "unload_launchd");
    const replace = position(install, "publish_staged_app_candidate");
    const installed = position(install, 'audit_app_bundle "$APP_DST"');
    const success = position(install, 'log "installed $APP_DST"');

    expect(candidate).toBeLessThan(stageCopy);
    expect(stageCopy).toBeLessThan(staged);
    expect(staged).toBeLessThan(incumbentBind);
    expect(incumbentBind).toBeLessThan(quiesce);
    expect(quiesce).toBeLessThan(replace);
    expect(replace).toBeLessThan(installed);
    expect(installed).toBeLessThan(success);
    expect(install).not.toContain("run_staged_state_update_preflight");
    expect(install).not.toContain("bind_state_update_source");
    expect(install).not.toContain("--junto-state-preflight");
  });

  it("fixes production identities and write targets while retaining read-only candidate selection", () => {
    expect(paths).toContain('LABEL="com.skastr0.junto"');
    expect(paths).toContain('PRODUCT_NAME="Junto"');
    expect(paths).toContain('APP_BUNDLE_ID="com.skastr0.junto"');
    expect(paths).toContain("installer identities are fixed");
    expect(paths).toContain("installer write targets are derived");
    expect(paths).toContain('APP_SRC="$(read_config_value JUNTO_APP_SRC');
    expect(paths).not.toContain('APP_DST="${JUNTO_APP_DST');
    expect(paths).not.toContain('PLIST="${JUNTO_PLIST');
    expect(paths).not.toContain('LOG_DIR="${JUNTO_LOG_DIR');
    expect(install).not.toContain("JUNTO_BIN_DIR:-");
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
bind_install_stage
assert_install_transaction_capabilities
safe_remove_install_stage
STATE_DATABASE="$INSTALL_USER_ROOT/.junto/state/junto.db"
if [[ "$INSTALL_USER_ROOT" != "$2" || "$STATE_DATABASE" != "$3" ]]; then
  exit 90
fi
printf '%s\n' "$APP_DST" "$PLIST" "$LOG_DIR" "$BIN_DIR" "$STATE_DATABASE"`,
    );

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      join(sandbox, "Applications", "Junto.app"),
      join(sandbox, "Library", "LaunchAgents", "com.skastr0.junto.plist"),
      join(sandbox, "Library", "Logs", "Junto"),
      join(sandbox, ".local", "bin"),
      join(sandbox, ".junto", "state", "junto.db"),
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
      { JUNTO_INSTALL_SANDBOX_ROOT: sandboxOverride },
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
    const nested = join(sandbox, "junto-install-test.abcdef");
    mkdirSync(nested, { mode: 0o700 });
    mkdirSync(join(nested, "Applications"));
    const result = runPaths(
      sandbox,
      'set -euo pipefail; source "$1"; assert_installer_path_capabilities',
      { JUNTO_INSTALL_SANDBOX_ROOT: nested },
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
    expect(sandboxRefusal).toBeLessThan(
      position(launchd, 'if [[ "${1:-}" == "--uninstall" ]]'),
    );
    expect(install).toContain("sandbox installs cannot launch or supervise the app");
  });

  it.each([
    ["JUNTO_APP_DST", "/"],
    ["JUNTO_PLIST", ""],
    ["JUNTO_LOG_DIR", "../escape"],
    ["JUNTO_BIN_DIR", "/tmp/bin;touch-pwned"],
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
    ["JUNTO_PRODUCT_NAME", 'Junto"; touch pwned'],
    ["JUNTO_LAUNCHD_LABEL", "../../LaunchAgents/evil"],
    ["JUNTO_APP_ID", ""],
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
      `${sandbox}/Applications/../Junto.app`,
      `${sandbox}/Applications/evil;name/Junto.app`,
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
    const appOutside = mkdtempSync(join(tmpdir(), "junto-install-outside."));
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
    const logOutside = mkdtempSync(join(tmpdir(), "junto-log-outside."));
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
safe_remove_install_stage`,
    );
    expect(substitution.status).not.toBe(0);
    expect(readFileSync(marker, "utf8")).toBe("retained");

    const outside = mkdtempSync(join(tmpdir(), "junto-transaction-outside."));
    temporaryRoots.push(outside);
    const stageRoot = join(
      sandbox,
      "Applications",
      "Junto.app.new.4242",
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
bind_install_stage
mv "$STAGE_ROOT" "\${STAGE_ROOT}.away"
mkdir -m 0700 "$STAGE_ROOT"
printf retained > "$STAGE_ROOT/marker"
safe_remove_install_stage`,
    );
    expect(result.status).not.toBe(0);
    expect(readFileSync(join(sandbox, "Applications", "Junto.app.new.4242", "marker"), "utf8")).toBe(
      "retained",
    );
  });

  it("refuses a substituted retired app while preserving the bound retirement root", () => {
    const sandbox = makeSandbox();
    const result = runPaths(
      sandbox,
      `set -euo pipefail
source "$1"
assert_installer_path_capabilities
derive_install_transaction_paths 4242
bind_app_retirement_root
mkdir -m 0700 "$RETIRED_APP"
RETIRED_APP_ID="$(path_identity "$RETIRED_APP")"
mv "$RETIRED_APP" "\${RETIRED_APP}.admitted"
mkdir -m 0700 "$RETIRED_APP"
printf foreign > "$RETIRED_APP/marker"
APP_RETIREMENT_DISPOSABLE=1
if safe_remove_app_retirement; then
  exit 91
fi
cat "$RETIRED_APP/marker"`,
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("foreign");
    expect(result.stderr).toContain(
      "retiring app is not the exact admitted Junto generation",
    );
  });

  it("refuses a substituted retired plist while preserving the bound retirement root", () => {
    const sandbox = makeSandbox();
    const result = runPaths(
      sandbox,
      `set -euo pipefail
source "$1"
assert_installer_path_capabilities
ensure_scoped_directory "LaunchAgents directory" "$INSTALL_USER_ROOT/Library/LaunchAgents"
PLIST_RETIREMENT_ROOT="\${PLIST}.retired.$$"
bind_launchd_retirement_root
printf admitted > "$RETIRED_PLIST"
RETIRED_PLIST_ID="$(path_identity "$RETIRED_PLIST")"
mv "$RETIRED_PLIST" "\${RETIRED_PLIST}.admitted"
printf foreign > "$RETIRED_PLIST"
PLIST_RETIREMENT_DISPOSABLE=1
if safe_remove_launchd_retirement; then
  exit 91
fi
cat "$RETIRED_PLIST"`,
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("foreign");
    expect(result.stderr).toContain(
      "retiring LaunchAgent plist is not the exact admitted Junto plist",
    );
  });

  it("refuses preexisting stage and retirement transaction paths untouched", () => {
    for (const suffix of ["new", "retired"]) {
      const sandbox = makeSandbox();
      const result = runPaths(
        sandbox,
        `set -euo pipefail
source "$1"
assert_installer_path_capabilities
TRANSACTION_PATH="\${APP_DST}.\${SUFFIX}.4242"
mkdir -m 0700 "$TRANSACTION_PATH"
printf retained > "$TRANSACTION_PATH/marker"
derive_install_transaction_paths 4242`,
        { SUFFIX: suffix },
      );
      expect(result.status).not.toBe(0);
      expect(
        readFileSync(
          join(
            sandbox,
            "Applications",
            `Junto.app.${suffix}.4242`,
            "marker",
          ),
          "utf8",
        ),
      ).toBe("retained");
    }
  });

  it("rejects empty or invalid candidates before installer mutation", () => {
    const sandbox = makeSandbox();
    const empty = runPaths(sandbox, 'set -euo pipefail; source "$1"', {
      JUNTO_APP_SRC: "",
    });
    expect(empty.status).not.toBe(0);
    expect(empty.stderr).toContain("JUNTO_APP_SRC must not be empty");

    const missing = runPaths(
      sandbox,
      'set -euo pipefail; source "$1"; assert_installer_path_capabilities; assert_app_bundle "$APP_SRC"',
      { JUNTO_APP_SRC: join(sandbox, "missing.app") },
    );
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain("missing app bundle");
  });

  it("retires only the admitted current app before recursive disposal", () => {
    expect(install).toContain('derive_install_transaction_paths "$$"');
    expect(install.match(/assert_install_transaction_capabilities/gu)?.length).toBeGreaterThan(5);
    expect(install).not.toContain('rm -rf "$STAGE_ROOT"');
    expect(paths.match(/rm -rf/gu)).toHaveLength(2);
    expect(paths).toContain('safe_remove_install_stage()');
    expect(paths).not.toContain('/bin/rm -rf -- "$APP_DST"');
    expect(paths).toContain('/bin/mv -n "$APP_DST" "$APP_RETIREMENT_ROOT/"');
    expect(paths).toContain('/bin/rm -rf -- "$RETIRED_APP"');
    expect(paths).toContain('assert_owned_current_app()');
    expect(paths).toContain('begin_one_way_app_cutover()');
    expect(paths).toContain("Print :CFBundleExecutable");
    expect(paths).toContain(
      '/usr/bin/codesign --verify --deep --strict --verbose=2 -R "$signing_requirement" "$APP_DST"',
    );
    const stageMove = position(install, "publish_staged_app_candidate");
    expect(install.lastIndexOf("assert_install_transaction_capabilities", stageMove)).toBeGreaterThan(0);
    expect(position(install, 'STAGED_APP_ID="$(path_identity "$STAGE")"')).toBeLessThan(stageMove);
  });

  it("refuses a substituted foreign current app before the one-way boundary", () => {
    const sandbox = makeSandbox();
    const result = runPaths(
      sandbox,
      `set -euo pipefail
source "$1"
assert_installer_path_capabilities
derive_install_transaction_paths 4242
mkdir -m 0700 "$APP_DST"
BOUND_APP_ID="$(path_identity "$APP_DST")"
mv "$APP_DST" "\${APP_DST}.away"
mkdir -m 0700 "$APP_DST"
printf retained > "$APP_DST/marker"
ACTIVATION_STARTED=0
if begin_one_way_app_cutover "$BOUND_APP_ID"; then
  exit 91
fi
printf '%s\n' "$ACTIVATION_STARTED"
cat "$APP_DST/marker"`,
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("0\nretained");
    expect(result.stderr).toContain(
      "current app changed identity before one-way activation",
    );
  });

  it("rejects an unrelated fixed-path app before destructive activation", () => {
    const sandbox = makeSandbox();
    const result = runPaths(
      sandbox,
      `set -euo pipefail
source "$1"
assert_installer_path_capabilities
derive_install_transaction_paths 4242
mkdir -m 0700 "$APP_DST"
printf retained > "$APP_DST/marker"
FOREIGN_APP_ID="$(path_identity "$APP_DST")"
ACTIVATION_STARTED=0
if begin_one_way_app_cutover "$FOREIGN_APP_ID"; then
  exit 91
fi
printf '%s\n' "$ACTIVATION_STARTED"
cat "$APP_DST/marker"`,
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("0\nretained");
    expect(result.stderr).toContain(
      "current app is not an owned Junto bundle",
    );
  });

  it("keeps a raced app destination and the staged candidate separate", () => {
    const sandbox = makeSandbox();
    const result = runPaths(
      sandbox,
      `set -euo pipefail
source "$1"
assert_installer_path_capabilities
derive_install_transaction_paths 4242
mkdir -m 0700 "$STAGE_ROOT"
bind_install_stage
mkdir -m 0700 "$STAGE"
STAGED_APP_ID="$(path_identity "$STAGE")"
mkdir -m 0700 "$APP_DST"
printf foreign > "$APP_DST/marker"
if publish_staged_app_candidate; then
  exit 91
fi
printf '%s\n' "$(path_identity "$STAGE")"
cat "$APP_DST/marker"`,
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split("\n")[1]).toBe("foreign");
    expect(result.stderr).toContain(
      "app destination became occupied before candidate publication",
    );
  });

  it("rejects a foreign fixed-path LaunchAgent plist without changing it", () => {
    const sandbox = makeSandbox();
    const result = runPaths(
      sandbox,
      `set -euo pipefail
source "$1"
assert_installer_path_capabilities
mkdir -p "$INSTALL_USER_ROOT/Library/LaunchAgents"
printf foreign > "$PLIST"
FOREIGN_ID="$(path_identity "$PLIST")"
if assert_owned_launchd_plist "$FOREIGN_ID"; then
  exit 91
fi
cat "$PLIST"`,
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("foreign");
    expect(result.stderr).toContain(
      "existing LaunchAgent plist is not owned by Junto",
    );
  });

  it("rejects an otherwise matching LaunchAgent with extra program arguments", () => {
    const sandbox = makeSandbox();
    const launchAgents = join(sandbox, "Library", "LaunchAgents");
    mkdirSync(launchAgents, { recursive: true });
    const plist = join(launchAgents, "com.skastr0.junto.plist");
    const program = join(
      sandbox,
      "Applications",
      "Junto.app",
      "Contents",
      "MacOS",
      "Junto",
    );
    writeFileSync(
      plist,
      `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>Label</key><string>com.skastr0.junto</string>
<key>ProgramArguments</key><array>
<string>${program}</string>
<string>--foreign</string>
</array>
</dict></plist>`,
    );
    const result = runPaths(
      sandbox,
      `set -euo pipefail
# PlistBuddy is macOS-only; answer the fixed LaunchAgent queries so the
# extra-argument refusal itself is what rejects the otherwise matching plist.
function /usr/libexec/PlistBuddy() {
  case "\${2:-}" in
    "Print :Label") printf '%s\\n' "com.skastr0.junto" ;;
    "Print :ProgramArguments:0") printf '%s\\n' "${program}" ;;
    "Print :ProgramArguments:1") printf '%s\\n' "--foreign" ;;
    *) exit 1 ;;
  esac
}
source "$1"
assert_installer_path_capabilities
PLIST_ID="$(path_identity "$PLIST")"
if assert_owned_launchd_plist "$PLIST_ID"; then
  exit 91
fi
test -f "$PLIST"`,
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toContain(
      "existing LaunchAgent plist has unexpected program arguments",
    );
    expect(readFileSync(plist, "utf8")).toContain("--foreign");
  });

  it("publishes a LaunchAgent candidate exclusively when the fixed path stays absent", () => {
    const sandbox = makeSandbox();
    const result = runPaths(
      sandbox,
      `set -euo pipefail
source "$1"
assert_installer_path_capabilities
mkdir -p "$INSTALL_USER_ROOT/Library/LaunchAgents"
PLIST_STAGE="\${PLIST}.new.$$"
printf candidate > "$PLIST_STAGE"
PLIST_STAGE_ID="$(path_identity "$PLIST_STAGE")"
printf foreign > "$PLIST"
if publish_launchd_candidate "$PLIST_STAGE_ID"; then
  exit 91
fi
printf '%s\n' "$(cat "$PLIST_STAGE")" "$(cat "$PLIST")"`,
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      "candidate",
      "foreign",
    ]);
    expect(result.stderr).toContain(
      "LaunchAgent plist destination became occupied before candidate publication",
    );
  });

  it("publishes the LaunchAgent through a one-way, identity-bound cutover", () => {
    const ownershipProof = launchd.lastIndexOf(
      'assert_owned_launchd_plist "$CURRENT_PLIST_ID"',
    );
    const boundary = position(launchd, "LAUNCHD_ACTIVATION_STARTED=1");
    const retire = launchd.lastIndexOf(
      '/bin/mv -n "$PLIST" "$PLIST_RETIREMENT_ROOT/"',
    );
    const publish = position(
      launchd,
      'publish_launchd_candidate "$PLIST_STAGE_ID"',
    );
    const bootstrap = position(
      launchd,
      'launchctl bootstrap "$DOMAIN" "$PLIST"',
    );
    expect(launchd).toContain("assert_installer_path_capabilities");
    expect(launchd).toContain('PLIST_STAGE="${PLIST}.new.$$"');
    expect(launchd).toContain(
      'PLIST_RETIREMENT_ROOT="${PLIST}.retired.$$"',
    );
    expect(launchd).toContain("set -o noclobber");
    expect(launchd).toContain('exec 3> "$PLIST_STAGE"');
    expect(launchd).toContain("cat >&3 <<PLIST_EOF");
    expect(launchd).toContain("PLIST_STAGE_ID");
    expect(launchd).toContain('if [[ "$(path_identity "$PLIST" 2>/dev/null)" != "$PLIST_STAGE_ID" ]]');
    expect(launchd).not.toContain('cat > "$PLIST"');
    expect(launchd).not.toContain('rm -f "$PLIST"');
    expect(ownershipProof).toBeGreaterThan(0);
    expect(ownershipProof).toBeLessThan(boundary);
    expect(boundary).toBeLessThan(retire);
    expect(retire).toBeLessThan(publish);
    expect(publish).toBeLessThan(bootstrap);
    expect(launchd).toContain(
      "one-way LaunchAgent activation requires forward repair",
    );
    expect(launchd).toContain(
      'if launchd_loaded && ! unload_launchd',
    );
    expect(position(launchd, "refusing to reuse a LaunchAgent activation path"))
      .toBeLessThan(position(launchd, 'exec 3> "$PLIST_STAGE"'));

    const uninstall = launchd.slice(
      position(launchd, 'if [[ "${1:-}" == "--uninstall" ]]'),
      position(launchd, 'if [[ "${1:-}" != "--skip-build" ]]'),
    );
    const firstOwnership = position(
      uninstall,
      'assert_owned_launchd_plist "$UNINSTALL_PLIST_ID"',
    );
    const unload = position(uninstall, "unload_launchd");
    const secondOwnership = uninstall.lastIndexOf(
      'assert_owned_launchd_plist "$UNINSTALL_PLIST_ID"',
    );
    const retireUninstall = position(
      uninstall,
      '/bin/mv -n "$PLIST" "$PLIST_RETIREMENT_ROOT/"',
    );
    expect(firstOwnership).toBeLessThan(unload);
    expect(unload).toBeLessThan(secondOwnership);
    expect(secondOwnership).toBeLessThan(retireUninstall);
  });

  it("routes supervised installation through the hardened installer", () => {
    expect(launchd).toContain('bash "$SCRIPT_DIR/install-app.sh"');
    expect(launchd).toContain('bash "$SCRIPT_DIR/install-app.sh" --skip-build');
    expect(position(install, 'audit_app_bundle "$APP_DST"')).toBeLessThan(
      position(install, 'bash "$SCRIPT_DIR/install-launchd.sh" --skip-build'),
    );
  });

  it("crosses the one-way boundary only after quiescence and before current-app removal", () => {
    const cutover = position(
      install,
      'begin_one_way_app_cutover "$CURRENT_APP_ID"',
    );
    const stagedMove = position(install, "publish_staged_app_candidate");
    expect(position(install, 'audit_app_bundle "$APP_SRC"')).toBeLessThan(
      cutover,
    );
    expect(position(install, 'audit_app_bundle "$STAGE"')).toBeLessThan(
      cutover,
    );
    expect(position(install, "unload_launchd")).toBeLessThan(cutover);
    expect(position(install, "junto_processes_running")).toBeLessThan(
      cutover,
    );
    expect(
      install.lastIndexOf('assert_owned_current_app "$CURRENT_APP_ID"', cutover),
    ).toBeGreaterThan(0);
    expect(install).not.toContain("assert_state_update_source_unchanged");
    expect(cutover).toBeLessThan(stagedMove);
    expect(position(install, "CANDIDATE_MOVE_PENDING=1")).toBeLessThan(
      stagedMove,
    );

    const helperStart = position(paths, "begin_one_way_app_cutover() {");
    const helperEnd = position(
      paths,
      "# Prefer zip matching the packaged app version",
    );
    const helper = paths.slice(helperStart, helperEnd);
    expect(position(helper, 'assert_owned_current_app "$expected_identity"'))
      .toBeLessThan(position(helper, "ACTIVATION_STARTED=1"));
    expect(position(helper, "ACTIVATION_STARTED=1"))
      .toBeLessThan(
        position(helper, '/bin/mv -n "$APP_DST" "$APP_RETIREMENT_ROOT/"'),
      );
    expect(position(helper, '/bin/mv -n "$APP_DST" "$APP_RETIREMENT_ROOT/"'))
      .toBeLessThan(position(helper, "safe_remove_app_retirement"));
  });

  it("retains the published candidate and current CLI surface for forward repair", () => {
    const published = install.lastIndexOf("CANDIDATE_PUBLISHED=1");
    const installedAudit = position(install, 'audit_app_bundle "$APP_DST"');
    const cliInstall = install.lastIndexOf("\ninstall_cli_tools\n");
    expect(published).toBeGreaterThan(0);
    expect(cliInstall).toBeGreaterThan(0);
    expect(published).toBeLessThan(installedAudit);
    expect(installedAudit).toBeLessThan(cliInstall);
    expect(install).toContain(
      'err "one-way activation requires forward repair; candidate retained at $retained_candidate"',
    );
    expect(install).toContain(
      'if [[ "$ACTIVATION_STARTED" -eq 0 || "$CANDIDATE_PUBLISHED" -eq 1 ]]',
    );
    expect(install).not.toContain("remove_created_cli_link");
  });

  it("contains no retired local app rollback or cached-generation signatures", () => {
    const localInstallerSurface = `${install}\n${launchd}\n${paths}`;
    for (const signature of [
      "rollback_previous_app",
      "REPLACEMENT_ACTIVE",
      "HAD_PREVIOUS",
      "BACKUP_RESTORE_PENDING",
      'mv "$APP_DST" "$BACKUP"',
      'mv "$BACKUP" "$APP_DST"',
      '${APP_DST}.previous.${INSTALL_TRANSACTION_ID}',
      '${APP_DST}.rejected.${INSTALL_TRANSACTION_ID}',
      "install backup",
      "rejected install",
      "restore_previous_launchd_job",
      "PLIST_BACKUP",
      "PLIST_RESTORE_PENDING",
      "PREVIOUS_LAUNCHD_LOADED",
      '${PLIST}.previous.$$',
    ]) {
      expect(localInstallerSurface, `retired signature: ${signature}`).not
        .toContain(signature);
    }
  });

  it("resumes a loaded LaunchAgent only before activation failure or after publication", () => {
    expect(install).toContain("resume_launchd_job()");
    expect(install).toContain(
      'if [[ "$status" -ne 0 && "$ACTIVATION_STARTED" -eq 0 && "$LAUNCHD_WAS_LOADED" -eq 1 ]] && ! resume_launchd_job',
    );
    expect(install).toContain(
      'if [[ "$SUPERVISED" -eq 0 && "$LAUNCHD_WAS_LOADED" -eq 1 ]]',
    );
    expect(
      install.lastIndexOf("resume_launchd_job"),
    ).toBeGreaterThan(
      install.lastIndexOf("CANDIDATE_PUBLISHED=1"),
    );
  });

  it("binds only the exact fixed unsupervised app generation before quiescence", () => {
    const processStart = position(
      install,
      "fixed_installed_app_process_running() {",
    );
    const processEnd = position(
      install,
      "\nbind_unsupervised_incumbent() {",
    );
    const processProbe = install.slice(processStart, processEnd);
    const bindStart = processEnd + 1;
    const bindEnd = position(
      install,
      "\nresume_unsupervised_incumbent() {",
    );
    const bind = install.slice(bindStart, bindEnd);
    const bindCall = install.lastIndexOf(
      "\nbind_unsupervised_incumbent\n",
    );
    const unload = position(install, "\nunload_launchd\n");

    expect(processProbe).toContain(
      'local executable="$APP_DST/Contents/MacOS/$PRODUCT_NAME"',
    );
    expect(processProbe).toContain(
      "/bin/ps -axww -o command=",
    );
    expect(processProbe).toContain(
      '"${command:0:${#executable}}" == "$executable"',
    );
    expect(processProbe).not.toContain("pgrep -x");
    expect(processProbe).not.toContain("APP_SRC");
    expect(bind).toContain("if launchd_loaded; then");
    expect(bind).toContain("LAUNCHD_WAS_LOADED=1");
    expect(bind).toContain(
      'identity="$(path_identity "$APP_DST")"',
    );
    expect(bind).toContain(
      'assert_owned_current_app "$identity"',
    );
    expect(
      bind.lastIndexOf("fixed_installed_app_process_running"),
    ).toBeLessThan(
      position(bind, "UNSUPERVISED_INCUMBENT_WAS_RUNNING=1"),
    );
    expect(bindCall).toBeGreaterThan(0);
    expect(bindCall).toBeLessThan(unload);
  });

  it("reopens only the unchanged fixed app on pre-activation failure and proves it returned", () => {
    const resumeStart = position(
      install,
      "resume_unsupervised_incumbent() {",
    );
    const resumeEnd = position(install, "\ncd \"$REPO_ROOT\"");
    const resume = install.slice(resumeStart, resumeEnd);
    const activationGuard = position(
      resume,
      'if [[ "${ACTIVATION_STARTED:-0}" -ne 0 ]]',
    );
    const identityAdmission = position(
      resume,
      'assert_owned_current_app "$UNSUPERVISED_INCUMBENT_APP_ID"',
    );
    const open = position(
      resume,
      '/usr/bin/open "$APP_DST"',
    );
    const boundedProof = position(
      resume,
      "for i in $(seq 1 20); do",
    );

    expect(activationGuard).toBeLessThan(identityAdmission);
    expect(identityAdmission).toBeLessThan(open);
    expect(open).toBeLessThan(boundedProof);
    expect(resume).toContain("/usr/bin/env -i \\");
    expect(resume).toContain('HOME="$ACCOUNT_HOME"');
    expect(resume).toContain('PATH="/usr/bin:/bin"');
    expect(resume).not.toContain("open -a");
    expect(resume).not.toContain("APP_SRC");
    expect(resume).toContain(
      '"$(path_identity "$APP_DST" 2>/dev/null)" != "$UNSUPERVISED_INCUMBENT_APP_ID"',
    );
    expect(
      resume.lastIndexOf(
        'assert_owned_current_app \\\n        "$UNSUPERVISED_INCUMBENT_APP_ID"',
      ),
    ).toBeGreaterThan(boundedProof);
    expect(resume).toContain("sleep 0.5");
    expect(resume).toContain(
      "unchanged unsupervised incumbent did not resume within 10s",
    );

    const launchdResume = position(
      install,
      'if [[ "$status" -ne 0 && "$ACTIVATION_STARTED" -eq 0 && "$LAUNCHD_WAS_LOADED" -eq 1 ]] && ! resume_launchd_job',
    );
    const unsupervisedResume = position(
      install,
      'if [[ "$status" -ne 0 && "$ACTIVATION_STARTED" -eq 0 && "$UNSUPERVISED_INCUMBENT_WAS_RUNNING" -eq 1 ]] && ! resume_unsupervised_incumbent',
    );
    expect(launchdResume).toBeLessThan(unsupervisedResume);
    expect(install.slice(unsupervisedResume)).toContain(
      "failed to resume the unchanged pre-activation app",
    );
  });
});
