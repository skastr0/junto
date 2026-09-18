#!/usr/bin/env bash
# Install every agent harness Junto can seat, then report which of them can
# authenticate in this orb.
#
# The harness set is the closed `HarnessId` literal in
# src/shared/managed-terminal-templates.ts: 15 ids, 14 external CLIs plus the
# repo's own `junto-overseer`. Each entry below names the harness, the binary
# its template resolves, and the vendor's own install path. Nothing here
# writes harness config or credentials: those belong to the operator, and this
# script only reports which ones are present.
#
# Idempotent: a harness whose binary already resolves is left alone. One
# harness failing never fails orb setup; the summary at the end says which.
set -uo pipefail

export PATH="$HOME/.local/bin:$HOME/.amp/bin:$PATH"

INSTALL_TIMEOUT_SECONDS="${JUNTO_HARNESS_INSTALL_TIMEOUT:-900}"
LOG_DIR="${JUNTO_HARNESS_LOG_DIR:-/tmp}"

# ── Install primitives ─────────────────────────────────────────────────────

# Vendor installers are `curl … | bash` one-liners. Fetch first so a failed
# download is a failure instead of an empty stdin that exits 0.
run_installer() {
  local url="$1"
  shift
  local script status
  script="$(mktemp)"
  if ! curl -fsSL "$url" -o "$script"; then
    printf 'download failed: %s\n' "$url" >&2
    rm -f "$script"
    return 1
  fi
  bash "$script" "$@"
  status=$?
  rm -f "$script"
  return $status
}

install_npm_package() {
  npm install -g --no-fund --no-audit "$1"
}

# ── Harness table ──────────────────────────────────────────────────────────

HARNESS_IDS=(
  claude
  codex
  grok
  hermes
  pi
  prime-agent
  kimi
  muse
  devin
  cursor
  agy
  amp
  fx
  omp
)

harness_binary() {
  case "$1" in
    claude) printf 'claude' ;;
    codex) printf 'codex' ;;
    grok) printf 'grok' ;;
    hermes) printf 'hermes' ;;
    pi) printf 'pi' ;;
    prime-agent) printf 'prime-agent' ;;
    kimi) printf 'kimi' ;;
    muse) printf 'muse' ;;
    devin) printf 'devin' ;;
    cursor) printf 'agent' ;;
    agy) printf 'agy' ;;
    amp) printf 'amp' ;;
    fx) printf 'fx' ;;
    omp) printf 'omp' ;;
    *) return 1 ;;
  esac
}

harness_source() {
  case "$1" in
    claude) printf 'npm @anthropic-ai/claude-code' ;;
    codex) printf 'npm @openai/codex' ;;
    grok) printf 'x.ai/cli/install.sh' ;;
    hermes) printf 'hermes-agent.nousresearch.com/install.sh' ;;
    pi) printf 'npm @earendil-works/pi-coding-agent' ;;
    prime-agent) printf 'app.primeintellect.ai/prime-agent/install.sh' ;;
    kimi) printf 'npm @moonshot-ai/kimi-code' ;;
    muse) printf 'dev.meta.ai/install.sh' ;;
    devin) printf 'cli.devin.ai/install.sh' ;;
    cursor) printf 'cursor.com/install' ;;
    agy) printf 'antigravity.google/cli/install.sh' ;;
    amp) printf 'orb-provided' ;;
    fx) printf 'fx.sh/setup.sh' ;;
    omp) printf 'omp.sh/install --binary' ;;
    *) return 1 ;;
  esac
}

