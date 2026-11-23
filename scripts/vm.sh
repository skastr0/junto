#!/usr/bin/env bash
# Run Junto's checks on a Boat cloud VM instead of this machine.
#
#   scripts/vm.sh pool <region> [n]         the id of <region>'s shared VM number n (1 or 2; default 1), started if it is not up
#   scripts/vm.sh new <seat> <purpose>      a VM of your own from the $VM_BASE snapshot, named <seat>-<id>-<purpose>
#   scripts/vm.sh sync <id> [ref] [paths…]  put <ref> (HEAD, a branch, a tag or a hash; default HEAD) on the VM, plus your own uncommitted <paths>
#   scripts/vm.sh run <id> <command…>       run a command in your clone on the VM, output streamed
#   scripts/vm.sh stop <id>                 stop a VM of your own when your work is done, not after each check
#
# Heavy runs go to a VM, not this machine (operator, 2026-11-23): the unit
# suite, a build, vitest over more than 3 files. Each region shares two VMs.
# On a shared VM set VM_SEAT=<your seat name> on every sync and run: you then
# work in a clone of your own (~/$VM_DIR-<seat>), made on your first sync, so
# no seat's sync moves the tree another seat's run is reading. Never stop a
# shared VM: it stops itself 3 hours after the last `pool` that named it.
#
# A VM lives for a working session, not for one check: every start costs, so
# reuse it for every check while you work, and stop it when you are done.
# `new` gives it 3 hours; `boat extend <id> --hours 3` while you still work.
# Auto-stop is the net for a VM someone forgot. `new` and `pool` refuse while
# the hour's included starts are used (boat limits --json: .starts.hour).
#
# The VM holds a git clone, so a sync sends only the commits it lacks, as a
# git bundle (kilobytes), never the working tree. It never reads the shared
# checkout's working tree: only commits, and the paths you name, as a patch
# against <ref>. `bun install` runs only when bun.lock changed.
#
# Another repository uses this same script from its own root, with its own
# snapshot: VM_BASE (default junto-base) names the snapshot, and VM_DIR
# (default junto) the clone's folder under /home/user on the VM. VM_TYPE
# (small, default or large) sizes a VM that `new` or `pool` starts.
set -euo pipefail

# The whole script is one block, parsed before any of it runs: a seat whose
# run is in flight when this file changes keeps the copy it started with.
{

BOAT=${BOAT:-boat}
export BOAT_NO_UPDATE=1
VM_BASE=${VM_BASE:-junto-base}
VM_DIR=${VM_DIR:-junto}
# Several checkouts may share one VM: every file a sync sends is named for
# its clone, so two syncs at once never share one. A seat on a shared VM
# (VM_SEAT) has a clone of its own beside the snapshot's.
VM_HOME=$VM_DIR
[ -z "${VM_SEAT:-}" ] || VM_DIR="$VM_DIR-$VM_SEAT"
ROOT=$(git rev-parse --show-toplevel)
TMP=$(mktemp -d "${TMPDIR:-/tmp}/junto-vm.XXXXXX")
trap 'rm -rf "$TMP"' EXIT

# Starts past the plan's hourly 60 are paid from the wallet: start only while
# included ones remain. A stopped VM refuses commands (machine_not_running),
# so sync and run resume it, and a resume is a start: they ask the same first.
may_start() {
  local left
  left=$("$BOAT" limits --json | jq -r '.starts.hour.remaining')
  if [ "$left" -le 0 ]; then
    echo "vm.sh: the hour's included starts are used; the next frees at $("$BOAT" limits --json | jq -r '.startWindowFull.freesAt // "soon"'). Reuse a running VM, or wait." >&2
    exit 1
  fi
}
awake() { # awake <id>: resume a stopped VM, only within the included starts
  case "$("$BOAT" info "$1" --json | jq -r '.sandbox.state')" in
    stopped | stopping)
      may_start
      "$BOAT" resume "$1" --json >/dev/null
      ;;
  esac
}

