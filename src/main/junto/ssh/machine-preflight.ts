import { Effect } from "effect";
import { makeRemoteCommand, type SshTarget } from "./domain";
import { oneShot } from "./program";

const PREFLIGHT = `set -u
errors=""
problem() { case "$errors" in *"$1"*) ;; *) errors="$errors
- $1" ;; esac; }
platform=$(uname -s)
architecture=$(uname -m)
case "$platform $architecture" in
  'Darwin arm64') actual=darwin-arm64 ;;
  'Linux x86_64') actual=linux-x64 ;;
  *) actual=unsupported ;;
esac
[ "$actual" = "$1" ] || problem "This package is for $1; this machine is $platform $architecture"
python=""
for candidate in /usr/bin/python3 /bin/python3; do
  if [ -x "$candidate" ]; then python=$candidate; break; fi
done
if [ -z "$python" ] || ! "$python" -c 'import fcntl, os, sys; sys.exit(sys.version_info.major != 3)' >/dev/null 2>&1; then
  problem 'Install Python 3 on this machine'
fi
home=$3
[ -n "$home" ] || home=$HOME
root=$4
[ -n "$root" ] || root=$HOME/.junto/machine
for path in "$HOME" "$home" "$root"; do
  case "$path" in "$HOME"|"$HOME"/*) ;; *) problem 'Choose an install folder under the SSH account home'; continue ;; esac
  case "$path/" in */../*|*/./*|*//*) problem 'Choose an absolute install folder without dot or empty components'; continue ;; esac
  ancestor=$path
  while [ ! -e "$ancestor" ] && [ ! -L "$ancestor" ]; do ancestor=\${ancestor%/*}; done
  if [ ! -d "$ancestor" ] || [ ! -w "$ancestor" ]; then problem "Make the install folder writable: $path"; fi
  component=$path
  while [ "$component" != "$HOME" ]; do
    if [ -L "$component" ]; then problem "Choose an install folder without symbolic links: $path"; break; fi
    component=\${component%/*}
  done
  free=$(df -Pk "$ancestor" 2>/dev/null | awk 'END {print $4}')
  case "$free" in ''|*[!0-9]*) problem "Cannot check free space for $path" ;; *)
    [ "$free" -ge "$2" ] || problem "Free at least $2 KiB before sending Junto to $path" ;;
  esac
done
case "$platform" in
  Darwin) /bin/launchctl print "user/$(id -u)" >/dev/null 2>&1 || problem 'The account background service manager is unavailable; sign in to this machine first' ;;
  Linux) /usr/bin/systemctl --user show-environment >/dev/null 2>&1 || problem 'The account background service manager is unavailable; enable its systemd user service first' ;;
  *) problem 'Junto supports Apple silicon Macs and x64 Linux machines' ;;
esac
if [ -n "$errors" ]; then printf 'Cannot send Junto:%s\nFix these problems, then send again.\n' "$errors"; else printf 'ready\n'; fi
`;

/** Checks finish before any archive bytes reach the account or install files change. */
export const machinePreflight = (target: SshTarget, input: {
  readonly target: "darwin-arm64" | "linux-x64";
  readonly requiredKiB: number;
  readonly juntoHome?: string;
  readonly installRoot?: string;
}) => Effect.gen(function* () {
  if (!Number.isSafeInteger(input.requiredKiB) || input.requiredKiB <= 0
    || ![input.juntoHome, input.installRoot].every(path => path === undefined || /^\/[^\u0000-\u001f\u007f]*$/.test(path))) {
    return yield* Effect.fail(new Error("Invalid machine preflight selection"));
  }
  const command = yield* makeRemoteCommand("/bin/sh", ["-c", PREFLIGHT, "junto-preflight", input.target,
    String(input.requiredKiB), input.juntoHome ?? "", input.installRoot ?? ""]);
  return oneShot(target, command, { budget: "bulk" });
});
