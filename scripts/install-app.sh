#!/usr/bin/env bash
# Install a built Vellum.app into the fixed /Applications product path.
#
#   scripts/install-app.sh                 build then install
#   scripts/install-app.sh --skip-build    install existing release/*.app
#   scripts/install-app.sh --fast          build --fast then install
#   scripts/install-app.sh --verify        build --verify then install
#   scripts/install-app.sh --open          open the app after install
#   scripts/install-app.sh --supervised    also (re)load LaunchAgent (crash-only KeepAlive)
#
# Station preference (settings.station.supervisedPreferred):
#   Product intent only — this script never opens Vellum's SQLite state.
#   StationRoleGate sets supervisedPreferred=true when role=remote. The install
#   surface for that preference is --supervised (or bun run app:install:supervised).
#   Settings doctor metadata reports preferred vs LaunchAgent-loaded so Remote
#   deploy (later) can decide to pass --supervised. No third binary.
#
# Installs `vellum …`, `vellum-browser …`, and `vellum-station` as atomic
# symlinks under ~/.local/bin. Existing non-Vellum commands are
# never overwritten.
#
# Safety:
#   - Unloads LaunchAgent before replacing the binary
#   - Soft-quits running app so herdr control streams can detach (never pane-kill)
#   - Validates .app structure + bundle id before ditto
#   - Crosses one explicit one-way boundary only after preflight and quiescence
#   - Retains the current candidate for forward repair after that boundary
#   - Never runs herdr pane close / session stop
#
# Herdr: quitting Vellum detaches control streams only — your herdr sessions survive.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=app-paths.sh
source "$SCRIPT_DIR/app-paths.sh"

SKIP_BUILD=0
FAST=0
VERIFY=0
OPEN=0
SUPERVISED=0

usage() {
  sed -n '2,26p' "$0" | sed 's/^# \?//'
  exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-build) SKIP_BUILD=1; shift ;;
    --fast) FAST=1; shift ;;
    --verify) VERIFY=1; shift ;;
    --open) OPEN=1; shift ;;
    --supervised) SUPERVISED=1; shift ;;
    -h|--help) usage 0 ;;
    *) err "unknown flag: $1"; usage 1 ;;
  esac
done

assert_installer_path_capabilities
if [[ -n "$INSTALL_SANDBOX_ROOT" && ( "$SUPERVISED" -eq 1 || "$OPEN" -eq 1 ) ]]; then
  err "sandbox installs cannot launch or supervise the app"
  exit 1
fi
LAUNCHD_WAS_LOADED=0
if launchd_loaded; then
  LAUNCHD_WAS_LOADED=1
fi
UNSUPERVISED_INCUMBENT_WAS_RUNNING=0
UNSUPERVISED_INCUMBENT_APP_ID=""
STATE_DATABASE="$INSTALL_USER_ROOT/.vellum/state/vellum.db"
STATE_PREFLIGHT_SOURCE=""
STATE_PREFLIGHT_DATABASE_ID=""

resume_launchd_job() {
  if [[ "$LAUNCHD_WAS_LOADED" -ne 1 || launchd_loaded ]]; then
    return 0
  fi
  assert_safe_scoped_file "LaunchAgent plist" "$PLIST" "$INSTALL_USER_ROOT/Library/LaunchAgents/${LABEL}.plist" || return 1
  launchctl bootstrap "$DOMAIN" "$PLIST" || return 1
  launchctl enable "$DOMAIN/$LABEL"
}

fixed_installed_app_process_running() {
  local executable="$APP_DST/Contents/MacOS/$PRODUCT_NAME"
  local command
  if [[ -n "$INSTALL_SANDBOX_ROOT" ]]; then
    return 1
  fi
  while IFS= read -r command; do
    if [[
      "${command:0:${#executable}}" == "$executable" &&
      (
        "${#command}" -eq "${#executable}" ||
        "${command:${#executable}:1}" == " "
      )
    ]]; then
      return 0
    fi
  done < <(/bin/ps -axww -o command= 2>/dev/null)
  return 1
}