remote() { # remote <id> <shell…>: run on the VM, print stdout and stderr, exit with its code
  local id=$1
  shift
  # boat prints JSON lines when its output is not a terminal; its exit code is the command's.
  "$BOAT" exec "$id" --timeout 0 --stream --json -- bash -lc "$*" |
    jq --unbuffered -rj 'if .type == "stdout" or .type == "stderr" then .data
      elif .event == "error" then "vm.sh: boat: \(.error)\n" | halt_error(1)
      else empty end'

}

case "${1:-}" in
  pool)
    region=${2:?region name}
    n=${3:-1}
    case "$n" in
      1 | 2) ;;
      *)
        echo "vm.sh: a region shares two VMs: n is 1 or 2" >&2
        exit 2
        ;;
    esac
    name="$region-pool-$n"
    # The oldest VM of that name that is up or starting. Two seats that ask
    # at once may start two, and both then settle on that one; the other
    # stops itself. A stopped one is not resumed: it is left to expire.
    id=$("$BOAT" list --filter rp --json | jq -r --arg name "$name" '[.sandboxes[] | select(.name == $name)] | sort_by(.createdAt) | first | .id // empty')
    if [ -n "$id" ]; then
      "$BOAT" extend "$id" --hours 3 --json >/dev/null
    else
      may_start
      id=$("$BOAT" new --from "$VM_BASE" --ttl 10800 --name "$name" ${VM_TYPE:+--type "$VM_TYPE"} --json | jq -r 'select(.event == "ready") | .id' | tail -1)
      [ -n "$id" ] || { echo "vm.sh: boat new did not report a ready VM" >&2; exit 1; }
    fi
    echo "$id"
    ;;
  new)
    seat=${2:?seat name}
    purpose=${3:?purpose}
    may_start
    id=$("$BOAT" new --from "$VM_BASE" --ttl 10800 --name "$seat-$purpose" ${VM_TYPE:+--type "$VM_TYPE"} --json | jq -r 'select(.event == "ready") | .id' | tail -1)
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
    # A seat's own clone is made on its first sync, from the snapshot's clone
    # and its node_modules (hard links, so no second copy on disk).
    if [ "$VM_DIR" != "$VM_HOME" ]; then
      remote "$id" "test -d ~/$VM_DIR/.git || { git clone -q ~/$VM_HOME ~/$VM_DIR && cp -al ~/$VM_HOME/node_modules ~/$VM_DIR/node_modules; }"
    fi
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
      "$BOAT" scp "$TMP/sync.bundle" "$id:/home/user/$VM_DIR.sync.bundle" >/dev/null
      fetch="git fetch -q ~/$VM_DIR.sync.bundle $carrier && rm -f ~/$VM_DIR.sync.bundle &&"
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
        "$BOAT" scp "$TMP/own.patch" "$id:/home/user/$VM_DIR.own.patch" >/dev/null
        patch="&& git apply ~/$VM_DIR.own.patch && rm -f ~/$VM_DIR.own.patch"
      fi
    fi
    put="old=\$(git rev-parse HEAD) && git checkout -q -f --detach $target && git clean -q -fd \
      && { git diff --quiet \$old $target -- bun.lock || bun install --frozen-lockfile >/dev/null; } $patch \
      && test \"\$(git rev-parse HEAD)\" = $target && git log --oneline -1"
    if ! remote "$id" "cd ~/$VM_DIR && $fetch $put"; then
      # A clone missing objects (seen after a resume) cannot unpack a bundle
      # built against its HEAD; one bundle of the whole branch needs nothing.
      [ -n "$fetch" ] || exit 1
      echo "vm.sh: the fetch failed; sending the whole branch once" >&2
      git -C "$ROOT" bundle create -q "$TMP/sync.bundle" "$carrier"
      "$BOAT" scp "$TMP/sync.bundle" "$id:/home/user/$VM_DIR.sync.bundle" >/dev/null
      [ -z "$patch" ] || "$BOAT" scp "$TMP/own.patch" "$id:/home/user/$VM_DIR.own.patch" >/dev/null
      remote "$id" "cd ~/$VM_DIR && $fetch $put"
    fi
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
    sed -n '2,21p' "$0"
    exit 2
    ;;
esac
exit
}
