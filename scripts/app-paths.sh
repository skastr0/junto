#!/usr/bin/env bash
# Shared paths/constants for Vellum Command packaging scripts. Source only — not executable alone.
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

LABEL="skastr0.vellumcommand"
PRODUCT_NAME="Vellum Command"
APP_BUNDLE_ID="skastr0.vellumcommand"
APP_SIGNING_REQUIREMENT='=anchor apple generic and identifier "skastr0.vellumcommand" and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "EXAMP12345"'

# Repo root = parent of scripts/
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"

# electron-builder macOS pack output (arm64 Mac primary). Zip lives beside this
# under release/Vellum Command-*-mac.zip — see package.json artifactName.
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
      err "installer sandbox must be a dedicated Vellum Command directory under the OS user temporary root"
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

assert_owned_launchd_plist() {
  local expected_identity="$1"
  local expected_path="$INSTALL_USER_ROOT/Library/LaunchAgents/${LABEL}.plist"
  local observed_identity plist_label plist_program
  if [[ ! "$expected_identity" =~ ^[0-9]+:[0-9]+$ ]]; then
    err "LaunchAgent ownership check requires a bound filesystem identity"
    return 1
  fi
  assert_safe_scoped_file "LaunchAgent plist" "$PLIST" "$expected_path" || return 1
  observed_identity="$(path_identity "$PLIST")" || return 1
  if [[ "$observed_identity" != "$expected_identity" ]]; then
    err "LaunchAgent plist changed identity before one-way activation"
    return 1
  fi
  plist_label="$(/usr/libexec/PlistBuddy -c 'Print :Label' "$PLIST" 2>/dev/null || true)"
  plist_program="$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:0' "$PLIST" 2>/dev/null || true)"
  if [[ "$plist_label" != "$LABEL" || "$plist_program" != "$APP_DST/Contents/MacOS/${PRODUCT_NAME}" ]]; then
    err "existing LaunchAgent plist is not owned by Vellum Command"
    return 1
  fi
  if /usr/libexec/PlistBuddy -c 'Print :ProgramArguments:1' "$PLIST" >/dev/null 2>&1; then
    err "existing LaunchAgent plist has unexpected program arguments"
    return 1
  fi
  if [[ "$(path_identity "$PLIST" 2>/dev/null)" != "$expected_identity" ]]; then
    err "LaunchAgent plist changed identity during ownership validation"
    return 1
  fi
}

assert_launchd_retirement_root() {
  local expected="$INSTALL_USER_ROOT/Library/LaunchAgents/${LABEL}.plist.retired.$$"
  if [[ "${PLIST_RETIREMENT_ROOT:-}" != "$expected" ]]; then
    err "retiring LaunchAgent root is not the process-bound transaction path"
    return 1
  fi
  assert_exact_scoped_path \
    "retiring LaunchAgent root" \
    "$PLIST_RETIREMENT_ROOT" \
    "$expected" \
    "$INSTALL_USER_ROOT" || return 1
  if [[ -L "$PLIST_RETIREMENT_ROOT" || ( -e "$PLIST_RETIREMENT_ROOT" && ! -d "$PLIST_RETIREMENT_ROOT" ) ]]; then
    err "retiring LaunchAgent root must be absent or a non-symlink directory"
    return 1
  fi
}

bind_launchd_retirement_root() {
  assert_launchd_retirement_root || return 1
  if [[ -e "$PLIST_RETIREMENT_ROOT" || -L "$PLIST_RETIREMENT_ROOT" ]]; then
    err "refusing to reuse the retiring LaunchAgent root"
    return 1
  fi
  /bin/mkdir -m 0700 "$PLIST_RETIREMENT_ROOT" || return 1
  PLIST_RETIREMENT_ROOT_ID="$(path_identity "$PLIST_RETIREMENT_ROOT")" || return 1
  if [[ "$(path_identity "$PLIST_RETIREMENT_ROOT" 2>/dev/null)" != "$PLIST_RETIREMENT_ROOT_ID" ]]; then
    err "retiring LaunchAgent root changed identity while binding"
    return 1
  fi
  RETIRED_PLIST="$PLIST_RETIREMENT_ROOT/${LABEL}.plist"
}