bind_unsupervised_incumbent() {
  local identity
  if launchd_loaded; then
    LAUNCHD_WAS_LOADED=1
    return 0
  fi
  if [[ "$LAUNCHD_WAS_LOADED" -eq 1 ]]; then
    return 0
  fi
  if ! fixed_installed_app_process_running; then
    return 0
  fi
  assert_app_destination_capability || return 1
  identity="$(path_identity "$APP_DST")" || return 1
  assert_owned_current_app "$identity" || return 1
  # A process that exited during admission does not need recovery. Bind only
  # the exact installed generation still alive at the quiescence boundary.
  if ! fixed_installed_app_process_running; then
    return 0
  fi
  UNSUPERVISED_INCUMBENT_APP_ID="$identity"
  UNSUPERVISED_INCUMBENT_WAS_RUNNING=1
}

resume_unsupervised_incumbent() {
  local account_name temp_root identity i
  if [[ "$UNSUPERVISED_INCUMBENT_WAS_RUNNING" -ne 1 ]]; then
    return 0
  fi
  if [[ "${ACTIVATION_STARTED:-0}" -ne 0 ]]; then
    err "refusing to resume an older unsupervised app after activation"
    return 1
  fi
  assert_app_destination_capability || return 1
  identity="$(path_identity "$APP_DST" 2>/dev/null)" || return 1
  if [[
    -z "$UNSUPERVISED_INCUMBENT_APP_ID" ||
    "$identity" != "$UNSUPERVISED_INCUMBENT_APP_ID"
  ]]; then
    err "unsupervised incumbent changed identity before recovery"
    return 1
  fi
  assert_owned_current_app "$UNSUPERVISED_INCUMBENT_APP_ID" || return 1
  if fixed_installed_app_process_running; then
    return 0
  fi

  account_name="$(id -un)" || return 1
  temp_root="$(current_user_test_temp_root)" || return 1
  log "resuming unchanged unsupervised incumbent → $APP_DST"
  if [[
    "$(path_identity "$APP_DST" 2>/dev/null)" != "$UNSUPERVISED_INCUMBENT_APP_ID"
  ]]; then
    err "unsupervised incumbent changed identity at recovery launch"
    return 1
  fi
  /usr/bin/env -i \
    HOME="$ACCOUNT_HOME" \
    LOGNAME="$account_name" \
    PATH="/usr/bin:/bin" \
    TMPDIR="$temp_root" \
    USER="$account_name" \
    /usr/bin/open "$APP_DST" || return 1
  for i in $(seq 1 20); do
    if fixed_installed_app_process_running; then
      assert_owned_current_app \
        "$UNSUPERVISED_INCUMBENT_APP_ID" || return 1
      log "unchanged unsupervised incumbent resumed"
      return 0
    fi
    sleep 0.5
  done
  err "unchanged unsupervised incumbent did not resume within 10s"
  return 1
}
cd "$REPO_ROOT"
bun "$SCRIPT_DIR/electron-security-policy.ts" validate

assert_cli_path() {
  local description="$1"
  local path="$2"
  local expected="$3"
  assert_exact_scoped_path "$description" "$path" "$expected" "$INSTALL_USER_ROOT" || return 1
}

preflight_cli_link() {
  local target="$1"
  local helper="$2"
  local name="${target##*/}"
  assert_scoped_directory_capability "CLI directory" "$BIN_DIR" || return 1
  assert_cli_path "CLI link" "$target" "$BIN_DIR/$name" || return 1
  if [[
    "$name" != "vellum" &&
    "$name" != "vellum-browser" &&
    "$name" != "vellum-station"
  ]]; then
    err "refusing unexpected CLI link name: $name"
    return 1
  fi
  if [[ -e "$target" && ! -L "$target" ]]; then
    err "refusing to replace non-symlink command: $target"
    return 1
  fi
  if [[ -L "$target" ]]; then
    local existing
    existing="$(readlink "$target")"
    if [[ "$existing" != "$helper" ]]; then
      err "refusing to replace non-Vellum symlink: $target -> $existing"
      return 1
    fi
  fi
}

install_cli_link() {
  local name="$1"
  local helper="$2"
  local target="$BIN_DIR/$name"
  assert_cli_path "CLI link" "$target" "$BIN_DIR/$name" || return 1
  preflight_cli_link "$target" "$helper" || return 1
  # The helper path is stable across app swaps. An already-correct link needs no
  # mutation; an absent link is created with ln's exclusive create semantics.
  if [[ -L "$target" ]]; then
    return 0
  fi
  ln -s "$helper" "$target"
  if [[ ! -L "$target" || "$(readlink "$target")" != "$helper" ]]; then
    err "CLI link changed identity during creation: $target"
    return 1
  fi
}

