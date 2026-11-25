#!/usr/bin/env bash
# Continuous main verify (tech-checks, tech-lead 2026-11-25): the backstop for
# the landing rule in AGENTS.md. One run at a time on the tech pool VM, always
# at the newest main. A run that ends starts the next at the head main has
# then, so landings that arrive meanwhile are coalesced into one run; with no
# new head it checks again every $POLL seconds. Nothing heavy runs here: this
# loop only reads git and drives scripts/vm.sh.
#
# Each run is a clean checkout of one commit with full history (vm.sh sync of
# a hash, no own paths), then `bun run verify` (tsrs locally) and
# `bun run typecheck:tsc` (TypeScript 7, the CI reference) so a tsrs/tsc
# disagreement shows as a parity break.
#
# State, shared by every seat of this checkout, in $(git rev-parse --git-common-dir)/main-verify/:
#   last-green   one line: <hash> <iso time> <seconds>   the newest main that passed
#   last-run     one line: <hash> <green|red|parity|infra> <iso time>
#   runs.log     one line per run; logs/<hash>.log is its full output
# A landing seat reads P with:  cut -d' ' -f1 "$(git rev-parse --git-common-dir)/main-verify/last-green"
#
# A red never stops the loop (tech-lead, 2026-11-25): it mails TO the lead the
# span (last green..red head) and the failing tests, then goes on to the next
# head. A red whose failing tests repeat on the next head is mailed again as a
# REPEAT, a real red. The loop exits only on a parity break (3) or an infra
# failure (4), so its owner is told at once; it does not restart itself.
set -uo pipefail

ROOT=$(git rev-parse --show-toplevel)
STATE=$(cd "$ROOT" && cd "$(git rev-parse --git-common-dir)" && pwd)/main-verify
BRANCH=${BRANCH:-main}
REGION=${REGION:-tech}
POOL_N=${POOL_N:-2}
POLL=${POLL:-180}
export VM_SEAT=${VM_SEAT:-tech-checks}
mkdir -p "$STATE/logs"

stamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }
head_of() { git -C "$ROOT" rev-parse --verify "$BRANCH^{commit}"; }

LEAD=${LEAD:-tech-lead}
# fails <log>: the failing tests and type errors of one run, one per line.
fails() {
  sed 's/\x1b\[[0-9;]*m//g' "$1" | { grep -E '^ FAIL |error TS' || true; } | sed -E 's/^ FAIL +//' | cut -c1-200 | sort -u | head -12
}
mail() { # mail <text>
  jq -n --arg target "$LEAD" --arg text "$1" '{target: $target, text: $text}' |
    xargs -0 junto msg send >/dev/null 2>&1 || echo "main-verify: mail to $LEAD failed" >&2
}
red_mail() { # red_mail <head> <previous result> <previous head>
  local head=$1 prev=$2 prevhead=$3 green span now kind common
  green=$(cut -d' ' -f1 "$STATE/last-green" 2>/dev/null || true)
  span=$(git -C "$ROOT" rev-list --count "${green:-$head}..$head" 2>/dev/null || echo '?')
  fails "$STATE/logs/$head.log" >"$STATE/logs/$head.fails"
  kind="RED"
  if [ "$prev" = red ] && [ -f "$STATE/logs/$prevhead.fails" ]; then
    common=$(comm -12 "$STATE/logs/$prevhead.fails" "$STATE/logs/$head.fails")
    if [ -n "$common" ]; then
      kind="REPEAT RED (a real red, also red at ${prevhead:0:9})"
    fi
  fi
  now=$(cat "$STATE/logs/$head.fails")
  mail "main verify $kind at ${head:0:9}. Span ${green:0:9}..${head:0:9} ($span commits, last green ${green:0:9}); the loop goes on to the next head. Failing:
$now
Log: $STATE/logs/$head.log"
}

prev_result=$(cut -d' ' -f2 "$STATE/last-run" 2>/dev/null || true)
prev_head=$(cut -d' ' -f1 "$STATE/last-run" 2>/dev/null || true)
last=$prev_head
while :; do
  M=$(head_of) || { echo "main-verify: cannot read $BRANCH" >&2; exit 4; }
  if [ "$M" = "$last" ]; then
    sleep "$POLL"
    continue
  fi
  log="$STATE/logs/$M.log"
  started=$(date +%s)
  echo "main-verify: $(stamp) start $M" >&2
  {
    id=$("$ROOT/scripts/vm.sh" pool "$REGION" "$POOL_N") &&
      "$ROOT/scripts/vm.sh" sync "$id" "$M" &&
      "$ROOT/scripts/vm.sh" run "$id" 'bun run verify; v=$?; echo "main-verify: verify exit $v"
        bun run typecheck:tsc; t=$?; echo "main-verify: typecheck:tsc exit $t"
        [ $v -ne 0 ] && exit 1
        [ $t -ne 0 ] && exit 3
        exit 0'
  } >"$log" 2>&1
  code=$?
  secs=$(($(date +%s) - started))
  case $code in
    0) result=green ;;
    1) result=red ;;
    3) result=parity ;;
    *) result=infra ;;
  esac
  last=$M
  echo "$M $result $(stamp)" >"$STATE/last-run"
  echo "$(stamp) $M $result ${secs}s" >>"$STATE/runs.log"
  echo "main-verify: $(stamp) $M $result (${secs}s)" >&2
  if [ "$result" = green ]; then
    echo "$M $(stamp) $secs" >"$STATE/last-green.tmp" && mv "$STATE/last-green.tmp" "$STATE/last-green"
    prev_result=green prev_head=$M
    continue
  fi
  if [ "$result" = red ]; then
    red_mail "$M" "$prev_result" "$prev_head"
    prev_result=red prev_head=$M
    continue
  fi
  echo "main-verify: log $log" >&2
  case $result in parity) exit 3 ;; *) exit 4 ;; esac
done