safe_remove_launchd_retirement() {
  assert_launchd_retirement_root || return 1
  if [[ -e "$PLIST_RETIREMENT_ROOT" || -L "$PLIST_RETIREMENT_ROOT" ]]; then
    if [[ -z "${PLIST_RETIREMENT_ROOT_ID:-}" || -L "$PLIST_RETIREMENT_ROOT" || "$(path_identity "$PLIST_RETIREMENT_ROOT" 2>/dev/null)" != "$PLIST_RETIREMENT_ROOT_ID" ]]; then
      err "retiring LaunchAgent root is not the directory Vellum Command created"
      return 1
    fi
    if [[ -e "$RETIRED_PLIST" || -L "$RETIRED_PLIST" ]]; then
      if [[
        "${PLIST_RETIREMENT_DISPOSABLE:-0}" -ne 1 ||
        -z "${RETIRED_PLIST_ID:-}" ||
        -L "$RETIRED_PLIST" ||
        "$(path_identity "$RETIRED_PLIST" 2>/dev/null)" != "$RETIRED_PLIST_ID"
      ]]; then
        err "retiring LaunchAgent plist is not the exact admitted Vellum Command plist"
        return 1
      fi
      /bin/rm -f "$RETIRED_PLIST"
    fi
    if [[ -e "$RETIRED_PLIST" || -L "$RETIRED_PLIST" ]]; then
      err "retiring LaunchAgent plist disposal did not complete"
      return 1
    fi
    /bin/rmdir "$PLIST_RETIREMENT_ROOT" || {
      err "retiring LaunchAgent root is not empty after exact disposal"
      return 1
    }
  fi
  if [[ -e "$PLIST_RETIREMENT_ROOT" || -L "$PLIST_RETIREMENT_ROOT" ]]; then
    err "retiring LaunchAgent disposal did not complete"
    return 1
  fi
}

safe_remove_launchd_stage() {
  local stage="${PLIST}.new.$$"
  assert_safe_scoped_file \
    "LaunchAgent plist stage" \
    "$stage" \
    "$INSTALL_USER_ROOT/Library/LaunchAgents/${LABEL}.plist.new.$$" || return 1
  /bin/rm -f "$stage"
}

publish_launchd_candidate() {
  local expected_stage_identity="$1"
  local expected_stage="${PLIST}.new.$$"
  assert_safe_scoped_file \
    "LaunchAgent plist stage" \
    "$PLIST_STAGE" \
    "$INSTALL_USER_ROOT/Library/LaunchAgents/${LABEL}.plist.new.$$" || return 1
  if [[
    "$PLIST_STAGE" != "$expected_stage" ||
    -z "$expected_stage_identity" ||
    "$(path_identity "$PLIST_STAGE" 2>/dev/null)" != "$expected_stage_identity"
  ]]; then
    err "LaunchAgent plist stage changed identity before publication"
    return 1
  fi
  assert_safe_scoped_file \
    "LaunchAgent plist" \
    "$PLIST" \
    "$INSTALL_USER_ROOT/Library/LaunchAgents/${LABEL}.plist" || return 1
  if [[ -e "$PLIST" || -L "$PLIST" ]]; then
    err "LaunchAgent plist destination became occupied before candidate publication"
    return 1
  fi
  if ! /bin/ln "$PLIST_STAGE" "$PLIST"; then
    err "exclusive LaunchAgent candidate publication failed"
    return 1
  fi
  if [[ -L "$PLIST" || "$(path_identity "$PLIST" 2>/dev/null)" != "$expected_stage_identity" ]]; then
    err "published LaunchAgent plist identity is indeterminate"
    return 1
  fi
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
  APP_RETIREMENT_ROOT="${APP_DST}.retired.${INSTALL_TRANSACTION_ID}"
  RETIRED_APP="$APP_RETIREMENT_ROOT/${PRODUCT_NAME}.app"
  STAGE_ROOT_ID=""
  APP_RETIREMENT_ROOT_ID=""
  RETIRED_APP_ID=""
  APP_RETIREMENT_DISPOSABLE=0
  assert_install_transaction_capabilities
}

