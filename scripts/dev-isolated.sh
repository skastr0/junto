#!/usr/bin/env bash
# Run the Vellum dev build against an isolated HOME so it never touches the
# production ~/.vellum, ~/.hermes, ~/.codex, etc. This is the recommended way
# to test protocol/contract changes while the installed app is running.
set -euo pipefail

ISOLATED_HOME="${HOME}/.vellum-dev"

mkdir -p "${ISOLATED_HOME}"

printf 'vellum dev:isolated → HOME=%s\n' "${ISOLATED_HOME}" >&2

# HOME=... makes os.homedir() and Vellum's control-home resolution point at the
# isolated directory. Child processes (terminals, shells, herdr, hermes, codex)
# will also inherit this HOME, so they start inside the sandbox.
exec /usr/bin/env HOME="${ISOLATED_HOME}" bun run dev