install_cli_tools() {
  local work_helper="$APP_DST/Contents/Resources/bin/vellum"
  local browser_helper="$APP_DST/Contents/Resources/bin/vellum-browser"
  local station_helper="$APP_DST/Contents/Resources/bin/vellum-station"
  if [[
    ! -x "$work_helper" ||
    ! -x "$browser_helper" ||
    ! -x "$station_helper"
  ]]; then
    err "installed Vellum CLI helper missing or not executable"
    return 1
  fi
  ensure_scoped_directory "CLI directory" "$BIN_DIR"
  preflight_cli_link "$BIN_DIR/vellum" "$work_helper"
  preflight_cli_link "$BIN_DIR/vellum-browser" "$browser_helper"
  preflight_cli_link "$BIN_DIR/vellum-station" "$station_helper"
  install_cli_link "vellum" "$work_helper"
  install_cli_link "vellum-browser" "$browser_helper"
  install_cli_link "vellum-station" "$station_helper"
  log "commands → $BIN_DIR/{vellum,vellum-browser,vellum-station}"
}

audit_app_bundle() {
  local app="$1"
  bun "$SCRIPT_DIR/audit-packaged-app.ts" "$app"
}

assert_state_database_path() {
  local expected="$INSTALL_USER_ROOT/.vellum/state/vellum.db"
  if [[ "$STATE_DATABASE" != "$expected" ]]; then
    err "state database must remain under the fixed install root"
    return 1
  fi
  assert_no_symlink_components \
    "state database" \
    "$INSTALL_USER_ROOT" \
    "$STATE_DATABASE"
}

bind_state_update_source() {
  local identity
  assert_state_database_path || return 1
  if [[ -L "$STATE_DATABASE" ]]; then
    err "installed state source must not be a symlink"
    return 1
  fi
  if [[ -e "$STATE_DATABASE" ]]; then
    if [[ ! -f "$STATE_DATABASE" ]]; then
      err "installed state source must be a regular file"
      return 1
    fi
    identity="$(path_identity "$STATE_DATABASE")" || return 1
    if [[
      -z "$identity" ||
      -L "$STATE_DATABASE" ||
      ! -f "$STATE_DATABASE" ||
      "$(path_identity "$STATE_DATABASE" 2>/dev/null)" != "$identity"
    ]]; then
      err "installed state source changed identity while binding"
      return 1
    fi
    STATE_PREFLIGHT_SOURCE="installed"
    STATE_PREFLIGHT_DATABASE_ID="$identity"
  else
    if [[ -L "$STATE_DATABASE" || -e "$STATE_DATABASE" ]]; then
      err "fresh state source changed while binding"
      return 1
    fi
    STATE_PREFLIGHT_SOURCE="fresh"
    STATE_PREFLIGHT_DATABASE_ID=""
  fi
  assert_state_database_path
}

assert_state_update_source_unchanged() {
  local identity
  assert_state_database_path || return 1
  case "$STATE_PREFLIGHT_SOURCE" in
    fresh)
      if [[
        -n "$STATE_PREFLIGHT_DATABASE_ID" ||
        -e "$STATE_DATABASE" ||
        -L "$STATE_DATABASE"
      ]]; then
        err "fresh state source changed before activation"
        return 1
      fi
      ;;
    installed)
      if [[
        -z "$STATE_PREFLIGHT_DATABASE_ID" ||
        -L "$STATE_DATABASE" ||
        ! -f "$STATE_DATABASE"
      ]]; then
        err "installed state source changed before activation"
        return 1
      fi
      identity="$(path_identity "$STATE_DATABASE" 2>/dev/null)" || return 1
      if [[ "$identity" != "$STATE_PREFLIGHT_DATABASE_ID" ]]; then
        err "installed state source changed identity before activation"
        return 1
      fi
      ;;
    *)
      err "state update source has not been bound"
      return 1
      ;;
  esac
}

