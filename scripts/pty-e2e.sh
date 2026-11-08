#!/usr/bin/env bash
# PTY E2E keystone runner — full repro suite + status line.
# Usage: bash scripts/pty-e2e.sh
set -uo pipefail
cd "$(dirname "$0")/.."
echo "== PTY E2E harness (repro suite; red = reproduced defect) =="
bunx vitest run tests/pty-e2e 2>&1 | grep -E "✓|×|Tests |Test Files" | tail -60
echo
echo "== ledger =="
if [ -f /tmp/junto-repro-ledger.md ]; then
  grep -E "^## " /tmp/junto-repro-ledger.md | head -20
else
  echo "(ledger not present — run the suite first)"
fi
