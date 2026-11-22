#!/usr/bin/env bash
# Run Junto's real-GPU checks on the Mac mini (Apple M1, Metal, 1920x1080 at
# 60 Hz, display attached) instead of this machine.
#
#   scripts/mini.sh at <seat> [ref]           <ref> (default HEAD) in its own checkout on the mini, deps and bundles built; prints its folder
#   scripts/mini.sh put <folder> <paths…>     copy files that are not in the commit (an untracked spec) into that folder
#   scripts/mini.sh run <folder> <command…>   run a command in that folder on the mini, output streamed
#   scripts/mini.sh book line <seat> <minutes> "<what>"   join the line for the rig; takes it when you are first and it is free
#   scripts/mini.sh book take <seat> <minutes> "<what>" | release <seat> | status
#   scripts/mini.sh rm <folder>               remove the checkout when you are done
#
# A checkout holds exactly one commit: git worktree of the mini's rig repo
# (~/junto-perf/repo.git), never the shared checkout's working tree. A sync
# sends only the commits the mini lacks, as a git bundle. node_modules is an
# APFS clone of ~/junto-perf/base's, and `bun install` runs only when bun.lock
# differs from base's.
#
# One measurement at a time: GPU and compositor numbers share the hardware.
# Take the book before any run that measures (frame times, GPU time) and
# release it when the run ends. When it is held, `book line` queues you: first
# come, first served. When the rig goes free the front seat is mailed, and it
# has 10 minutes to take it before it drops to the back. e2e runs that only check correctness queue on
# the mini's own app-run lock through scripts/run-e2e.sh and need no book.
# Numbers from the mini compare arms on the mini; the operator's Mac is
# measured separately.
set -euo pipefail

{

MINI=${MINI:-mac-mini}
RIG='~/junto-perf'
ROOT=$(git rev-parse --show-toplevel)
TMP=$(mktemp -d "${TMPDIR:-/tmp}/junto-mini.XXXXXX")
trap 'rm -rf "$TMP"' EXIT

remote() { # remote <shell…>: run on the mini with its tools on PATH
  ssh "$MINI" "export PATH=\$HOME/.local/share/mise/shims:/opt/homebrew/bin:\$PATH; $*"
}

case "${1:-}" in
  at)
    seat=${2:?seat name}
    ref=${3:-HEAD}
    target=$(git -C "$ROOT" rev-parse --verify "$ref^{commit}")
    short=${target:0:9}
    if ! remote "git -C $RIG/repo.git cat-file -e $target^{commit} 2>/dev/null"; then
      carrier=$(git -C "$ROOT" rev-parse --symbolic-full-name "$ref" 2>/dev/null || true)
      [ -n "$carrier" ] || carrier=$(git -C "$ROOT" for-each-ref --contains "$target" --format='%(refname)' refs/heads | head -1)
      [ -n "$carrier" ] || { echo "mini.sh: no branch contains $target, so it cannot be bundled" >&2; exit 1; }
      have=$(remote "git -C $RIG/repo.git rev-parse -q --verify refs/heads/main" || true)
      if [ -n "$have" ] && git -C "$ROOT" cat-file -e "$have^{commit}" 2>/dev/null; then
        git -C "$ROOT" bundle create -q "$TMP/sync.bundle" "$have..$carrier"
      else
        git -C "$ROOT" bundle create -q "$TMP/sync.bundle" "$carrier"
      fi
      scp -q "$TMP/sync.bundle" "$MINI:junto-perf/$seat-$short.bundle"
      remote "git -C $RIG/repo.git fetch -q $RIG/$seat-$short.bundle '+$carrier:refs/rig/$seat' && rm -f $RIG/$seat-$short.bundle"
    fi
    dir="$RIG/seats/$seat-$short"
    remote "set -e; [ ! -e $dir ] || { echo 'mini.sh: '$dir' exists; mini.sh rm it first' >&2; exit 1; }
      git -C $RIG/repo.git worktree add -q --detach $dir $target
      cd $dir
      [ ! -d $RIG/base/node_modules ] || cp -cR $RIG/base/node_modules node_modules
      cmp -s $RIG/base/bun.lock bun.lock && [ -d node_modules ] || bun install --frozen-lockfile >/dev/null
      JUNTO_FEATURE_PROFILE=all-on bun run build:bundles >.build.log 2>&1 || { echo 'mini.sh: build failed, see '$dir'/.build.log' >&2; exit 1; }
      test \"\$(git rev-parse HEAD)\" = $target && echo $dir"
    ;;
  put)
    dir=${2:?folder}
    shift 2
    [ "$#" -gt 0 ] || { echo "mini.sh: put needs paths" >&2; exit 2; }
    tar -C "$ROOT" -c -- "$@" | ssh "$MINI" "tar -x -C $dir"
    ;;
  run)
    dir=${2:?folder}
    shift 2
    remote "cd $dir && $*"
    ;;
  book)
    shift
    remote "$RIG/book $(printf '%q ' "$@")"
    ;;
  rm)
    dir=${2:?folder}
    remote "git -C $RIG/repo.git worktree remove --force $dir && git -C $RIG/repo.git worktree prune"
    ;;
  *)
    sed -n '2,11p' "$0"
    exit 2
    ;;
esac
exit
}