run_staged_state_update_preflight() {
  local executable="$STAGE/Contents/MacOS/$PRODUCT_NAME"
  local account_name temp_root bun_executable framed separator payload child_status receipt
  separator=$'\036'

  assert_install_transaction_capabilities || return 1
  assert_state_update_source_unchanged || return 1
  if [[ -n "$INSTALL_SANDBOX_ROOT" ]]; then
    err "state update preflight is unavailable in the filesystem-only install sandbox"
    return 1
  fi
  if [[
    -z "${STAGED_APP_ID:-}" ||
    -L "$STAGE" ||
    "$(path_identity "$STAGE" 2>/dev/null)" != "$STAGED_APP_ID"
  ]]; then
    err "staged app changed identity before state update preflight"
    return 1
  fi
  if [[ ! -f "$executable" || -L "$executable" || ! -x "$executable" ]]; then
    err "staged state update preflight executable is not a regular executable"
    return 1
  fi

  account_name="$(id -un)" || return 1
  temp_root="$(current_user_test_temp_root)" || return 1
  bun_executable="$(type -P bun || true)"
  if [[ -z "$bun_executable" || ! -x "$bun_executable" ]]; then
    err "Bun is required to validate the state update preflight receipt"
    return 1
  fi
  log "proving staged state update candidate"
  # Frame bounded supervisor stdout with its exit status so command
  # substitution cannot erase the distinction between exactly one receipt
  # line and extra output. The supervisor streams rather than accumulates
  # candidate output, caps it at the receipt limit, rejects any stderr, and
  # owns a detached process group that it terminates and reaps on every
  # failure. A clean environment denies Node/Electron/Bun loader and Vellum
  # test/demo controls; HOME and TMPDIR are re-derived from fixed OS facts.
  framed="$(
    set +e
    cd "$ACCOUNT_HOME" || exit 70
    /usr/bin/env -i \
      HOME="$ACCOUNT_HOME" \
      LOGNAME="$account_name" \
      PATH="/usr/bin:/bin" \
      PWD="$ACCOUNT_HOME" \
      TMPDIR="$temp_root" \
      USER="$account_name" \
      "$bun_executable" - "$executable" <<'VELLUM_STATE_PREFLIGHT_SUPERVISOR'
import { spawn } from "node:child_process";

const MAX_STDOUT_BYTES = 16 * 1024;
const HARD_TIMEOUT_MS = 60_000;
const TERMINATION_GRACE_MS = 1_000;
const GROUP_REAP_TIMEOUT_MS = 2_000;
const executable = process.argv[2];
const requiredEnvironment = ["HOME", "LOGNAME", "PATH", "PWD", "TMPDIR", "USER"];

if (
  process.argv.length !== 3 ||
  typeof executable !== "string" ||
  requiredEnvironment.some((name) => typeof process.env[name] !== "string")
) {
  console.error("vellum state preflight supervisor received invalid authority");
  process.exit(2);
}

const candidateEnvironment = Object.fromEntries(
  requiredEnvironment.map((name) => [name, process.env[name]]),
);
let child;
try {
  child = spawn(executable, ["--vellum-state-preflight"], {
    cwd: process.env.HOME,
    detached: true,
    env: candidateEnvironment,
    stdio: ["ignore", "pipe", "pipe"],
  });
} catch {
  console.error("vellum state preflight supervisor could not spawn candidate");
  process.exit(1);
}

if (
  typeof child.pid !== "number" ||
  child.stdout === null ||
  child.stderr === null
) {
  console.error("vellum state preflight supervisor did not bind an exact child");
  process.exit(1);
}

const exactPid = child.pid;
const stdoutChunks = [];
let stdoutBytes = 0;
let failure = undefined;
let terminationStarted = false;
let killTimer = undefined;

const ignoreMissingProcess = (error) =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "ESRCH";

const signalExactChildAndGroup = (signal) => {
  for (const target of [-exactPid, exactPid]) {
    try {
      process.kill(target, signal);
    } catch (error) {
      if (!ignoreMissingProcess(error)) throw error;
    }
  }
};

const groupIsAlive = () => {
  try {
    process.kill(-exactPid, 0);
    return true;
  } catch (error) {
    if (ignoreMissingProcess(error)) return false;
    return true;
  }
};

const beginTermination = (reason) => {
  if (failure === undefined) failure = reason;
  if (terminationStarted) return;
  terminationStarted = true;
  try {
    signalExactChildAndGroup("SIGTERM");
  } catch {
    failure = "signal-failure";
  }
  killTimer = setTimeout(() => {
    try {
      signalExactChildAndGroup("SIGKILL");
    } catch {
      failure = "signal-failure";
    }
  }, TERMINATION_GRACE_MS);
};

child.stdout.on("data", (chunk) => {
  const bytes = Buffer.from(chunk);
  if (failure !== undefined) return;
  if (stdoutBytes + bytes.byteLength > MAX_STDOUT_BYTES) {
    beginTermination("stdout-overflow");
    return;
  }
  stdoutChunks.push(bytes);
  stdoutBytes += bytes.byteLength;
});
child.stdout.on("error", () => beginTermination("stdout-read-failure"));
child.stderr.on("data", (chunk) => {
  if (Buffer.byteLength(chunk) > 0) beginTermination("stderr-output");
});
child.stderr.on("error", () => beginTermination("stderr-read-failure"));
child.on("error", () => beginTermination("spawn-failure"));

const hardTimeout = setTimeout(
  () => beginTermination("hard-timeout"),
  HARD_TIMEOUT_MS,
);
const closeResult = await new Promise((resolve) => {
  child.once("close", (code, signal) => resolve({ code, signal }));
});
clearTimeout(hardTimeout);
if (killTimer !== undefined) clearTimeout(killTimer);

if (groupIsAlive()) {
  beginTermination("descendant-survived");
  await new Promise((resolve) => setTimeout(resolve, TERMINATION_GRACE_MS));
  if (groupIsAlive()) {
    try {
      signalExactChildAndGroup("SIGKILL");
    } catch {
      failure = "signal-failure";
    }
  }
}

const groupReapDeadline = Date.now() + GROUP_REAP_TIMEOUT_MS;
while (groupIsAlive() && Date.now() < groupReapDeadline) {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

if (
  failure === undefined &&
  closeResult.code === 0 &&
  closeResult.signal === null &&
  !groupIsAlive()
) {
  process.stdout.write(Buffer.concat(stdoutChunks, stdoutBytes));
} else {
  console.error(
    `vellum state preflight supervisor failed: ${
      failure ?? "candidate-exit"
    }`,
  );
  process.exitCode = 1;
}
VELLUM_STATE_PREFLIGHT_SUPERVISOR
    child_status=$?
    printf '\036%s' "$child_status"
  )"

  if [[ "$framed" != *"$separator"* ]]; then
    err "staged state update preflight returned no bounded status"
    return 1
  fi
  payload="${framed%"$separator"*}"
  child_status="${framed##*"$separator"}"
  if [[
    "$payload" == *"$separator"* ||
    ! "$child_status" =~ ^[0-9]+$ ||
    "$child_status" -ne 0
  ]]; then
    err "staged state update preflight failed"
    return 1
  fi
  if [[ "$payload" != *$'\n' ]]; then
    err "staged state update preflight did not emit one receipt line"
    return 1
  fi
  receipt="${payload%$'\n'}"
  if ! printf '%s' "$receipt" | /usr/bin/env -i \
    HOME="$ACCOUNT_HOME" \
    PATH="/usr/bin:/bin" \
    TMPDIR="$temp_root" \
    "$bun_executable" \
    "$SCRIPT_DIR/state-update-preflight-receipt.ts"
  then
    err "staged state update preflight emitted an invalid receipt"
    return 1
  fi
  if ! printf '%s' "$receipt" | /usr/bin/env -i \
    HOME="$ACCOUNT_HOME" \
    PATH="/usr/bin:/bin" \
    TMPDIR="$temp_root" \
    "$bun_executable" -e '
const expectedSource = process.argv[1];
try {
  const receipt = JSON.parse(await Bun.stdin.text());
  if (
    process.argv.length !== 2 ||
    (expectedSource !== "fresh" && expectedSource !== "installed") ||
    receipt === null ||
    typeof receipt !== "object" ||
    receipt.source !== expectedSource
  ) {
    process.exitCode = 1;
  }
} catch {
  process.exitCode = 1;
}
' "$STATE_PREFLIGHT_SOURCE"
  then
    err "staged state update preflight source differs from the bound database"
    return 1
  fi
  if [[
    -L "$STAGE" ||
    "$(path_identity "$STAGE" 2>/dev/null)" != "$STAGED_APP_ID"
  ]]; then
    err "staged app changed identity during state update preflight"
    return 1
  fi
  assert_state_update_source_unchanged || return 1
  assert_install_transaction_capabilities || return 1
  printf '%s\n' "$receipt"
}

