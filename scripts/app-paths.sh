#!/usr/bin/env bash
# Shared paths/constants for Vellum packaging scripts. Source only — not executable alone.
# shellcheck shell=bash

read_config_value() {
  local variable="$1"
  local fallback="$2"
  local value
  if [[ -n "${!variable+x}" ]]; then
    value="${!variable}"
    if [[ -z "$value" ]]; then
      printf 'vellum: error: %s must not be empty\n' "$variable" >&2
      return 1
    fi
    printf '%s' "$value"
    return 0
  fi
  printf '%s' "$fallback"
}

LABEL="skastr0.vellum"
PRODUCT_NAME="Vellum Command"
APP_BUNDLE_ID="skastr0.vellum"

# Repo root = parent of scripts/
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"

# electron-builder macOS pack output (arm64 Mac primary). Zip lives beside this
# under release/Vellum-*-mac.zip — see package.json artifactName.
# Override with VELLUM_APP_SRC if packaging a different arch artifact.
detect_macos_app_src() {
  local candidates=(
    "$REPO_ROOT/release/mac-arm64/${PRODUCT_NAME}.app"
    "$REPO_ROOT/release/mac/${PRODUCT_NAME}.app"
    "$REPO_ROOT/release/mac-x64/${PRODUCT_NAME}.app"
  )
  local c
  for c in "${candidates[@]}"; do
    if [[ -d "$c" ]]; then
      printf '%s' "$c"
      return 0
    fi
  done
  # Prefer arm64 path for error messages on Apple Silicon.
  if [[ "$(uname -m)" == "arm64" ]]; then
    printf '%s' "$REPO_ROOT/release/mac-arm64/${PRODUCT_NAME}.app"
  else
    printf '%s' "$REPO_ROOT/release/mac/${PRODUCT_NAME}.app"
  fi
}

detect_app_src() {
  detect_macos_app_src
}

APP_SRC="$(read_config_value VELLUM_APP_SRC "$(detect_macos_app_src)")" || return 1
APP_DST=""
PLIST=""
LOG_DIR=""
BIN_DIR=""
ACCOUNT_HOME=""
INSTALL_USER_ROOT=""
INSTALL_SANDBOX_ROOT=""
APP_DST_PARENT=""
DOMAIN="gui/$(id -u)"
RELEASE_DIR="$(read_config_value VELLUM_RELEASE_DIR "$REPO_ROOT/release")" || return 1

log() { printf 'vellum: %s\n' "$*"; }
err() { printf 'vellum: error: %s\n' "$*" >&2; }

