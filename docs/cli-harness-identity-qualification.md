# Environment identity across harnesses

Captured 7 October 2026 UTC. The selected design is one main-issued token per
occupant generation, injected as `JUNTO_WORK_TOKEN`. The CLI reads it itself.
There is no model-supplied token, token argument, credential file, or process
ancestry requirement. `cli-identity` owns the implementation; this report owns
the cross-harness investigation and records what has actually been checked.

## What the evidence establishes

**Shells are compatible with the design. Shared daemons require session-specific
forwarding.** Installed Codex 0.160.1's offline `command/exec` path preserves a
synthetic token under its defaults. Installed Prime 0.9.4 and Pi 1.0.1's
TypeScript shell backends also execute a shell that retains the exact marker.
None of these probes used a model, a live Junto socket, or a real credential.

**Junto's host environment merge preserves the token for every declared harness.**
Sixteen tests passed: one precedence/argv case for each of the fifteen templates,
plus a real nested POSIX-shell check. The host-issued value wins over ambient,
document, and region values. These tests use stub harness binaries and establish
the host launch boundary, not vendor tool execution or live admission.

Validation ran on committed snapshot `a81e4829520aa21776384dd929616b8740469b01`
plus this qualification change, isolated from another seat's active identity
rewrite. `bun run typecheck && bun run test` passed: 530 shared test files with
5,661 passing tests, and 265 isolated files with 3,117 passing tests. This does
not establish that the concurrently edited main worktree passes its gates.

**Configured environment filtering can intentionally withhold identity.** On the
installed Codex, automatic secret exclusion removes `JUNTO_WORK_TOKEN` while
retaining `JUNTO_WORK_SOCKET`. Inheriting `core` or `none`, or excluding
`JUNTO_*`, removes both. Defaults and a `JUNTO_*` include filter retain both.
The token name stays explicit. Diagnose missing identity; do not silently rename
it, widen an operator's filters, or fall back to files or process inspection.

The sanitized [probe results](research/cli-performance/harness-env-evidence.json)
contain booleans, installed package versions, and source hashes. The
[Codex probe](research/cli-performance/codex-env-probe.ts) starts an isolated
stdio app-server and calls `command/exec`, without a thread or inference. The
[shell backend probe](research/cli-performance/shell-backend-env-probe.ts) calls
the installed Pi-family `createLocalBashOperations` directly, without a daemon
or REPL. The [launch tests](../tests/harness-seat-credential-env.test.ts) cover
Junto's merge and nested shells.

## Qualification matrix

The harness set comes directly from
[`HARNESS_IDS`](../src/shared/managed-terminal-templates.ts:28).
“Pass” in the host column means the fixture launch test passed. “Pending” means
not qualified, rather than a measured failure. Live generation admission is
pending for every harness: the installed app used here predates token issuance.

| Harness | Host merge | Vendor execution evidence | Remaining live check |
|---|---|---|---|
| Claude Code | Pass | Not exercised | Model-issued shell, resumed session |
| Codex | Pass | Offline app-server `command/exec` retains marker; this real tool shell retains existing Junto markers, new token absent | TUI with `--no-daemon`, TUI using shared daemon, tool snapshots, resume |
| Grok | Pass | Not exercised | Model-issued shell, resumed session |
| Hermes | Pass | Separate local ACP spawn identified, no token injection in the inspected snapshot | TUI tools and ACP tools, unambiguous seat anchoring |
| Pi | Pass | Installed 1.0.1 TypeScript local shell backend retains exact marker | Full session tool call, extensions and alternate execution environments |
| Prime Agent | Pass | Installed 0.9.4 TypeScript local shell backend retains exact marker; REPL-shell forwarding verified in source only | Per-seat daemon, kernel shell, daemon/client reconnect, two-seat isolation |
| Kimi | Pass | Not exercised | Model-issued local shell and sandbox route |
| Muse Code | Pass | Peer reports existing Junto markers in Muse 1.4.3 tool shell, token absent; not independently exercised here | Full tool call with live token, resume |
| Devin | Pass | Not exercised | Host-local shell versus external sandbox, resume |
| Cursor Agent | Pass | Not exercised | Host-local shell and sandbox path |
| Agy | Pass | Not exercised | Model-issued shell and any intermediary process |
| Amp | Pass | Not exercised | Model-issued shell, thread resume |
| fx | Pass | Not exercised | Model-issued shell, nested sessions |
| omp | Pass | Not exercised | Shell executor and persistent shell snapshots |
| Junto Overseer | Pass | Uses closed controller tools, not a general shell tool catalog | Host control connection, live human grant and generation revocation |

Binary presence was checked for all fifteen on this machine. Installation and
startup alone do not establish tool-shell compatibility. A supported matrix
must name the harness version, mode, runtime/platform, and actual tool path.

