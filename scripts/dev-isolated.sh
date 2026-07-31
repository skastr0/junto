#!/usr/bin/env bash
# Run the Vellum dev build against an isolated VELLUM_HOME so it never touches
# the production ~/.vellum, ~/.hermes, ~/.codex, etc.
#
# This keeps the shell HOME unchanged. Terminals, hermes, herdr, codex, and
# other child processes keep using the real user home, while Vellum's own state
# and control sockets live under ~/.vellum-dev.
set -euo pipefail

ISOLATED_HOME="${HOME}/.vellum-dev"

mkdir -p "${ISOLATED_HOME}"

printf 'vellum dev:isolated → VELLUM_HOME=%s (HOME unchanged)\n' "${ISOLATED_HOME}" >&2

# VELLUM_HOME overrides os.homedir() only for Vellum-owned paths. The real HOME
# stays in place so child shells and external CLIs behave predictably.
exec /usr/bin/env VELLUM_HOME="${ISOLATED_HOME}" bun run dev