bind_install_stage() {
  local identity
  assert_transaction_tree_path "install stage root" "$STAGE_ROOT" "${APP_DST}.new.${INSTALL_TRANSACTION_ID}" || return 1
  if [[ ! -d "$STAGE_ROOT" || -L "$STAGE_ROOT" ]]; then
    err "install stage root cannot be bound before its directory exists"
    return 1
  fi
  identity="$(path_identity "$STAGE_ROOT")" || return 1
  STAGE_ROOT_ID="$identity"
  if [[ "$(path_identity "$STAGE_ROOT")" != "$identity" ]]; then
    err "install stage root changed identity while it was being bound"
    return 1
  fi
}

assert_bound_install_stage() {
  if [[ ! -e "$STAGE_ROOT" && ! -L "$STAGE_ROOT" ]]; then
    return 0
  fi
  if [[ -z "${STAGE_ROOT_ID:-}" || -L "$STAGE_ROOT" || "$(path_identity "$STAGE_ROOT" 2>/dev/null)" != "$STAGE_ROOT_ID" ]]; then
    err "install stage root is not the transaction directory Vellum Command created"
    return 1
  fi
}

assert_bound_app_retirement() {
  if [[ ! -e "$APP_RETIREMENT_ROOT" && ! -L "$APP_RETIREMENT_ROOT" ]]; then
    return 0
  fi
  if [[ -z "${APP_RETIREMENT_ROOT_ID:-}" || -L "$APP_RETIREMENT_ROOT" || "$(path_identity "$APP_RETIREMENT_ROOT" 2>/dev/null)" != "$APP_RETIREMENT_ROOT_ID" ]]; then
    err "retiring app root is not the directory Vellum Command created"
    return 1
  fi
}

bind_app_retirement_root() {
  assert_transaction_tree_path "retiring app root" "$APP_RETIREMENT_ROOT" "${APP_DST}.retired.${INSTALL_TRANSACTION_ID}" || return 1
  if [[ -e "$APP_RETIREMENT_ROOT" || -L "$APP_RETIREMENT_ROOT" ]]; then
    err "refusing to reuse the retiring app root"
    return 1
  fi
  /bin/mkdir -m 0700 "$APP_RETIREMENT_ROOT" || return 1
  APP_RETIREMENT_ROOT_ID="$(path_identity "$APP_RETIREMENT_ROOT")" || return 1
  if [[ "$(path_identity "$APP_RETIREMENT_ROOT" 2>/dev/null)" != "$APP_RETIREMENT_ROOT_ID" ]]; then
    err "retiring app root changed identity while binding"
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
  assert_transaction_tree_path "retiring app root" "$APP_RETIREMENT_ROOT" "${APP_DST}.retired.${INSTALL_TRANSACTION_ID}" || return 1
  assert_bound_install_stage || return 1
  assert_bound_app_retirement || return 1
  assert_transaction_stage_app
}

safe_remove_install_stage() {
  assert_app_destination_capability || return 1
  assert_transaction_tree_path "install stage root" "$STAGE_ROOT" "${APP_DST}.new.${INSTALL_TRANSACTION_ID}" || return 1
  if [[ -e "$STAGE_ROOT" ]]; then
    assert_bound_install_stage || return 1
    /bin/rm -rf "$STAGE_ROOT"
  fi
}