assert_bundle_identifier() {
  local name="$1"
  local value="$2"
  if [[ ${#value} -gt 255 || ! "$value" =~ ^[A-Za-z0-9][A-Za-z0-9-]*(\.[A-Za-z0-9][A-Za-z0-9-]*)+$ ]]; then
    err "$name is not a safe bundle-style identifier"
    return 1
  fi
}

assert_product_name() {
  local value="$1"
  if [[ ${#value} -gt 64 || ! "$value" =~ ^[A-Za-z]([A-Za-z0-9._\ -]*[A-Za-z0-9])?$ ]]; then
    err "VELLUM_PRODUCT_NAME contains unsafe characters"
    return 1
  fi
}

assert_no_identity_overrides() {
  local variable
  for variable in VELLUM_LAUNCHD_LABEL VELLUM_PRODUCT_NAME VELLUM_APP_ID; do
    if [[ -n "${!variable+x}" ]]; then
      err "$variable is not configurable; installer identities are fixed"
      return 1
    fi
  done
}

assert_no_identity_overrides || return 1
assert_bundle_identifier "VELLUM_LAUNCHD_LABEL" "$LABEL" || return 1
assert_bundle_identifier "VELLUM_APP_ID" "$APP_BUNDLE_ID" || return 1
assert_product_name "$PRODUCT_NAME" || return 1

assert_safe_absolute_path_text() {
  local description="$1"
  local value="$2"
  if [[ -z "$value" || "$value" != /* || "$value" == "/" ]]; then
    err "$description must be an absolute, non-root path"
    return 1
  fi
  if [[ "$value" == *//* || "$value" == */./* || "$value" == */../* || "$value" == */. || "$value" == */.. ]]; then
    err "$description must not contain unresolved path components"
    return 1
  fi
  if [[ "$value" =~ [^A-Za-z0-9._/\ -] ]]; then
    err "$description contains unsafe path characters"
    return 1
  fi
}

canonical_existing_directory() {
  local description="$1"
  local value="$2"
  local canonical
  assert_safe_absolute_path_text "$description" "$value" || return 1
  if [[ ! -d "$value" || -L "$value" ]]; then
    err "$description must be an existing, non-symlink directory: $value"
    return 1
  fi
  canonical="$(cd "$value" && pwd -P)" || return 1
  if [[ "$canonical" != "$value" ]]; then
    err "$description must already be canonical: $value -> $canonical"
    return 1
  fi
  printf '%s' "$canonical"
}

current_account_home() {
  local user account_home
  user="$(id -un)"
  if command -v dscl >/dev/null 2>&1; then
    account_home="$(dscl . -read "/Users/$user" NFSHomeDirectory 2>/dev/null | sed -n 's/^NFSHomeDirectory:[[:space:]]*//p')"
  elif command -v getent >/dev/null 2>&1; then
    account_home="$(getent passwd "$user" | awk -F: 'NR == 1 { print $6 }')"
  else
    err "cannot resolve the current account home without dscl or getent"
    return 1
  fi
  if [[ -z "$account_home" ]]; then
    err "cannot resolve the current account home for $user"
    return 1
  fi
  canonical_existing_directory "current account home" "$account_home"
}

assert_not_protected_root() {
  local description="$1"
  local value="$2"
  local protected
  for protected in "/" "$ACCOUNT_HOME" "$REPO_ROOT" "/Applications"; do
    if [[ -n "$protected" && "$value" == "$protected" ]]; then
      err "$description must not target protected root $protected"
      return 1
    fi
  done
}

assert_no_symlink_components() {
  local description="$1"
  local root="$2"
  local target="$3"
  local relative current component
  local components=()
  if [[ "$target" != "$root"/* ]]; then
    err "$description escapes its capability root"
    return 1
  fi
  relative="${target#"$root"/}"
  IFS='/' read -r -a components <<< "$relative"
  current="$root"
  for component in "${components[@]}"; do
    current="$current/$component"
    # The leaf may already be the symlink we own/replace (CLI links). Intermediate
    # symlink components remain forbidden — they escape the capability root.
    if [[ -L "$current" && "$current" != "$target" ]]; then
      err "$description crosses symlink component $current"
      return 1
    fi
    if [[ -e "$current" && ! -d "$current" && "$current" != "$target" ]]; then
      err "$description crosses non-directory component $current"
      return 1
    fi
  done
}

assert_exact_scoped_path() {
  local description="$1"
  local value="$2"
  local expected="$3"
  local root="$4"
  assert_safe_absolute_path_text "$description" "$value" || return 1
  if [[ "$value" != "$expected" ]]; then
    err "$description must be exactly $expected"
    return 1
  fi
  assert_no_symlink_components "$description" "$root" "$value"
}

assert_app_destination_capability() {
  local parent canonical_parent expected_basename expected_destination
  assert_safe_absolute_path_text "app destination" "$APP_DST" || return 1
  expected_basename="${PRODUCT_NAME}.app"
  if [[ "${APP_DST##*/}" != "$expected_basename" ]]; then
    err "app destination must end in the exact product bundle name $expected_basename"
    return 1
  fi
  parent="${APP_DST%/*}"
  canonical_parent="$(canonical_existing_directory "app destination parent" "$parent")" || return 1
  if [[ -n "$INSTALL_SANDBOX_ROOT" ]]; then
    expected_destination="$INSTALL_SANDBOX_ROOT/Applications/$expected_basename"
  else
    expected_destination="/Applications/$expected_basename"
  fi
  if [[ "$APP_DST" != "$expected_destination" ]]; then
    err "app destination must remain the fixed derived path $expected_destination"
    return 1
  fi
  if [[ -L "$APP_DST" || ( -e "$APP_DST" && ! -d "$APP_DST" ) ]]; then
    err "app destination must be absent or a non-symlink directory"
    return 1
  fi
  APP_DST_PARENT="$canonical_parent"
}

assert_installer_path_capabilities() {
  local sandbox_default app_default plist_default log_default bin_default
  local forbidden_override test_temp_root sandbox_name
  for forbidden_override in VELLUM_APP_DST VELLUM_PLIST VELLUM_LOG_DIR VELLUM_BIN_DIR; do
    if [[ -n "${!forbidden_override+x}" ]]; then
      err "$forbidden_override is not configurable; installer write targets are derived"
      return 1
    fi
  done
  assert_bundle_identifier "VELLUM_LAUNCHD_LABEL" "$LABEL" || return 1
  assert_bundle_identifier "VELLUM_APP_ID" "$APP_BUNDLE_ID" || return 1
  assert_product_name "$PRODUCT_NAME" || return 1

  ACCOUNT_HOME="$(current_account_home)" || return 1
  INSTALL_SANDBOX_ROOT=""
  if [[ -n "${VELLUM_INSTALL_SANDBOX_ROOT+x}" ]]; then
    if [[ -z "$VELLUM_INSTALL_SANDBOX_ROOT" ]]; then
      err "VELLUM_INSTALL_SANDBOX_ROOT must not be empty"
      return 1
    fi
    if [[ "${NODE_ENV:-}" != "test" ]]; then
      err "VELLUM_INSTALL_SANDBOX_ROOT is available only with NODE_ENV=test"
      return 1
    fi
    INSTALL_SANDBOX_ROOT="$(canonical_existing_directory "installer sandbox root" "$VELLUM_INSTALL_SANDBOX_ROOT")" || return 1
    assert_not_protected_root "installer sandbox root" "$INSTALL_SANDBOX_ROOT" || return 1
    test_temp_root="$(current_user_test_temp_root)" || return 1
    sandbox_name="${INSTALL_SANDBOX_ROOT##*/}"
    if [[ "${INSTALL_SANDBOX_ROOT%/*}" != "$test_temp_root" || ! "$sandbox_name" =~ ^vellum-install-test\.[A-Za-z0-9]{6,}$ ]]; then
      err "installer sandbox must be a dedicated Vellum directory under the OS user temporary root"
      return 1
    fi
    if [[ "$(path_owner_uid "$INSTALL_SANDBOX_ROOT")" != "$(id -u)" || "$(path_mode "$INSTALL_SANDBOX_ROOT")" != "700" ]]; then
      err "installer sandbox must be owned by the current user with mode 0700"
      return 1
    fi
    INSTALL_USER_ROOT="$INSTALL_SANDBOX_ROOT"
    sandbox_default="$INSTALL_SANDBOX_ROOT/Applications/${PRODUCT_NAME}.app"
  else
    INSTALL_USER_ROOT="$ACCOUNT_HOME"
    sandbox_default="/Applications/${PRODUCT_NAME}.app"
  fi

  app_default="$sandbox_default"
  plist_default="$INSTALL_USER_ROOT/Library/LaunchAgents/${LABEL}.plist"
  log_default="$INSTALL_USER_ROOT/Library/Logs/${PRODUCT_NAME}"
  bin_default="$INSTALL_USER_ROOT/.local/bin"
  APP_DST="$app_default"
  PLIST="$plist_default"
  LOG_DIR="$log_default"
  BIN_DIR="$bin_default"

  assert_app_destination_capability || return 1
  assert_exact_scoped_path "LaunchAgent plist" "$PLIST" "$plist_default" "$INSTALL_USER_ROOT" || return 1
  assert_exact_scoped_path "log directory" "$LOG_DIR" "$log_default" "$INSTALL_USER_ROOT" || return 1
  assert_exact_scoped_path "CLI directory" "$BIN_DIR" "$bin_default" "$INSTALL_USER_ROOT" || return 1
}

assert_scoped_directory_capability() {
  local description="$1"
  local path="$2"
  assert_no_symlink_components "$description" "$INSTALL_USER_ROOT" "$path" || return 1
  if [[ -e "$path" && ( ! -d "$path" || -L "$path" ) ]]; then
    err "$description must be a non-symlink directory"
    return 1
  fi
}

ensure_scoped_directory() {
  local description="$1"
  local path="$2"
  local canonical
  assert_scoped_directory_capability "$description" "$path" || return 1
  mkdir -p "$path"
  assert_scoped_directory_capability "$description" "$path" || return 1
  canonical="$(cd "$path" && pwd -P)" || return 1
  if [[ "$canonical" != "$path" ]]; then
    err "$description changed identity while it was being created"
    return 1
  fi
}

assert_safe_scoped_file() {
  local description="$1"
  local path="$2"
  local expected="$3"
  assert_exact_scoped_path "$description" "$path" "$expected" "$INSTALL_USER_ROOT" || return 1
  if [[ -L "$path" || ( -e "$path" && ! -f "$path" ) ]]; then
    err "$description must be absent or a non-symlink file"
    return 1
  fi
}

safe_remove_installer_file() {
  local kind="$1"
  local description path expected
  case "$kind" in
    plist)
      description="LaunchAgent plist"
      path="$PLIST"
      expected="$INSTALL_USER_ROOT/Library/LaunchAgents/${LABEL}.plist"
      ;;
    plist-stage)
      description="LaunchAgent plist stage"
      path="${PLIST}.new.$$"
      expected="$INSTALL_USER_ROOT/Library/LaunchAgents/${LABEL}.plist.new.$$"
      ;;
    plist-backup)
      description="LaunchAgent plist backup"
      path="${PLIST}.previous.$$"
      expected="$INSTALL_USER_ROOT/Library/LaunchAgents/${LABEL}.plist.previous.$$"
      ;;
    *)
      err "unknown installer file capability: $kind"
      return 1
      ;;
  esac
  assert_safe_scoped_file "$description" "$path" "$expected" || return 1
  rm -f "$path"
}

path_identity() {
  local path="$1"
  if [[ "$(uname -s)" == "Darwin" ]]; then
    stat -f '%d:%i' "$path"
  else
    stat -c '%d:%i' "$path"
  fi
}

path_owner_uid() {
  local path="$1"
  if [[ "$(uname -s)" == "Darwin" ]]; then
    stat -f '%u' "$path"
  else
    stat -c '%u' "$path"
  fi
}

path_mode() {
  local path="$1"
  if [[ "$(uname -s)" == "Darwin" ]]; then
    stat -f '%Lp' "$path"
  else
    stat -c '%a' "$path"
  fi
}

current_user_test_temp_root() {
  local raw
  if [[ "$(uname -s)" == "Darwin" ]]; then
    raw="$(getconf DARWIN_USER_TEMP_DIR 2>/dev/null || true)"
  else
    raw="/tmp"
  fi
  raw="${raw%/}"
  if [[ -z "$raw" || ! -d "$raw" ]]; then
    err "cannot resolve the OS user temporary directory"
    return 1
  fi
  (cd "$raw" && pwd -P)
}

assert_transaction_tree_path() {
  local description="$1"
  local value="$2"
  local expected="$3"
  local canonical
  assert_safe_absolute_path_text "$description" "$value" || return 1
  if [[ "$value" != "$expected" || "${value%/*}" != "$APP_DST_PARENT" ]]; then
    err "$description is not the transaction path derived from the app capability"
    return 1
  fi
  assert_not_protected_root "$description" "$value" || return 1
  if [[ -L "$value" || ( -e "$value" && ! -d "$value" ) ]]; then
    err "$description must be absent or a non-symlink directory"
    return 1
  fi
  if [[ -d "$value" ]]; then
    canonical="$(cd "$value" && pwd -P)" || return 1
    if [[ "$canonical" != "$value" ]]; then
      err "$description changed identity"
      return 1
    fi
  fi
}

assert_transaction_stage_app() {
  local expected="$STAGE_ROOT/${PRODUCT_NAME}.app"
  if [[ "$STAGE" != "$expected" ]]; then
    err "staged app path is not derived from the transaction root"
    return 1
  fi
  if [[ -L "$STAGE" || ( -e "$STAGE" && ! -d "$STAGE" ) ]]; then
    err "staged app must be absent or a non-symlink directory"
    return 1
  fi
}

derive_install_transaction_paths() {
  local transaction_id="$1"
  if [[ ! "$transaction_id" =~ ^[1-9][0-9]*$ ]]; then
    err "install transaction id must be a positive integer"
    return 1
  fi
  assert_app_destination_capability || return 1
  INSTALL_TRANSACTION_ID="$transaction_id"
  STAGE_ROOT="${APP_DST}.new.${INSTALL_TRANSACTION_ID}"
  STAGE="$STAGE_ROOT/${PRODUCT_NAME}.app"
  BACKUP="${APP_DST}.previous.${INSTALL_TRANSACTION_ID}"
  REJECTED="${APP_DST}.rejected.${INSTALL_TRANSACTION_ID}"
  STAGE_ROOT_ID=""
  BACKUP_ID=""
  REJECTED_ID=""
  assert_install_transaction_capabilities
}

bind_transaction_tree() {
  local kind="$1"
  local description value expected identity_variable
  local identity
  case "$kind" in
    stage)
      description="install stage root"
      value="$STAGE_ROOT"
      expected="${APP_DST}.new.${INSTALL_TRANSACTION_ID}"
      identity_variable="STAGE_ROOT_ID"
      ;;
    backup)
      description="install backup"
      value="$BACKUP"
      expected="${APP_DST}.previous.${INSTALL_TRANSACTION_ID}"
      identity_variable="BACKUP_ID"
      ;;
    rejected)
      description="rejected install"
      value="$REJECTED"
      expected="${APP_DST}.rejected.${INSTALL_TRANSACTION_ID}"
      identity_variable="REJECTED_ID"
      ;;
    *)
      err "unknown transaction capability: $kind"
      return 1
      ;;
  esac
  assert_transaction_tree_path "$description" "$value" "$expected" || return 1
  if [[ ! -d "$value" || -L "$value" ]]; then
    err "$description cannot be bound before its directory exists"
    return 1
  fi
  identity="$(path_identity "$value")" || return 1
  printf -v "$identity_variable" '%s' "$identity"
  if [[ "$(path_identity "$value")" != "$identity" ]]; then
    err "$description changed identity while it was being bound"
    return 1
  fi
}