app_cdhash() {
  local app="$1"
  local metadata hash
  metadata="$(/usr/bin/codesign -d --verbose=4 "$app" 2>&1)"
  hash="$(printf '%s\n' "$metadata" | sed -n 's/^CDHash=//p')"
  if [[ ! "$hash" =~ ^[0-9A-Fa-f]{40,64}$ ]]; then
    err "invalid or ambiguous CDHash for $app"
    return 1
  fi
  printf '%s' "$hash"
}

if [[ "$SKIP_BUILD" -eq 0 ]]; then
  build_flags=()
  [[ "$FAST" -eq 1 ]] && build_flags+=(--fast)
  [[ "$VERIFY" -eq 1 ]] && build_flags+=(--verify)
  bash "$SCRIPT_DIR/build-app.sh" "${build_flags[@]+"${build_flags[@]}"}"
fi

assert_app_bundle "$APP_SRC"

log "auditing candidate → $APP_SRC"
audit_app_bundle "$APP_SRC"
CANDIDATE_CDHASH="$(app_cdhash "$APP_SRC")"

WORK_HELPER_TARGET="$APP_DST/Contents/Resources/bin/vellum"
BROWSER_HELPER_TARGET="$APP_DST/Contents/Resources/bin/vellum-browser"
STATION_HELPER_TARGET="$APP_DST/Contents/Resources/bin/vellum-station"
preflight_cli_link "$BIN_DIR/vellum" "$WORK_HELPER_TARGET"
preflight_cli_link "$BIN_DIR/vellum-browser" "$BROWSER_HELPER_TARGET"
preflight_cli_link "$BIN_DIR/vellum-station" "$STATION_HELPER_TARGET"

