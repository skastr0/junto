/**
 * Seat git hooks: how Junto learns which seat made a commit.
 *
 * Every seat may share one worktree and one git author, so neither folder,
 * time nor author says who committed. A seat process is spawned with
 * `core.hooksPath` pointed at a Junto-owned hooks directory, set through
 * `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n`, so no repo
 * file changes and nothing reaches commit messages or pushed history. Each
 * hook there runs the hook the repo would have run without Junto, with the
 * same args, stdin and exit code; `post-commit` then runs
 * `junto commit-observed`, and the seat credential already in the seat's
 * environment names the seat.
 *
 * The directory is `~/.junto/git-hooks/v<N>/`, written once per process on
 * the first seat spawn (each app start rewrites it) and never deleted: a seat
 * that is still running keeps the path it was spawned with.
 *
 * Worktrees and submodules: the repo's own hooks are found from where git
 * runs the hook, its configured `core.hooksPath` read from every config scope
 * except Junto's own entry, else `git rev-parse --git-common-dir`/hooks, so a
 * linked worktree and a submodule each find their own.
 *
 * Not delegated: `push-to-checkout` and `proc-receive`, which git consults by
 * their presence alone (a stub would replace git's own behaviour), and which
 * only run in a repo receiving a push. A push to another local repo does not
 * carry the override into it: git clears `GIT_CONFIG_COUNT` for the receiving
 * side.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveJuntoHome } from "@shared/junto-home";

/** Bump when the hook script changes; a new directory is written beside the old. */
export const SEAT_GIT_HOOKS_VERSION = 1;

/** The CLI entry the post-commit hook runs. Dispatch name only; agents never call it. */
export const COMMIT_OBSERVED_COMMAND = "commit-observed";

/** How long the post-commit report may take before the hook gives up on it. */
export const SEAT_GIT_HOOKS_REPORT_DEADLINE_SECONDS = 3;

/** Every hook git runs by name that a delegating stub cannot change the meaning of. */
export const SEAT_GIT_HOOK_NAMES = [
  "applypatch-msg",
  "pre-applypatch",
  "post-applypatch",
  "pre-commit",
  "pre-merge-commit",
  "prepare-commit-msg",
  "commit-msg",
  "post-commit",
  "pre-rebase",
  "post-checkout",
  "post-merge",
  "pre-push",
  "pre-receive",
  "update",
  "post-receive",
  "post-update",
  "reference-transaction",
  "pre-auto-gc",
  "post-rewrite",
  "sendemail-validate",
  "post-index-change",
  "p4-changelist",
  "p4-prepare-changelist",
  "p4-post-changelist",
  "p4-pre-submit",
] as const;

export const seatGitHooksDir = (home: string = resolveJuntoHome()): string =>
  join(home, ".junto", "git-hooks", `v${SEAT_GIT_HOOKS_VERSION}`);

/** One single-quoted shell word. */
const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * The hook script. POSIX sh, one script under every name; `$0` says which
 * hook git ran.
 */