## Codex: distinguish environment inheritance from daemon forwarding

The installed npm wrapper copies `process.env` into the native child's
environment (`@openai/codex/bin/codex.js:231–245`). That establishes the wrapper
boundary. The real Codex shell used for this investigation retains
`JUNTO_WORK_HOME`, `JUNTO_WORK_SOCKET`, `JUNTO_CLI`, and `JUNTO_SEAT`; it does not
have the new token because its seat was launched by the old app.

The current official [shell environment documentation](https://learn.chatgpt.com/docs/config-file/config-advanced#shell-environment-policy)
describes inheritance, automatic exclusions, and explicit filtering. Its stated
defaults permit token variables; the installed offline probe confirms this.
Custom exclusions or allowlists remain a compatibility condition. Includes do
not recover a variable already removed by automatic exclusion.

`command/exec` has an explicit per-request `env` override in the installed
generated schema. `thread/start` has no top-level `env` field; it does have
generic config overrides. Those facts do not establish what the TUI forwards
to a shared daemon. The official [app-server execution contract](https://learn.chatgpt.com/docs/app-server#command-execution)
also separates standalone command execution from thread/turn execution.

Keep the existing host-probed `--no-daemon` until a real TUI tool call through an
already-running shared daemon proves the seat's own marker survives. Qualify
two seats with distinct markers, followed by a replacement generation: tools
must receive their own value rather than the daemon starter's or an earlier
session's value. Exercise fresh and resumed threads and shell snapshots.
Snapshots created under an earlier generation must not restore that credential.

This is not a reason to retain ancestry authentication. It is a harness
forwarding requirement that the ancestry implementation also fails to solve.
Do not put the token in config argv as a workaround.

## Prime Agent: daemon and tool routes

Junto's [`prime-agent-daemon.ts`](../src/main/junto/term/prime-agent-daemon.ts:484)
retains arbitrary launch environment while removing nested internal-role
markers. It hands copies to both the per-seat daemon and terminal client
(:507, :1170). Thus the token must be prepared before this manager starts the
daemon, not injected only into the later PTY client. Each generation's daemon
must be stopped or retain a revoked old token when that generation ends.

Installed Prime 0.9.4 source has two relevant routes:

- `dist/core/tools/bash.js:27–40` runs its TypeScript local shell backend with
  `getShellEnv()`; `dist/utils/shell.js:129–141` preserves `process.env`. The
  offline backend probe exercised this route and retained the marker.
- `dist/core/kernel/repl-manager.js:219–228` passes `process.env` plus kernel
  options to its existing REPL runtime. The shipped
  `dist/prime-agent-runtime/src/rlm/bash.py:945–946` preserves that runtime's
  environment when starting shell commands. This route was read, not executed;
  no Python was run or added to Junto's implementation or these probes.

The end-to-end daemon/kernel route remains pending. Also check session-specific
options and extension hooks that replace the base environment. A direct
TypeScript backend success does not qualify those alternative paths.

## Other launch boundaries and completion criteria

Hermes ACP has an independent
[`spawnAcp`](../src/main/junto/hermes/plane.ts:446) entry: its local child used
`resolvedSpawnEnvSync()` and registered an agent key in the inspected snapshot.
It needs issuance anchored to one authoritative canvas seat before spawn. A
bare profile key cannot choose between two seats. Qualify ACP separately from
Hermes TUI; SSH-backed execution needs identity issued by the owning installation.

Remote seats receive a token from their own runtime. A Command Center seat token
must not become a Station wire credential. An arbitrary SSH command, container,
or external execution service is not qualified merely because its client is a
local harness. It needs a reachable owner-local control route and correctly
scoped environment delivery. Preserve the single app-owned database connection.

For each mode, the implementation's value-free identity diagnostic must be run
by the harness's actual tool executor. Record presence, shape, live validity,
and the admitted seat/generation without recording the credential. Then verify:

1. Two simultaneous seats reach their own identity, including their daemon paths.
2. Missing and malformed credentials fail clearly; no file or ancestry fallback.
3. Offboard/replacement rejects an old tool shell's token, including persistent
   shells or a daemon that outlives the old client. Fresh generation tools work.
4. A live token never substitutes for current edges or a live human overseer grant.
5. Delayed operations lose admission on relevant revocation; unrelated seat
   lifecycle events do not trigger OS observations or interrupt their work.
6. App restart and resume inject a fresh token before tools run. Startup readiness
   is observed independently of process existence or credential publication.

After live qualification, repeat the original packaged/direct-socket burst and
main-thread samples. Environment propagation results establish compatibility,
not post-change latency or visible stutter reduction.