harness_install() {
  case "$1" in
    claude) install_npm_package "@anthropic-ai/claude-code@latest" ;;
    codex) install_npm_package "@openai/codex@latest" ;;
    grok) run_installer "https://x.ai/cli/install.sh" ;;
    hermes) run_installer "https://hermes-agent.nousresearch.com/install.sh" ;;
    pi) install_npm_package "@earendil-works/pi-coding-agent@latest" ;;
    prime-agent) run_installer "https://app.primeintellect.ai/prime-agent/install.sh" ;;
    kimi) install_npm_package "@moonshot-ai/kimi-code@latest" ;;
    muse) run_installer "https://dev.meta.ai/install.sh" ;;
    devin) run_installer "https://cli.devin.ai/install.sh" ;;
    cursor) run_installer "https://cursor.com/install" ;;
    agy) run_installer "https://antigravity.google/cli/install.sh" ;;
    amp) return 0 ;;
    fx) run_installer "https://fx.sh/setup.sh" ;;
    # The default omp path builds from source with bun >= 1.3.14; this repo
    # pins bun 1.3.13, so take the prebuilt binary instead.
    omp) run_installer "https://omp.sh/install" --binary ;;
    *) return 1 ;;
  esac
}

# A harness binary can land outside the directories the orb PATH already
# carries, and one vendor installer can claim a name another harness owns.
# Grok's installer links `agent` as an alias for itself, and `agent` is the
# Cursor Agent binary this repo's cursor template resolves, so a grok-only
# orb would seat Cursor with Grok's CLI. Reject that resolution by identity.
resolve_binary() {
  local binary="$1" found candidate
  found="$(command -v "$binary" 2>/dev/null || true)"
  if [[ -n "$found" ]]; then
    printf '%s' "$found"
    return 0
  fi
  for candidate in \
    "$HOME/.kimi-code/bin/$binary" \
    "$HOME/.local/bin/$binary" \
    "$HOME/.amp/bin/$binary" \
    "/usr/local/bin/$binary"; do
    if [[ -x "$candidate" ]]; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

harness_binary_is_foreign() {
  local harness="$1" resolved="$2"
  case "$harness" in
    cursor)
      case "$(readlink -f "$resolved" 2>/dev/null)" in
        "$HOME/.grok/"*) return 0 ;;
      esac
      ;;
  esac
  return 1
}

harness_resolved() {
  local harness="$1" binary resolved
  binary="$(harness_binary "$harness")"
  resolved="$(resolve_binary "$binary")" || return 1
  harness_binary_is_foreign "$harness" "$resolved" && return 1
  printf '%s' "$resolved"
}

# ── Credential table ───────────────────────────────────────────────────────
#
# What each harness reads to authenticate without a browser. Env vars are the
# orb's own; the file paths are where the harness caches a completed login.
# Provider-agnostic harnesses (pi, omp, prime-agent, hermes) accept any of the
# model-provider keys their catalogs carry, so the check names the common ones.

harness_credential_env() {
  case "$1" in
    claude) printf 'CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY' ;;
    codex) printf 'OPENAI_API_KEY' ;;
    grok) printf 'XAI_API_KEY' ;;
    hermes) printf 'ANTHROPIC_API_KEY OPENAI_API_KEY GEMINI_API_KEY OPENROUTER_API_KEY' ;;
    pi) printf 'ANTHROPIC_API_KEY OPENAI_API_KEY GEMINI_API_KEY XAI_API_KEY OPENROUTER_API_KEY MOONSHOT_API_KEY' ;;
    prime-agent) printf 'ANTHROPIC_API_KEY OPENAI_API_KEY GEMINI_API_KEY OPENROUTER_API_KEY' ;;
    kimi) printf 'KIMI_API_KEY MOONSHOT_API_KEY ANTHROPIC_API_KEY OPENAI_API_KEY' ;;
    muse) printf 'META_API_KEY ANTHROPIC_API_KEY OPENAI_API_KEY OPENROUTER_API_KEY' ;;
    devin) printf 'WINDSURF_API_KEY OPENAI_API_KEY' ;;
    cursor) printf 'CURSOR_API_KEY' ;;
    agy) printf 'GEMINI_API_KEY GOOGLE_API_KEY' ;;
    amp) printf 'AMP_API_KEY' ;;
    fx) printf 'AI_GATEWAY_API_KEY ANTHROPIC_API_KEY OPENAI_API_KEY' ;;
    omp) printf 'ANTHROPIC_API_KEY OPENAI_API_KEY GEMINI_API_KEY XAI_API_KEY OPENROUTER_API_KEY' ;;
    *) return 1 ;;
  esac
}

