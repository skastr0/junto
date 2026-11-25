#!/usr/bin/env bash
set -euo pipefail

# The release gate's zoom ladder (operator row: the GPU canvas plan, item 1).
# A cut runs it at the cut commit, so no release ships without the sheets:
#
#   scripts/release-zoom-ladder.sh --board <shapes.json> [--commit <ref>] [--seat <name>] [--out <dir>]
#   scripts/release-zoom-ladder.sh --record-read <seat> [--out <dir>]
#   scripts/release-zoom-ladder.sh --check [--out <dir>]
#
# The ladder is the only proof that zooming does not corrupt the canvas, and it
# needs the real GPU, so it runs on the Mac mini and nowhere else: this half
# makes the checkout there (scripts/mini.sh at), sends the board as its shapes
# file only (scripts/mini.sh put: the JSON JUNTO_FACTORY_JSON reads, made-up ids
# and names, never a copy of a database), runs both arms
# (scripts/zoom-ladder-gate.sh, mini at 1x and mini-2x at 2x), brings the
# artifacts back, and judges them (scripts/release-zoom-ladder.ts). The judge,
# not this script, decides: it fails on an arm that failed, a proof that is
# missing or unreadable, an arm that drew at the wrong scale, a run that never
# evicted, or a sheet with no index.
#
# The receipt is <out>/release-zoom-ladder.json plus one bullet for the cut note;
# <out> holds both arms' contact sheets, proofs, diffs and console logs.
#   --record-read <seat>  the seat that read the sheets, written into the receipt
#   --check               the cut's last gate: passed, sheets present, a seat named
#
# It refuses at a commit that does not carry the spec rather than passing
# without a sheet. The rig is held about 20 minutes (7 at 1x, 12 at 2x) and the
# run queues on the mini's app-run lock: it measures nothing, so it takes no
# measurement book, but nothing else runs there meanwhile.

# The mini is for GPU checks only (scripts/mini.sh, 540c7e3ae): its at, put and
# run refuse without this mark, and this is the gate that needs the real GPU.
export MINI_GPU=1

ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"

case "${1:-}" in
  --record-read|--check)
    exec bun scripts/release-zoom-ladder.ts "$@"
    ;;
  --help|-h)
    sed -n '3,30p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
esac

board=""
commit="HEAD"
seat="release-zoom"
out="${RELEASE_ZOOM_OUT:-}"
argv=("$@")
for ((i = 0; i < ${#argv[@]}; i++)); do
  case "${argv[$i]}" in
    --board) board=${argv[$((i + 1))]:-} ;;
    --commit) commit=${argv[$((i + 1))]:-} ;;
    --seat) seat=${argv[$((i + 1))]:-} ;;
    --out) out=${argv[$((i + 1))]:-} ;;
  esac
done

die() { echo "release-zoom-ladder: $*" >&2; exit 1; }

[ -n "$board" ] || die "name the board: --board <shapes.json>. A real board travels as its shapes only; a database never leaves the machine that holds it."
[ -f "$board" ] || die "no board shapes file at $board"
if head -c 15 "$board" 2>/dev/null | cmp -s - <(printf 'SQLite format 3'); then
  die "$board is a SQLite database. Send a real board as its shapes (JUNTO_FACTORY_JSON); a copy of junto.db never goes to the mini."
fi
sha=$(git rev-parse --verify "$commit^{commit}") || die "no commit at $commit"
short=${sha:0:9}
git cat-file -e "$sha:e2e/scenarios/gpu-zoom-ladder.spec.ts" 2>/dev/null ||
  die "$short does not carry e2e/scenarios/gpu-zoom-ladder.spec.ts, so there is no ladder to run: the gate refuses rather than passing without a sheet"
out=${out:-$HOME/junto-receipts/zoom-ladder/$short}
mkdir -p "$out"

echo "release-zoom-ladder: $short on the mini, seat $seat, board $(sha256sum "$board" | cut -d' ' -f1), out $out"
dir=$(scripts/mini.sh at "$seat" "$sha") || die "the mini could not make a checkout of $short"
mini_out="$dir/.release-zoom"
mini_board="$dir/${board#/}"
scripts/mini.sh put "$dir" "$board" || die "the mini would not take $board"
scripts/mini.sh run "$dir" "test -s '$mini_board'" || die "the board did not land on the mini at $mini_board"

set +e
scripts/mini.sh run "$dir" "scripts/with-app-run-lock.sh scripts/zoom-ladder-gate.sh '$mini_board' '$mini_out'"
run_status=$?
set -e

tmp=$(mktemp -d "${TMPDIR:-/tmp}/junto-zoom-ladder.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
scripts/mini.sh run "$dir" "tar -C '$mini_out' -cf - ." >"$tmp/arms.tar" || die "the mini wrote no artifacts at $mini_out (gate exit $run_status)"
tar -C "$out" -xf "$tmp/arms.tar"

set +e
bun scripts/release-zoom-ladder.ts --out "$out"
judged=$?
set -e

if [ "$run_status" -ne 0 ] && [ "$judged" -eq 0 ]; then
  die "the rig exited $run_status but the artifacts read as a pass; refusing to call that green"
fi
exit "$judged"