derive_install_transaction_paths "$$"
ACTIVATION_STARTED=0
CANDIDATE_PUBLISHED=0
CANDIDATE_MOVE_PENDING=0

resolve_candidate_publish() {
  if [[ "$CANDIDATE_MOVE_PENDING" -ne 1 ]]; then
    return 0
  fi
  if [[
    -d "$APP_DST" &&
    ! -L "$APP_DST" &&
    "$(path_identity "$APP_DST" 2>/dev/null)" == "${STAGED_APP_ID:-}"
  ]]; then
    CANDIDATE_PUBLISHED=1
    CANDIDATE_MOVE_PENDING=0
    return 0
  fi
  if [[
    -d "$STAGE" &&
    ! -L "$STAGE" &&
    "$(path_identity "$STAGE" 2>/dev/null)" == "${STAGED_APP_ID:-}"
  ]]; then
    CANDIDATE_MOVE_PENDING=0
    return 0
  fi
  err "cannot resolve candidate publication; explicit forward repair is required"
  return 1
}

cleanup_install() {
  local status=$?
  local cleanup_failed=0
  local retained_candidate=""
  trap - EXIT
  set +e
  if ! resolve_candidate_publish; then
    cleanup_failed=1
  fi
  if [[ "$ACTIVATION_STARTED" -eq 1 && "${APP_RETIREMENT_DISPOSABLE:-0}" -eq 1 ]] && ! safe_remove_app_retirement; then
    err "retiring app requires explicit disposal repair at $APP_RETIREMENT_ROOT"
    cleanup_failed=1
  fi
  if [[ "$status" -ne 0 && "$ACTIVATION_STARTED" -eq 0 && "$LAUNCHD_WAS_LOADED" -eq 1 ]] && ! resume_launchd_job; then
    err "failed to resume the pre-activation LaunchAgent"
    cleanup_failed=1
  fi
  if [[ "$status" -ne 0 && "$ACTIVATION_STARTED" -eq 0 && "$UNSUPERVISED_INCUMBENT_WAS_RUNNING" -eq 1 ]] && ! resume_unsupervised_incumbent; then
    err "failed to resume the unchanged pre-activation app"
    cleanup_failed=1
  fi
  if [[ "$ACTIVATION_STARTED" -eq 0 || "$CANDIDATE_PUBLISHED" -eq 1 ]]; then
    if ! safe_remove_install_stage; then
      err "refusing unsafe install stage cleanup"
      cleanup_failed=1
    fi
  fi
  if [[ "$cleanup_failed" -ne 0 && "$status" -eq 0 ]]; then
    status=1
  fi
  if [[ "$status" -ne 0 && "$ACTIVATION_STARTED" -eq 1 ]]; then
    if [[ "$CANDIDATE_PUBLISHED" -eq 1 ]]; then
      retained_candidate="$APP_DST"
    else
      retained_candidate="$STAGE"
    fi
    err "one-way activation requires forward repair; candidate retained at $retained_candidate"
  fi
  exit "$status"
}
trap cleanup_install EXIT