safe_remove_app_retirement() {
  assert_app_destination_capability || return 1
  assert_transaction_tree_path "retiring app root" "$APP_RETIREMENT_ROOT" "${APP_DST}.retired.${INSTALL_TRANSACTION_ID}" || return 1
  if [[ -e "$APP_RETIREMENT_ROOT" || -L "$APP_RETIREMENT_ROOT" ]]; then
    assert_bound_app_retirement || return 1
    if [[ -e "$RETIRED_APP" || -L "$RETIRED_APP" ]]; then
      if [[
        "${APP_RETIREMENT_DISPOSABLE:-0}" -ne 1 ||
        -z "${RETIRED_APP_ID:-}" ||
        -L "$RETIRED_APP" ||
        "$(path_identity "$RETIRED_APP" 2>/dev/null)" != "$RETIRED_APP_ID"
      ]]; then
        err "retiring app is not the exact admitted Vellum Command generation"
        return 1
      fi
      /bin/rm -rf -- "$RETIRED_APP"
    fi
    if [[ -e "$RETIRED_APP" || -L "$RETIRED_APP" ]]; then
      err "retiring app disposal did not complete"
      return 1
    fi
    /bin/rmdir "$APP_RETIREMENT_ROOT" || {
      err "retiring app root is not empty after exact disposal"
      return 1
    }
  fi
  if [[ -e "$APP_RETIREMENT_ROOT" || -L "$APP_RETIREMENT_ROOT" ]]; then
    err "retiring app disposal did not complete"
    return 1
  fi
}

assert_owned_current_app() {
  local expected_identity="$1"
  local observed_identity plist_executable
  assert_app_destination_capability || return 1
  if [[ ! "$expected_identity" =~ ^[0-9]+:[0-9]+$ ]]; then
    err "current app ownership check requires a bound filesystem identity"
    return 1
  fi
  if [[ ! -d "$APP_DST" || -L "$APP_DST" ]]; then
    err "current app is not an owned Vellum Command bundle"
    return 1
  fi
  observed_identity="$(path_identity "$APP_DST")" || return 1
  if [[ "$observed_identity" != "$expected_identity" ]]; then
    err "current app changed identity before one-way activation"
    return 1
  fi
  assert_app_bundle "$APP_DST" || {
    err "current app is not an owned Vellum Command bundle"
    return 1
  }
  plist_executable="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP_DST/Contents/Info.plist" 2>/dev/null || true)"
  if [[ "$plist_executable" != "$PRODUCT_NAME" ]]; then
    err "current app executable identity does not match Vellum Command"
    return 1
  fi
  if ! /usr/bin/codesign --verify --deep --strict --verbose=2 -R "$APP_SIGNING_REQUIREMENT" "$APP_DST" >/dev/null 2>&1; then
    err "current app does not satisfy the accepted Vellum Command signing requirement"
    return 1
  fi
  if [[ "$(path_identity "$APP_DST" 2>/dev/null)" != "$expected_identity" ]]; then
    err "current app changed identity during ownership validation"
    return 1
  fi
}

