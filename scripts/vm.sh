#!/usr/bin/env bash
# Run Junto's checks on a Boat cloud VM instead of this machine.
#
#   scripts/vm.sh new <seat> <purpose>      a VM from the $VM_BASE snapshot, named <seat>-<id>-<purpose>
#   scripts/vm.sh sync <id> [ref] [paths…]  put <ref> (HEAD, a branch or tag; default HEAD) on the VM, plus your own uncommitted <paths>
#   scripts/vm.sh run <id> <command…>       run a command in ~/$VM_DIR on the VM, output streamed
#   scripts/vm.sh stop <id>                 stop it (snapshot kept 14 days); `boat resume <id>` brings it back
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

BOAT=${BOAT:-boat}
export BOAT_NO_UPDATE=1
VM_BASE=${VM_BASE:-junto-base}
VM_DIR=${VM_DIR:-junto}
ROOT=$(git rev-parse --show-toplevel)
TMP=$(mktemp -d "${TMPDIR:-/tmp}/junto-vm.XXXXXX")
trap 'rm -rf "$TMP"' EXIT

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
    id=$("$BOAT" new --from "$VM_BASE" --name "$seat-$purpose" --json | jq -r 'select(.event == "ready") | .id' | tail -1)
    [ -n "$id" ] || { echo "vm.sh: boat new did not report a ready VM" >&2; exit 1; }
    "$BOAT" rename "$id" "$seat-$id-$purpose" >/dev/null
    echo "$id"
    ;;
  sync)
    id=${2:?VM id}
    ref=${3:-HEAD}
    shift $(($# < 3 ? $# : 3))
    target=$(git -C "$ROOT" rev-parse --verify "$ref^{commit}")
    have=$("$BOAT" exec "$id" --json -- git -C "/home/user/$VM_DIR" rev-parse HEAD 2>/dev/null | jq -r '.stdout // empty' | tr -d '[:space:]')
    if [ -n "$have" ] && git -C "$ROOT" cat-file -e "$have^{commit}" 2>/dev/null && [ "$have" != "$target" ]; then
      # A bundle names refs, not bare commits: <ref> is HEAD, a branch or a tag.
      git -C "$ROOT" bundle create "$TMP/sync.bundle" "$have..$ref" 2>/dev/null ||
        git -C "$ROOT" bundle create "$TMP/sync.bundle" "$ref" 2>/dev/null
    elif [ "$have" != "$target" ]; then
      git -C "$ROOT" bundle create "$TMP/sync.bundle" "$ref" 2>/dev/null
    fi
    if [ -f "$TMP/sync.bundle" ]; then
      "$BOAT" scp "$TMP/sync.bundle" "$id:/home/user/sync.bundle" >/dev/null
      fetch="git fetch -q ~/sync.bundle && rm -f ~/sync.bundle &&"
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
      && { git diff --quiet \$old $target -- bun.lock || bun install --frozen-lockfile >/dev/null; } $patch && git log --oneline -1"
    ;;
  run)
    id=${2:?VM id}
    shift 2
    remote "$id" "cd ~/$VM_DIR && env -u BACKEND_URL -u ASCII_API_URL -u BOX_CLI_API_URL $*"
    ;;
  stop)
    "$BOAT" stop "${2:?VM id}"
    ;;
  *)
    sed -n '2,17p' "$0"
    exit 2
    ;;
esac
