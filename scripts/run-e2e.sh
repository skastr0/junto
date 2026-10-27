#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd -P)"
playwright="$repo_root/node_modules/.bin/playwright"

# shellcheck source=scripts/linux-display.sh
source "$script_dir/linux-display.sh"
# shellcheck source=scripts/app-run-lock.sh
source "$script_dir/app-run-lock.sh"

if [[ ! -x "$playwright" ]]; then
  printf 'junto: error: Playwright is missing — run .agents/setup\n' >&2
  exit 1
fi

cd "$repo_root"

# Spec selection: `--all` runs the full regression suite; explicit spec paths
# run those specs; no arguments defaults to the startup smoke spec so an
# unqualified invocation never sweeps every scenario.
if [[ "${1:-}" == "--all" ]]; then
  shift
elif [[ $# -eq 0 ]]; then
  printf 'junto: no spec paths given — running startup smoke (e2e/scenarios/free-startup.spec.ts). Pass spec paths, or use --all for the full suite.\n' >&2
  set -- e2e/scenarios/free-startup.spec.ts
fi

command=("$playwright" test --config e2e/playwright.config.ts "$@")

# One app run at a time on the machine; released when this shell exits.
junto_app_run_lock_acquire "e2e $*"

# The specs launch out/ as built. A build of another commit (a failed rebuild
# leaves the old one in place) runs stale code against newer state, so refuse
# unless the last complete electron-vite build stamped the expected commit
# (scripts/build-source-stamp.ts; a failed build leaves no stamp): this
# worktree's HEAD, or JUNTO_E2E_EXPECT_COMMIT when the caller just built and
# HEAD may have moved since (bun run verify). Checked under the lock, so
# another locked build cannot replace out/ after the check.
stamp="$repo_root/out/build-source.json"
expected_commit="${JUNTO_E2E_EXPECT_COMMIT:-$(git -C "$repo_root" rev-parse HEAD)}"
if [[ ! -f "$stamp" ]]; then
  printf 'junto: error: out/ has no complete build — the last electron-vite build failed or never ran; rebuild before running e2e\n' >&2
  exit 1
fi
built_commit="$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).sourceCommit ?? ""))' "$stamp")"
if [[ "$built_commit" != "$expected_commit" ]]; then
  printf 'junto: error: out/ was built from %s, but the run expects %s — rebuild before running e2e\n' "${built_commit:-an unknown commit}" "$expected_commit" >&2
  exit 1
fi

if [[ "$(uname -s)" == "Linux" ]] && junto_use_available_desktop; then
  if [[ -n "${AMP_DIRECT_DESKTOP:-}" ]]; then
    printf 'junto: Electron E2E is using the active Amp Desktop\n' >&2
    export JUNTO_E2E_SHOW="${JUNTO_E2E_SHOW:-1}"
  fi
elif [[ "$(uname -s)" == "Linux" ]]; then
  if ! command -v xvfb-run >/dev/null 2>&1; then
    printf 'junto: error: no desktop or Xvfb fallback is available — run .agents/setup\n' >&2
    exit 1
  fi
  printf 'junto: Electron E2E is using the headless Xvfb fallback\n' >&2
  export JUNTO_E2E_SHOW="${JUNTO_E2E_SHOW:-1}"
  junto_app_run_lock_run xvfb-run -a -s '-screen 0 1920x1200x24 -nolisten tcp' "${command[@]}"
  exit $?
fi

# Not exec: this shell must outlive the run to give the lock back.
junto_app_run_lock_run "${command[@]}"
