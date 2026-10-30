# Native CLI: `junto` in Rust, and Bun out of every package

Status: proposed for 0.12, operator direction of 2026-10-29. Not started: the
stop ruling of 2026-10-29 holds until product-lead lifts it.
Owner: product-lead. Design: cli-lead with tech-lead and performance-lead.

## Target

Agents call `junto` thousands of times a day, so every call starts fast and
never fails for a reason of its own. The CLI is a native Rust binary on the
desktop and on every machine. No package Junto ships contains Bun, so Node is
the one JavaScript runtime we ship and Bun's licence notices go away.

## Decisions (operator, 2026-10-29)

- **Rust replaces the Bun-compiled CLI** on the desktop and in every machine
  bundle. Bun leaves every shipped package. Building and testing with Bun is
  not a shipping question and is out of scope.
- **Rust owns what is the CLI's own**, the work of being a process in an
  agent's terminal (Design, below). It owns no domain logic: what an op
  means, who may run it and how it is ruled stay in TypeScript, in the app
  and the machine core.
- **Some duplication is accepted.** Commands are defined in Rust (types and
  traits), alongside the TypeScript that serves them. Parity tests, not a
  shared generator, keep the two in step.
- **A few MB is fine.** Docs, schema and examples go inside the binary.
- **Rust sidecars for hot paths in the app are welcome** where tracing shows
  a measured win (Sidecars, below).
- **Settled, not reopened:** the app's run-as-Node switch stays off
  (`scripts/package-security-policy.json:7`). It cannot be limited to our
  CLI: the switch is an environment variable read before any of our code
  runs, and the fuse sits in the shared Electron Framework binary, so it
  would hand Junto's signed identity, its permissions and its Keychain trust
  to any process.

## Baseline (cli-lead, 2026-10-29)

Measured on the installed app (`/Applications/Junto.app`), with the fleet
running, so the numbers are noisy. 40 runs each after 3 warm-up runs:

| Call | p50 | p90 |
|---|---|---|
| `junto --version` (no socket) | 124 ms | 427 ms |
| `junto signal list` | 141 ms | 242 ms |
| `junto ping` | 204 ms | 494 ms |
| Rust hello-world, release, stripped (floor) | 9 ms | 60 ms |

The installed CLI is 74.5 MB (`Contents/Resources/bin/junto`); the Rust
hello-world is 342 KB. Machine bundles carry 61 MB (Mac) and 98 MB (Linux)
of Bun-built CLI next to the Node that runs their core (measured on 0.7.0).
N0 repeats this on an idle machine and splits each call into start, socket
and server time before anything is built.

## Design

**One transport, as today.** The CLI talks to the app or the machine core over
the per-user Unix socket it already uses (`src/cli/core/socket.ts:157-212`),
newline-delimited JSON with the seat's `JUNTO_WORK_TOKEN`. No localhost HTTP
port: a port is reachable by any local process and by DNS rebinding, and the
socket is not.

**Rust owns:**

- Parsing the command line, help, completions, exit codes, timeouts, and
  reconnecting when the runtime is down.
- Input: stdin, `@file`, `-`, inline JSON, and the small grammars (`15m`,
  `Caption=/path`, `#42`, `HEAD`).
- Attachments: reading and hashing files, `git` for `--commit`, diffs
  (today `src/cli/core/signal-attach.ts`, `content-stage.ts`).
- The byte pipes: `link`, `companion-stdio`, `content-transfer`
  (`src/cli/early-dispatch.ts`).
- Batch runs and their concurrency (`src/cli/core/batch.ts`).
- The install lock, a plain `flock` (today `bun:ffi`,
  `src/main/junto/hosts/install-lock.ts:42-51`, which also needed an
  executable-memory entitlement on the Mac).
- The success and failure envelopes, rendered exactly as
  `src/cli/core/output.ts` does now.
- `junto docs`, `schema`, `examples` and help, built in at compile time from
  the TypeScript that defines them today, so they work with nothing running.

**TypeScript keeps:** every op handler, authz, rulings, the content store's
format, and the server-side decode of every op's arguments. The server stays
the ground truth: a Rust parser that drifts can give a worse error, never a
wrong action.

**Drift guards:**

- Every entry of the `junto examples` corpus runs through the TypeScript
  reference and the Rust binary; the requests on the wire match byte for
  byte, or the build fails.
- The onboard lock (`tests/seat-onboarding.test.ts`, every taught command is
  registered) runs against the Rust binary's command list.
- Error envelopes: the same refusal through both paths prints the same
  `type`, `next_step` and `retryable`.

## Sidecars

performance-lead traces the app and the machine core under a real fleet and
names hot paths where Rust would cut CPU, latency or memory by a margin worth
a second language there. tech-lead decides the form per candidate (a sidecar
process over a socket, or a native module) and whether it is worth it. One
candidate at a time, each landed only with its before and after trace. None
is assumed: the CLI comes first.

## Slices

| Slice | What | Size | Risk |
|---|---|---|---|
| N0 | Baseline on an idle machine: start, socket and server time per call, and which commands agents call most (logs) | S | low |
| N1 | Rust crate, toolchain pin, builds for darwin arm64 and x64 and linux x64 and arm64, signing, notarization, package audit inventory | M | medium |
| N2 | Socket client, envelopes, errors, exit codes, timeouts; the most called commands first (msg, signal family, onboard, since, task) | M | medium |
| N3 | Input and attachments: stdin, `@file`, the attach kinds, git, hashing and content staging | M | medium |
| N4 | Pipes and the lock: `link`, `companion-stdio`, `content-transfer`, `flock` | M | high |
| N5 | Built-in docs, schema, examples, help, completions | S | low |
| N6 | Owner commands (`machine`, `link`, `authority`): Rust, or an op the app runs over the operator socket (tech-lead) | M | medium |
| N7 | Parity and cutover: the drift guards green, the proof below, then Bun deleted from `scripts/build-standalone-cli.ts`, `scripts/build-machine.ts`, the app package and the notices | M | high |
| S1 | Sidecar candidates from performance-lead's traces | per item | per item |

Order: N0, N1, N2, N5, N3, N4, N6, N7. S1 runs beside them, behind its own
traces. N0 is the go or no-go: if start-up is not the larger part of a call,
the plan is rescoped before N1.

## Proof before Bun is deleted

- Every command, through both paths, on a Mac and on Linux.
- Install lock contention on a real machine.
- The installer and the packaged smoke test.
- The boot check with an empty `PATH`, on a machine with no Node or Bun, so
  nothing reaches for a system runtime.
- N0's table again, on the release build: no call slower than today.

## Open questions

- tech-lead: Rust edition and toolchain pin; how crate licences are listed
  (MIT and Apache, far simpler than WebKit's LGPL).
- tech-lead: N6, whether owner commands stay TypeScript run by the app.
- performance-lead: whether the measured server time per call is worth
  attention beside start-up.
- Windows, later: named pipes in place of the Unix socket.

## Not in this plan

- Moving the machine core off Node.
- Any change to op semantics, authz or the wire protocol.
- Dropping Bun as the build tool or test runner.