if [[ -e "$STAGE_ROOT" || -e "$APP_RETIREMENT_ROOT" || -L "$APP_RETIREMENT_ROOT" ]]; then
  err "refusing to reuse an existing install transaction path"
  exit 1
fi

log "staging → $STAGE"
assert_install_transaction_capabilities
mkdir -m 0700 "$STAGE_ROOT"
bind_install_stage
assert_install_transaction_capabilities
ditto --rsrc "$APP_SRC" "$STAGE"
assert_install_transaction_capabilities
assert_app_bundle "$STAGE"
log "auditing staged copy"
audit_app_bundle "$STAGE"
STAGED_CDHASH="$(app_cdhash "$STAGE")"
if [[ "$STAGED_CDHASH" != "$CANDIDATE_CDHASH" ]]; then
  err "staged app CDHash does not match the audited candidate"
  exit 1
fi
STAGED_APP_ID="$(path_identity "$STAGE")"

# Detach before binary swap: launchd unload + soft quit so before-quit runs
# and herdrStreams.detachAllOnQuit releases control (panes stay alive).
bind_state_update_source
bind_unsupervised_incumbent
unload_launchd
quit_running_app
if launchd_loaded || vellum_processes_running; then
  err "Vellum did not quiesce; refusing to replace the app"
  exit 1
fi
# Brief settle so control clients exit and release PTYs.
sleep 0.5

assert_install_transaction_capabilities
if ! run_staged_state_update_preflight; then
  err "candidate state readiness failed before activation"
  exit 1
fi
if launchd_loaded || vellum_processes_running; then
  err "Vellum resumed during state update preflight; activation remains unstarted"
  exit 1
fi
assert_install_transaction_capabilities

log "installing → $APP_DST"
assert_install_transaction_capabilities
CURRENT_APP_ID=""
if [[ -e "$APP_DST" ]]; then
  assert_app_destination_capability
  CURRENT_APP_ID="$(path_identity "$APP_DST")"
  assert_owned_current_app "$CURRENT_APP_ID"
fi

# This call revalidates the bound Vellum identity, crosses the one-way boundary,
# and directly removes that generation without caching it.
assert_state_update_source_unchanged
begin_one_way_app_cutover "$CURRENT_APP_ID"
assert_install_transaction_capabilities
CANDIDATE_MOVE_PENDING=1
publish_staged_app_candidate
CANDIDATE_PUBLISHED=1
CANDIDATE_MOVE_PENDING=0
if [[ "$(path_identity "$APP_DST" 2>/dev/null)" != "$STAGED_APP_ID" ]]; then
  err "staged app changed identity during install"
  exit 1
fi

assert_install_transaction_capabilities
assert_app_bundle "$APP_DST"
log "auditing installed copy"
audit_app_bundle "$APP_DST"
INSTALLED_CDHASH="$(app_cdhash "$APP_DST")"
if [[ "$INSTALLED_CDHASH" != "$CANDIDATE_CDHASH" ]]; then
  err "installed app CDHash does not match the audited candidate"
  exit 1
fi
install_cli_tools
log "installed $APP_DST"
log "installed CDHash $INSTALLED_CDHASH"

if [[ "$SUPERVISED" -eq 0 && "$LAUNCHD_WAS_LOADED" -eq 1 ]]; then
  resume_launchd_job
fi

if [[ "$SUPERVISED" -eq 1 ]]; then
  log "loading LaunchAgent (supervised) …"
  bash "$SCRIPT_DIR/install-launchd.sh" --skip-build
elif [[ "$OPEN" -eq 1 ]]; then
  log "opening $APP_DST"
  open "$APP_DST"
else
  log "done. open with: open \"$APP_DST\""
  log "optional supervised: bun run app:install:supervised"
fi