# Files that hold a completed login. Only the ones whose mere existence is the
# credential are listed: Cursor's `cli-config.json` and Hermes' `.env` are
# written by their installers for preferences, so presence there proves
# nothing and they are checked by content instead.
harness_credential_file() {
  case "$1" in
    codex) printf '%s/.codex/auth.json' "$HOME" ;;
    grok) printf '%s/.grok/auth.json' "$HOME" ;;
    devin) printf '%s/.local/share/devin/credentials.toml' "$HOME" ;;
    hermes) printf '%s/.hermes/.env' "$HOME" ;;
    *) printf '' ;;
  esac
}

credential_file_satisfies() {
  local harness="$1" path="$2"
  case "$harness" in
    hermes)
      # The installer writes a settings-only .env. A provider key with a value
      # is the part that means the harness can actually reach a model.
      grep -qE '^[[:space:]]*(export[[:space:]]+)?[A-Z][A-Z0-9_]*_API_KEY=[^[:space:]]' "$path" 2>/dev/null
      ;;
    *) [[ -e "$path" ]] ;;
  esac
}

report_credentials() {
  local harness variable evidence file
  for harness in "${HARNESS_IDS[@]}"; do
    evidence=""
    for variable in $(harness_credential_env "$harness"); do
      if [[ -n "${!variable:-}" ]]; then
        evidence="$variable"
        break
      fi
    done
    file="$(harness_credential_file "$harness")"
    if [[ -z "$evidence" && -n "$file" ]] && credential_file_satisfies "$harness" "$file"; then
      evidence="$file"
    fi

    if [[ -n "$evidence" ]]; then
      printf '[harness-auth] %-12s ready via %s\n' "$harness" "$evidence"
    else
      printf '[harness-auth] %-12s needs %s%s%s\n' \
        "$harness" \
        "$(harness_credential_env "$harness")" \
        "$([[ -n "$file" ]] && printf ' or a login at %s' "$file")" \
        "$([[ -z "$file" ]] && printf ' or an interactive login')"
    fi
  done
}

# ── Run ────────────────────────────────────────────────────────────────────

export -f run_installer install_npm_package harness_install

installed=()
skipped=()
failed=()

for harness in "${HARNESS_IDS[@]}"; do
  if existing="$(harness_resolved "$harness")"; then
    printf '[harness] %-12s present at %s\n' "$harness" "$existing"
    skipped+=("$harness")
    continue
  fi

  printf '[harness] %-12s installing from %s\n' "$harness" "$(harness_source "$harness")"
  started_at=$SECONDS
  log="$LOG_DIR/junto-harness-$harness.log"
  timeout "$INSTALL_TIMEOUT_SECONDS" bash -c 'harness_install "$1"' _ "$harness" >"$log" 2>&1
  status=$?

  if resolved="$(harness_resolved "$harness")"; then
    if [[ "$status" -eq 0 ]]; then
      printf '[harness] %-12s installed at %s (%ss)\n' "$harness" "$resolved" "$((SECONDS - started_at))"
    else
      # Devin's installer ends by launching an interactive `devin setup`;
      # with no TTY that exits non-zero after the binary is already on PATH.
      printf '[harness] %-12s installed at %s (%ss); vendor post-install step exited %s, log %s\n' \
        "$harness" "$resolved" "$((SECONDS - started_at))" "$status" "$log"
    fi
    installed+=("$harness")
  else
    printf '[harness] %-12s FAILED after %ss (exit %s); log %s\n' \
      "$harness" "$((SECONDS - started_at))" "$status" "$log" >&2
    failed+=("$harness")
  fi
done

printf '[harness] %d already present: %s\n' "${#skipped[@]}" "${skipped[*]:-none}"
printf '[harness] %d installed: %s\n' "${#installed[@]}" "${installed[*]:-none}"

report_credentials

if [[ "${#failed[@]}" -gt 0 ]]; then
  printf '[harness] %d failed: %s\n' "${#failed[@]}" "${failed[*]}" >&2
  exit 1
fi
printf '[harness] all %d harness CLIs resolvable\n' "${#HARNESS_IDS[@]}"