begin_one_way_app_cutover() {
  local expected_identity="$1"
  if [[ "${ACTIVATION_STARTED:-0}" -ne 0 ]]; then
    err "one-way app activation has already started"
    return 1
  fi
  if [[ -n "$expected_identity" ]]; then
    assert_owned_current_app "$expected_identity" || return 1
  else
    assert_app_destination_capability || return 1
    if [[ -e "$APP_DST" || -L "$APP_DST" ]]; then
      err "current app appeared after preflight"
      return 1
    fi
  fi
  if [[ -n "$expected_identity" ]]; then
    bind_app_retirement_root || return 1
  elif [[ -e "$APP_RETIREMENT_ROOT" || -L "$APP_RETIREMENT_ROOT" ]]; then
    err "refusing to reuse the retiring app root"
    return 1
  fi

  # No failure after this assignment may select an older bundle.
  ACTIVATION_STARTED=1
  if [[ -z "$expected_identity" ]]; then
    return 0
  fi
  if [[ "$(path_identity "$APP_DST" 2>/dev/null)" != "$expected_identity" ]]; then
    err "current app changed identity at the one-way boundary"
    return 1
  fi
  RETIRED_APP_ID="$expected_identity"
  /bin/mv -n "$APP_DST" "$APP_RETIREMENT_ROOT/"
  if [[ -L "$RETIRED_APP" || "$(path_identity "$RETIRED_APP" 2>/dev/null)" != "$RETIRED_APP_ID" ]]; then
    err "retiring app identity does not match the admitted Vellum Command generation"
    return 1
  fi
  APP_RETIREMENT_DISPOSABLE=1
  safe_remove_app_retirement || return 1
  APP_RETIREMENT_ROOT_ID=""
  RETIRED_APP_ID=""
  APP_RETIREMENT_DISPOSABLE=0
}

publish_staged_app_candidate() {
  assert_install_transaction_capabilities || return 1
  if [[ -e "$APP_DST" || -L "$APP_DST" ]]; then
    err "app destination became occupied before candidate publication"
    return 1
  fi
  if [[ -z "${STAGED_APP_ID:-}" || -L "$STAGE" || "$(path_identity "$STAGE" 2>/dev/null)" != "$STAGED_APP_ID" ]]; then
    err "staged app changed identity before candidate publication"
    return 1
  fi
  /bin/mv -n "$STAGE" "$APP_DST_PARENT/"
  if [[ -d "$APP_DST" && ! -L "$APP_DST" && "$(path_identity "$APP_DST" 2>/dev/null)" == "$STAGED_APP_ID" ]]; then
    return 0
  fi
  if [[ -d "$STAGE" && ! -L "$STAGE" && "$(path_identity "$STAGE" 2>/dev/null)" == "$STAGED_APP_ID" ]]; then
    err "exclusive candidate publication refused an occupied app destination"
    return 1
  fi
  err "candidate publication identity is indeterminate"
  return 1
}

# Prefer zip matching the packaged app version (Vellum-Command-<ver>-*-mac.zip).
# Never return an arbitrary first glob hit — stale 0.1.0 next to 0.1.1 caused
# notarize to submit the wrong archive and staple to fail.
detect_release_zip() {
  local app version preferred c newest="" newest_mtime=0 mtime
  app="$(detect_macos_app_src 2>/dev/null || true)"
  if [[ -n "$app" && -d "$app" ]]; then
    version="$(
      /usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' \
        "$app/Contents/Info.plist" 2>/dev/null || true
    )"
  fi
  if [[ -n "$version" ]]; then
    for preferred in \
      "$RELEASE_DIR/Vellum-Command-${version}-arm64-mac.zip" \
      "$RELEASE_DIR/Vellum-Command-${version}-mac.zip" \
      "$RELEASE_DIR/${PRODUCT_NAME}-${version}-arm64-mac.zip" \
      "$RELEASE_DIR/${PRODUCT_NAME}-${version}-mac.zip"
    do
      if [[ -f "$preferred" && ! -L "$preferred" ]]; then
        printf '%s' "$preferred"
        return 0
      fi
    done
  fi
  # Fallback: newest matching release zip by mtime.
  shopt -s nullglob
  for c in \
    "$RELEASE_DIR"/Vellum-Command-*-mac.zip \
    "$RELEASE_DIR/${PRODUCT_NAME}-"*-mac.zip
  do
    [[ -f "$c" && ! -L "$c" ]] || continue
    mtime="$(stat -f '%m' "$c" 2>/dev/null || echo 0)"
    if (( mtime >= newest_mtime )); then
      newest_mtime=$mtime
      newest="$c"
    fi
  done
  shopt -u nullglob
  if [[ -n "$newest" ]]; then
    printf '%s' "$newest"
    return 0
  fi
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