assert_bound_transaction_tree() {
  local description="$1"
  local value="$2"
  local expected_identity="$3"
  if [[ ! -e "$value" && ! -L "$value" ]]; then
    return 0
  fi
  if [[ -z "$expected_identity" || -L "$value" || "$(path_identity "$value" 2>/dev/null)" != "$expected_identity" ]]; then
    err "$description is not the transaction directory Vellum created"
    return 1
  fi
}

assert_install_transaction_capabilities() {
  if [[ -z "${INSTALL_TRANSACTION_ID:-}" || ! "$INSTALL_TRANSACTION_ID" =~ ^[1-9][0-9]*$ ]]; then
    err "install transaction capability has not been derived"
    return 1
  fi
  assert_app_destination_capability || return 1
  assert_transaction_tree_path "install stage root" "$STAGE_ROOT" "${APP_DST}.new.${INSTALL_TRANSACTION_ID}" || return 1
  assert_transaction_tree_path "install backup" "$BACKUP" "${APP_DST}.previous.${INSTALL_TRANSACTION_ID}" || return 1
  assert_transaction_tree_path "rejected install" "$REJECTED" "${APP_DST}.rejected.${INSTALL_TRANSACTION_ID}" || return 1
  assert_bound_transaction_tree "install stage root" "$STAGE_ROOT" "${STAGE_ROOT_ID:-}" || return 1
  assert_bound_transaction_tree "install backup" "$BACKUP" "${BACKUP_ID:-}" || return 1
  assert_bound_transaction_tree "rejected install" "$REJECTED" "${REJECTED_ID:-}" || return 1
  assert_transaction_stage_app
}

