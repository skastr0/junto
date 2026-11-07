#!/usr/bin/env bash
# Run Junto's checks on a Boat cloud VM instead of this machine.
#
#   scripts/vm.sh new <seat> <purpose>      a VM from the $VM_BASE snapshot, named <seat>-<id>-<purpose>
#   scripts/vm.sh sync <id> [ref] [paths…]  put <ref> (HEAD, a branch, a tag or a hash; default HEAD) on the VM, plus your own uncommitted <paths>
#   scripts/vm.sh run <id> <command…>       run a command in ~/$VM_DIR on the VM, output streamed
#   scripts/vm.sh stop <id>                 stop it when your work is done, not after each check
#
# A VM lives for a working session, not for one check: every start costs, so
# reuse it for every check while you work, and stop it when you are done.
# `new` gives it 3 hours; `boat extend <id> --hours 3` while you still work.
# Auto-stop is the net for a VM someone forgot. `new` refuses while the
# hour's included starts are used (boat limits --json: .starts.hour).
#
# The VM holds a git clone, so a sync sends only the commits it lacks, as a
# git bundle (kilobytes), never the working tree. It never reads the shared
# checkout's working tree: only commits, and the paths you name, as a patch
# against <ref>. `bun install` runs only when bun.lock changed.
#
# Another repository uses this same script from its own root, with its own
# snapshot: VM_BASE (default junto-base) names the snapshot, and VM_DIR
# (default junto) the clone's folder under /home/user on the VM.
set -euo pipefail

# The whole script is one block, parsed before any of it runs: a seat whose
# run is in flight when this file changes keeps the copy it started with.
{

BOAT=${BOAT:-boat}
export BOAT_NO_UPDATE=1
VM_BASE=${VM_BASE:-junto-base}
VM_DIR=${VM_DIR:-junto}
ROOT=$(git rev-parse --show-toplevel)
TMP=$(mktemp -d "${TMPDIR:-/tmp}/junto-vm.XXXXXX")
trap 'rm -rf "$TMP"' EXIT

# Starts past the plan's hourly 60 are paid from the wallet: start only while
# included ones remain. A command sent to a stopped VM wakes it, and that is a
# start too, so sync and run ask the same before they touch one.
may_start() {
  local left
  left=$("$BOAT" limits --json | jq -r '.starts.hour.remaining')
  if [ "$left" -le 0 ]; then
    echo "vm.sh: the hour's included starts are used; the next frees at $("$BOAT" limits --json | jq -r '.startWindowFull.freesAt // "soon"'). Reuse a running VM, or wait." >&2
    exit 1
  fi
}
awake() { # awake <id>: a stopped VM may wake only within the included starts
  case "$("$BOAT" info "$1" --json | jq -r '.sandbox.state')" in
    stopped | stopping) may_start ;;
  esac
}

remote() { # remote <id> <shell…>: run on the VM, print stdout and stderr, exit with its code
  local id=$1
  shift
  # boat prints JSON lines when its output is not a terminal; its exit code is the command's.
  "$BOAT" exec "$id" --timeout 0 --stream --json -- bash -lc "$*" |
    jq --unbuffered -rj 'select(.type == "stdout" or .type == "stderr") | .data'

}

case "${1:-}" in
  new)
    seat=${2:?seat name}
    purpose=${3:?purpose}
    may_start
    id=$("$BOAT" new --from "$VM_BASE" --ttl 10800 --name "$seat-$purpose" --json | jq -r 'select(.event == "ready") | .id' | tail -1)
    [ -n "$id" ] || { echo "vm.sh: boat new did not report a ready VM" >&2; exit 1; }
    "$BOAT" rename "$id" "$seat-$id-$purpose" >/dev/null
    echo "$id"
    ;;
  sync)
    id=${2:?VM id}
    awake "$id"
    ref=${3:-HEAD}
    shift $(($# < 3 ? $# : 3))
    target=$(git -C "$ROOT" rev-parse --verify "$ref^{commit}")
    have=$("$BOAT" exec "$id" --json -- git -C "/home/user/$VM_DIR" rev-parse HEAD 2>/dev/null | jq -r '.stdout // empty' | tr -d '[:space:]')
    # A bundle carries refs, not bare commits: a hash rides in on a ref that contains it.
    carrier=$(git -C "$ROOT" rev-parse --symbolic-full-name "$ref" 2>/dev/null || true)
    [ -n "$carrier" ] || carrier=$(git -C "$ROOT" for-each-ref --contains "$target" --format='%(refname)' | head -1)
    [ -n "$carrier" ] || { echo "vm.sh: no branch or tag contains $target, so it cannot be bundled" >&2; exit 1; }
    if [ "$have" != "$target" ]; then
      if [ -n "$have" ] && git -C "$ROOT" cat-file -e "$have^{commit}" 2>/dev/null &&
        git -C "$ROOT" bundle create -q "$TMP/sync.bundle" "$have..$carrier" 2>"$TMP/bundle.err"; then
        :
      elif ! git -C "$ROOT" bundle create -q "$TMP/sync.bundle" "$carrier" 2>"$TMP/bundle.err"; then
        echo "vm.sh: git bundle failed:" >&2
        cat "$TMP/bundle.err" >&2
        exit 1
      fi
    fi
    if [ -f "$TMP/sync.bundle" ]; then
      "$BOAT" scp "$TMP/sync.bundle" "$id:/home/user/sync.bundle" >/dev/null
      fetch="git fetch -q ~/sync.bundle $carrier && rm -f ~/sync.bundle &&"
    else
      fetch=""
    fi
    patch=""
    if [ "$#" -gt 0 ]; then
      # A private index, as the shared checkout commits (docs/machines.md), so
      # new files count and the checkout's own index is never touched.
      GIT_INDEX_FILE="$TMP/index" git -C "$ROOT" read-tree "$target"
      GIT_INDEX_FILE="$TMP/index" git -C "$ROOT" add -A -- "$@"
      GIT_INDEX_FILE="$TMP/index" git -C "$ROOT" diff --cached --binary "$target" >"$TMP/own.patch"
      if [ -s "$TMP/own.patch" ]; then
        "$BOAT" scp "$TMP/own.patch" "$id:/home/user/own.patch" >/dev/null
        patch="&& git apply ~/own.patch && rm -f ~/own.patch"
      fi
    fi
    remote "$id" "cd ~/$VM_DIR && $fetch old=\$(git rev-parse HEAD) && git checkout -q -f --detach $target && git clean -q -fd \
      && { git diff --quiet \$old $target -- bun.lock || bun install --frozen-lockfile >/dev/null; } $patch \
      && test \"\$(git rev-parse HEAD)\" = $target && git log --oneline -1"
    ;;
  run)
    id=${2:?VM id}
    awake "$id"
    shift 2
    # The VM sets Boat's own URLs, which Junto's tests read as a secret to scrub (boat-scrub).
    remote "$id" "cd ~/$VM_DIR && unset BACKEND_URL ASCII_API_URL BOX_CLI_API_URL && $*"
    ;;
  stop)
    "$BOAT" stop "${2:?VM id}"
    ;;
  *)
    sed -n '2,17p' "$0"
    exit 2
    ;;
esac
exit
}