export const seatGitHookScript = (hooksDir: string): string => `#!/bin/sh
# Junto seat git hook v${SEAT_GIT_HOOKS_VERSION}. Written by Junto; do not edit, it is rewritten.
# Runs the hook this repo would have run without Junto, with the same args,
# stdin and exit code. After post-commit, tells Junto which seat committed.
junto_self=${shellQuote(hooksDir)}
junto_name=\${0##*/}

# The repo's own hooks directory, as git resolves it without Junto's entry.
# Fast path, one git call: Junto's entry is the last one in the environment,
# so git asked with one entry fewer answers exactly. Otherwise: the last
# core.hooksPath from any scope that is not Junto's, else <common dir>/hooks.
junto_dir=
junto_count=\${GIT_CONFIG_COUNT:-0}
case $junto_count in ''|*[!0-9]*) junto_count=0 ;; esac
junto_key= junto_value=
if [ "$junto_count" -gt 0 ]; then
  junto_last=$((junto_count - 1))
  eval "junto_key=\\\${GIT_CONFIG_KEY_$junto_last:-} junto_value=\\\${GIT_CONFIG_VALUE_$junto_last:-}"
fi
if [ "$junto_key" = core.hooksPath ] && [ "$junto_value" = "$junto_self" ]; then
  junto_dir=$(GIT_CONFIG_COUNT=$junto_last git rev-parse --git-path hooks 2>/dev/null)
  [ "$junto_dir" = "$junto_self" ] && junto_dir=
else
  junto_nl='
'
  junto_values=$(git config --type=path --get-all core.hooksPath 2>/dev/null)
  junto_ifs=$IFS
  IFS=$junto_nl
  for junto_value in $junto_values; do
    [ "$junto_value" = "$junto_self" ] || junto_dir=$junto_value
  done
  IFS=$junto_ifs
fi
if [ -z "$junto_dir" ]; then
  junto_common=$(git rev-parse --git-common-dir 2>/dev/null) && junto_dir=$junto_common/hooks
fi
junto_hook=
if [ -n "$junto_dir" ] && [ -f "$junto_dir/$junto_name" ] && [ -x "$junto_dir/$junto_name" ]; then
  junto_hook=$junto_dir/$junto_name
fi

if [ "$junto_name" != post-commit ]; then
  [ -n "$junto_hook" ] || exit 0
  exec "$junto_hook" "$@"
fi

junto_status=0
if [ -n "$junto_hook" ]; then
  "$junto_hook" "$@"
  junto_status=$?
fi

# The report never changes the commit: at most one quiet line on stderr.
junto_cli=\${JUNTO_CLI:-}
if [ -z "$junto_cli" ] || [ ! -x "$junto_cli" ]; then
  junto_cli=$(command -v junto 2>/dev/null)
fi
if [ -z "$junto_cli" ]; then
  echo "junto: this commit is not attributed to the seat: the junto CLI was not found" >&2
  exit $junto_status
fi
"$junto_cli" ${COMMIT_OBSERVED_COMMAND} </dev/null >/dev/null &
junto_pid=$!
( sleep ${SEAT_GIT_HOOKS_REPORT_DEADLINE_SECONDS} && kill "$junto_pid" ) </dev/null >/dev/null 2>&1 &
junto_dog=$!
wait "$junto_pid" 2>/dev/null
junto_report=$?
kill "$junto_dog" 2>/dev/null
if [ "$junto_report" -gt 128 ]; then
  echo "junto: this commit is not attributed to the seat: the report timed out" >&2
fi
exit $junto_status
`;

const complete = (hooksDir: string, script: string): boolean =>
  SEAT_GIT_HOOK_NAMES.every((name) => {
    try {
      return readFileSync(join(hooksDir, name), "utf8") === script;
    } catch {
      return false;
    }
  });

/**
 * Write the hooks directory. Each file is written beside its name and renamed
 * over it, so a git run at the same moment sees the old script or the new,
 * never half of one. True when every hook is in place.
 */
export const installSeatGitHooks = (home: string = resolveJuntoHome()): boolean => {
  const hooksDir = seatGitHooksDir(home);
  const script = seatGitHookScript(hooksDir);
  try {
    mkdirSync(hooksDir, { recursive: true, mode: 0o755 });
    for (const name of SEAT_GIT_HOOK_NAMES) {
      const path = join(hooksDir, name);
      const staged = `${path}.${process.pid}.tmp`;
      writeFileSync(staged, script, { mode: 0o755 });
      chmodSync(staged, 0o755);
      renameSync(staged, path);
    }
  } catch (error) {
    console.warn(`[seat-git-hooks] could not write ${hooksDir}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return complete(hooksDir, script);
};

const installed = new Map<string, boolean>();

/** Once per process and home: the first seat spawn after app start rewrites the directory. */
const ensureSeatGitHooks = (home: string): boolean => {
  const known = installed.get(home);
  if (known !== undefined) return known && existsSync(seatGitHooksDir(home));
  const ok = installSeatGitHooks(home);
  installed.set(home, ok);
  return ok;
};

/**
 * A seat's spawn environment with Junto's hooks directory as one more
 * command-scope config entry, after any the environment already carries.
 * Unchanged when the directory could not be written: a `core.hooksPath` that
 * names nothing would quietly turn off the repo's own hooks.
 */
export const withSeatGitHooks = (
  env: Record<string, string>,
  home: string = resolveJuntoHome(),
  ensure: (home: string) => boolean = ensureSeatGitHooks,
): Record<string, string> => {
  if (!ensure(home)) return env;
  const raw = env.GIT_CONFIG_COUNT?.trim();
  const count = raw === undefined || raw === "" ? 0 : Number(raw);
  // A count git itself would refuse is left alone; adding to it cannot help.
  if (!Number.isSafeInteger(count) || count < 0) return env;
  return {
    ...env,
    GIT_CONFIG_COUNT: String(count + 1),
    [`GIT_CONFIG_KEY_${count}`]: "core.hooksPath",
    [`GIT_CONFIG_VALUE_${count}`]: seatGitHooksDir(home),
  };
};