safe_remove_transaction_tree() {
  local kind="$1"
  local description value expected expected_identity
  case "$kind" in
    stage)
      description="install stage root"
      value="$STAGE_ROOT"
      expected="${APP_DST}.new.${INSTALL_TRANSACTION_ID}"
      expected_identity="${STAGE_ROOT_ID:-}"
      ;;
    backup)
      description="install backup"
      value="$BACKUP"
      expected="${APP_DST}.previous.${INSTALL_TRANSACTION_ID}"
      expected_identity="${BACKUP_ID:-}"
      ;;
    rejected)
      description="rejected install"
      value="$REJECTED"
      expected="${APP_DST}.rejected.${INSTALL_TRANSACTION_ID}"
      expected_identity="${REJECTED_ID:-}"
      ;;
    *)
      err "unknown transaction cleanup capability: $kind"
      return 1
      ;;
  esac
  assert_app_destination_capability || return 1
  assert_transaction_tree_path "$description" "$value" "$expected" || return 1
  if [[ -e "$value" ]]; then
    assert_bound_transaction_tree "$description" "$value" "$expected_identity" || return 1
    rm -rf "$value"
  fi
}

# Prefer artifactName zip (Vellum-<ver>-arm64-mac.zip); else first *.zip under release/.
detect_release_zip() {
  local c
  # Bash: unmatched globs stay literal when nullglob is off — skip non-files.
  for c in "$RELEASE_DIR/${PRODUCT_NAME}-"*-mac.zip "$RELEASE_DIR/"*.zip; do
    if [[ -f "$c" ]]; then
      printf '%s' "$c"
      return 0
    fi
  done
  return 1
}

