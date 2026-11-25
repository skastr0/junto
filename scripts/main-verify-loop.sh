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
# The loop exits on a red (code 1), a parity break (3) or an infra failure (4)
# so its owner is told at once, and does not restart itself.
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

last=$(cut -d' ' -f1 "$STATE/last-run" 2>/dev/null || true)
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
    continue
  fi
  echo "main-verify: log $log" >&2
  case $result in red) exit 1 ;; parity) exit 3 ;; *) exit 4 ;; esac
done