# True if a LaunchAgent for this label is loaded (any state).
launchd_loaded() {
  if [[ -n "$INSTALL_SANDBOX_ROOT" ]]; then
    return 1
  fi
  launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1
}

unload_launchd() {
  if [[ -n "$INSTALL_SANDBOX_ROOT" ]]; then
    return 0
  fi
  if ! launchd_loaded; then
    return 0
  fi
  log "unloading LaunchAgent $LABEL …"
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  # bootout returns before the job fully drains; swapping the binary under a
  # still-exiting process is unsafe. Wait for disappearance.
  local i
  for i in $(seq 1 30); do
    launchd_loaded || return 0
    sleep 0.5
  done
  err "$LABEL still loaded after 15s; refusing to replace the app"
  return 1
}

vellum_processes_running() {
  if [[ -n "$INSTALL_SANDBOX_ROOT" ]]; then
    return 1
  fi
  pgrep -xq "$PRODUCT_NAME" 2>/dev/null ||
    pgrep -f "${APP_DST}/" >/dev/null 2>&1
}

# Soft-quit any unsupervised Dock/Finder instances (not launchd — use unload).
quit_running_app() {
  if [[ -n "$INSTALL_SANDBOX_ROOT" ]]; then
    return 0
  fi
  if vellum_processes_running; then
    log "quitting running ${PRODUCT_NAME} (osascript) …"
    osascript -e "tell application \"${PRODUCT_NAME}\" to quit" 2>/dev/null || true
    local i
    for i in $(seq 1 20); do
      vellum_processes_running || return 0
      sleep 0.5
    done
    err "${PRODUCT_NAME} processes remain after 10s; refusing to replace the app"
    return 1
  fi
  return 0
}

# Validate a .app bundle looks installable.
assert_app_bundle() {
  local app="${1:-$APP_SRC}"
  [[ -d "$app" ]] || { err "missing app bundle: $app"; return 1; }
  [[ -x "$app/Contents/MacOS/${PRODUCT_NAME}" ]] || {
    err "missing executable: $app/Contents/MacOS/${PRODUCT_NAME}"
    return 1
  }
  [[ -f "$app/Contents/Info.plist" ]] || {
    err "missing Info.plist in $app"
    return 1
  }
  local id
  id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Contents/Info.plist" 2>/dev/null || true)"
  if [[ "$id" != "$APP_BUNDLE_ID" ]]; then
    err "bundle id mismatch: got $id want $APP_BUNDLE_ID"
    return 1
  fi
  return 0
}
