# Managed terminal — verification map

Status: executed-probe verification of the managed-terminal design. 2026-07-26.
Method: every item below was verified by **running the real harness TUI in a PTY** (or reading source with file:line receipts) — not doc reads. 63/63 probe items have executed receipts.
Raw evidence: the 2026-08 per-harness probe reports, gap-fill rounds and journal verdicts (retired from the repository; this file carries the verified facts) (compact per-item verdicts with pointers). Probe artifacts (`.bin` PTY captures, hook payload dumps) lived in the session scratchpad; the reports quote the load-bearing bytes.

Scope: this map verifies mechanisms exposed by the harness binaries, not
Vellum Command's current wiring or release status. Current release capability is
recorded by the managed-terminal template badges.

The design being verified: **one agent surface** — a Vellum Command-spawned PTY running the harness's full interactive TUI (never headless), per-session injection via flags/env only (zero writes to user configs), the station CLI as the tool surface (process-bind), state-gated PTY typing as the drive channel, Ctrl+C interrupt, resume-by-id cold wake. Harness templates v1: Claude Code, Codex, Grok, Hermes.

Versions probed: claude 2.1.220 - codex-cli 0.145.0 - grok build (grok-4.5 era, 2026-07) - hermes (2026-07, gpt-5.4/5.5 era) - herdr master @ c0fb777 (Apache-2.0). Re-verify on major harness updates — several load-bearing behaviors are undocumented.

## Claude Code — 9/9 VERIFIED 

| # | fact | key receipt / trap |
|---|---|---|
| K1 | PreToolUse deny works in the real TUI via inline `--settings`; reason reaches the model verbatim; holds under `bypassPermissions` | grid showed `⎿ Error: PROBE_DENY_REASON_XYZ`, model echoed it |
| K2 | `permissions.allow` via `--settings` suppresses prompts | `Bash(vellum-command:*)` proven on a real binary; control command still prompted |
| K3 | Typing recipe: bracketed paste + CR submits at 0ms delay; LF never submits | ⚠ single Ctrl+C at idle clears the composer |
| K4 | Typed `/compact` fires PreCompact + PostCompact; completion visible | `PostCompact` carried `trigger:"manual"` |
| K5 | Effort at spawn: `--effort` and `CLAUDE_EFFORT` (flag wins); 6 levels incl. `ultracode` | models NOT enumerable by command — read `~/.claude.json → additionalModelOptionsCache` + aliases |
| K6 | Weekly limits machine-readable: `~/.claude.json → cachedUsageUtilization` (five_hour/seven_day, resets, spend) — equals the `/usage` screen | ⚠ refreshes only when `/usage` opens, not on launch or `-p` turns |
| K7 | `--settings {"env":…}` reaches Bash tool subprocesses; `CLAUDE_CODE_SESSION_ID` + `CLAUDE_PID` free in tool env | exact match to pinned `--session-id` and PTY child pid |
| K8 | Mid-turn 0x03 always safe (never exits, tested to +1000ms second press) | ⚠ idle double-press exits when <~1.0s apart (bounded 0.509–1.009s) |
| K9 | OSC: `]9;4;3`/`]9;4;0` working flag; title glyph `✳` idle vs braille spinner working | ⚠ OSC cannot distinguish idle from permission prompt — input-required needs grid |

Spawn env trap (prior probe): scrub `CLAUDE_CODE_CHILD_SESSION`, `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT` or transcripts silently disable. `--mcp-config` (if ever used) is variadic — put last.

## Codex — 14/14 VERIFIED 

| # | fact | key receipt / trap |
|---|---|---|
| C1 | Argv prompt auto-submits in the TUI | turn ran with zero PTY input |
| C2 | Paste then **separate** CR write submits (0–150ms gaps all pass) | ⚠ payload+CR in one write NEVER submits; typed chars need ≥~200ms before CR; mid-turn CR queues a second turn |
| C3 | Session id capture order: SessionStart hook > `CODEX_THREAD_ID` (agent env) > notify payload > rollout file > `/status` | ⚠ rollout file absent until first turn; `session_index.jsonl` stale |
| C4 | `codex resume <id>` continues the same session (no fork, no usage) | ⚠ flags NOT inherited on resume — re-pass everything |
| C5 | Hooks injectable via `-c`; 11 events; PreToolUse deny blocks pre-execution; PermissionRequest deny pre-empts the modal | ⚠ untrusted hook = blocking pre-TUI modal; use Vellum Command-owned `CODEX_HOME` with pre-trusted hash (verified, zero writes to real config; auth symlink works) - ⚠ matcher `"Bash"`, not `"shell"` (silent no-op) |
| C6 | `notify` via `-c`: single event `agent-turn-complete`, JSON payload with thread-id | does not fire on interrupted turns |
| C7 | Allowlisting: no `-c` path — `$CODEX_HOME/rules/default.rules` `prefix_rule` file; fires unprompted in Vellum Command-owned CODEX_HOME | residual: one probe's ask-everything behavior hypothesized to be Groundwork hooks, not codex (not fully ablation-closed) |
| C8 | `codex debug models` enumerates models + per-model effort lists (gpt-5.6-sol/terra/luna, …, incl. `ultra`) | ⚠ `-m` not validated locally — bogus ids proceed |
| C9 | `/status` shows `Session:`, context %, `Weekly limit: … resets …`, per-model limits; OTLP export works (live sink, token fields per event) | plan/rate-limit fields definitively ABSENT from OTLP — weekly limits are a `/status` scrape |
| C10 | `/compact` exists; completion = `• Context compacted` + idle title + OSC9 | |
| C11 | Spawn env inherited by agent shell; filter knob `shell_environment_policy` | codex injects `CODEX_THREAD_ID`, `CODEX_SANDBOX*` |
| C12 | OSC title state machine: idle basename / braille working ~10Hz / **`Action Required` title for input-required** / empty on shutdown | startup modals (dir-trust, hooks-review) emit no title — grid only |
| C13 | Mid-turn 0x03 interrupts, TUI survives | ⚠ idle 0x03 with EMPTY composer exits immediately, no confirmation; with text it only clears |
| C14 | `-c developer_instructions` is NOT a Tier-A route (2026-08-25, codex-cli 0.149.1) | see the refutation below |

### C14 — why Codex stays Tier B (probe receipt, 2026-08-25, codex-cli 0.149.1)

`-c developer_instructions` looks like a system-prompt flag and behaves like one
right up to the point where it matters:

- it passes strict-config, renders verbatim as the first `developer` role
  message, and a live turn obeys it;
- **a real `/compact` destroys it.** After compaction the agent answers `None`
  when asked for its standing instruction, and `thread_settings_applied`
  records `null`;
- **re-passing the flag on resume does not reinject it.** Thread settings are
  frozen at creation, so `codex resume <id> -c developer_instructions=…` is a
  no-op. A pre-compaction resume appears to obey only because the transcript
  replays.

So the flag buys an instruction that silently disappears exactly when the seat
most needs it, and cannot be restored by the spawn path. Codex therefore stays
**Tier B** — `injectionSpec.tier` and the `instructionInjection` badge both `B`,
no `systemPromptConfigKey` plumbing — and doctrine is re-delivered by the
supervisor's budgeted re-orientation floor (`REORIENT_EVERY_TURNS` in
`term/intervention/policy.ts`), which is harness-agnostic and self-heals any
Tier-B seat whose context was compacted away.

Do not retry the flag on resume. The freeze is the trap.

## Grok — 13/13 VERIFIED 

| # | fact | key receipt / trap |
|---|---|---|
| G1 | Argv prompt auto-submits; `--session-id <uuid>` pins the session dir/id | ⚠ requires a git cwd — non-git shows a modal that swallows the prompt |
| G2 | Paste + CR recipe; earliest accepted write ~1.5s post-spawn; mid-turn CR **queues natively** ("Queued - Enter to send now", auto-delivered on turn end) | ⚠ image on macOS clipboard → paste-end attaches `[Image #1]` (trigger = `ESC[201~`; bare 0x16 too). Pre-flight `osascript clipboard info`; detect-and-abort, never silent-clear |
| G3 | `--session-id` pin + `grok -r <id>` resume round-trip; `--fork-session` for forks | resume replayed pre-resume history verbatim |
| G4 | Leader lane: `grok agent leader` + `--leader` clients speak full ACP; a second client can `session/load` a **live TUI's** session and replay its update stream (structured observability, no scraping) | steering into a live TUI via this lane not executed (read-only scope); `grok leader list` unreliable |
| G5 | Hooks EXIST: project-local `.grok/hooks/*.json`, 15 events incl. blocking PreToolUse/Stop; plus per-session `events.jsonl` (`turn_started/turn_ended/phase_changed/tool_started/permission_requested/resolved`) — free machine-readable state feed | ⚠ grok also executes `~/.claude/settings.json` hooks; `grok inspect` under-reports |
| G6 | `--allow 'Bash(vellumstation *)'` → allow, wait_ms 0 (clean-bed verified) | whole-command-string match, no wrapper peeling |
| G7 | Models: `models_cache.json` or ACP init `availableModels[].reasoningEfforts`; efforts exactly high/medium/low | invalid values warn-and-fallback, exit 0 |
| G8 | Per-turn usage in `updates.jsonl` (`costUsdTicks`, tokens, modelUsage); `signals.json` context/latency; `grok trace <id> --local --json` exports all | weekly limit is TUI text only (`/usage`) |
| G9 | `/compact` executed; checkpoint file + `auto_compact_completed` event | manual compaction reports as `auto_…`; `compactionCount` stays 0 |
| G10 | Spawn env inherited wholesale by agent bash | grok forces `TERM=dumb` for tools; hooks get xterm-256color |
| G11 | OSC 0 title = phase machine (Waiting/Thinking/Responding/Running:<tool>); OSC `9;4` binary; footer text = exact idle/working/queued oracle | heavy Kitty-graphics APC bursts — VT parser must skip |
| G12 | 0x03 mid-turn cancels turn only (`trigger:"ctrl_c"` in events); ESC same + restores composer; idle 0x03 no-op | `/exit` + CR for clean exit |
| G13 | `--agent <file>`: frontmatter (name, model, permission_mode, tools, disallowedTools) + body appended to system prompt; `tools`/`disallowedTools` gating verified enforced | `permission_mode` in the file is inert at top level — use the CLI flag |

## Hermes — 10/10 VERIFIED 

| # | fact | key receipt / trap |
|---|---|---|
| H1 | ⚠ CORRECTION: `-z` and `chat -q` are HEADLESS. TUI auto-submit = **`hermes chat --tui -q "<prompt>"`** | default interface is `cli` — `--tui` must be explicit |
| H2 | `hermes profile list` ~1s, ANSI-free fixed-width, cacheable; hidden `-p/--profile` selects at spawn | no `--json` anywhere; cacheable truth = `~/.hermes/profiles/` + per-profile config.yaml |
| H3 | Model at spawn: `-m` + `--provider`; enumeration from `provider_models_cache.json` (7–24 ids per provider) | ⚠ cache staleness PROVEN (exit 0 with HTTP 404 body) — validate, don't trust exit codes. Effort at spawn is `--reasoning LEVEL` (`none|minimal|low|medium|high|xhigh|max|ultra`) on installed 0.21.0 (`hermes chat --help`). Typed `/reasoning` remains the in-session override. |
| H4 | Session id `%Y%m%d_%H%M%S_<hex6>`; `HERMES_SESSION_ID` env set unconditionally; `--pass-session-id` puts it in the system prompt; live binding file in `$TMPDIR`; `--resume <id>` rehydrates | ⚠ resume reverts model — re-pass `-m`. No `--session-id` pin exists |
| H5 | Paste + separate CR submits; TUI enables 2004/1049/mouse/kitty-kbd | mid-turn typing governed by `display.busy_input_mode` (queue/steer/interrupt) — idle-gating is correct |
| H6 | Per-session usage in `state.db` (tokens incl. reasoning, `estimated_cost_usd`, billing_mode); `hermes insights`; `/usage` RPC | |
| H7 | Config-free per-invocation hooks: project plugin + `HERMES_ENABLE_PROJECT_PLUGINS=1` → 21 events, full chain fired, zero writes (double-verified); or HERMES_HOME `plugins.enabled` | novel plugin gated by `plugins.enabled` against the real config — the two levers above are the injection paths |
| H8 | `--tui` OSC titles carry `✓` idle / `⏳` busy / **`⚠` input-required**; `--cli` emits none | grid anchors exist for both modes |
| H9 | Env survives into `terminal` tool child byte-identical (secret-shaped names too — masking is output-only); `execute_code` scrubs ALL custom vars | isolation must come from socket process-bind, not env naming |
| H10 | 0x03: first interrupts turn, second exits; partial turns still billed | one historic self-exit anomaly: 5/5 clean reproduction attempts survived — bounded non-reproducible, QA watch |
| R1–R4 | Over `ssh -t remote-a`: full TUI renders; 14 profiles enumerated (~1.5s, byte-stable, cacheable); `--profile X -m Y` spawn verified; typing echo 16–145ms (mean ~66ms) | ⚠ spawn-time "Installing TUI dependencies…" window (~1–2s): Ctrl+C there kills the ssh session — gate interrupts on positive readiness, never a quiet-gap |

## Muse — session capture, and the overlay that is not doctrine (0.2.1, 2026-08-25)

| # | fact | key receipt / trap |
|---|---|---|
| M1 | `--agents` is an agent-definition overlay, NOT an injection route | schema is strict `{name, instructions, optional tools}`; a `systemPrompt` key is REJECTED; unknown keys are SILENTLY ignored; instructions demanding a canary prefix were never obeyed in main-session turns |
| M2 | The session id is never printed | a live PTY capture of the TUI carries no UUID anywhere in its output, and the OSC title is the bare workspace name |
| M3 | The id is the session directory's name | `~/.local/share/muse/sessions/<yyyy>/<mm>/<dd>/<uuid>/session.jsonl`, whose first record is `runtime.session.metadata` carrying `workspace_root` and a microsecond `recorded_at` |
| M4 | `muse resume <uuid>` is exact | ⚠ BARE `muse resume` opens the session picker — a seat on no known session. Never emit it |
| M5 | The TUI requires a responsive host, and the requirement is FATAL | ⚠ with OSC 10/11 and the OSC 4 palette queries unanswered, 0.2.1 emits ~260 bytes and EXITS without painting. Answered, the same spawn paints the TUI and runs a turn |

M1 is why Muse stays Tier B with no `agentFlag` and no `systemPromptFlag`: the
overlay looks like a doctrine route and silently is not, which is the worst
shape a capability claim can have.

M2 and M3 are why capture reads the store instead of the screen, and why it
matches on workspace AND start time (`term/templates/muse-session.ts`) — the
newest directory on the machine can easily belong to another seat.

M5 is a live gap, not a Muse bug: Vellum Command answers those queries only from
the renderer's xterm surface (`renderer/lib/xterm-appearance.ts`), so a seat the
factory wakes with no surface attached has nobody to answer it. Until the PTY
layer answers for every seat regardless of surface, a factory-woken Muse seat
exits at startup and has no session to capture or resume.

## Study findings that change the build

From the herdr study (master @ c0fb777, Apache-2.0; learn-never-fork):
- Detection = declarative TOML rule engine, 13 named regions (incl. `prompt_box_body` — literally the "input box idle" predicate), 4 states, priority-ranked, per-harness manifests (all four v1 harnesses covered).
- **Settled-idle debounce, port verbatim**: 300ms tick → 100ms holding, 3 confirmations, 700ms cap, 800ms blocker heartbeat, 3s post-change grace; debounce ONLY the Working→Idle drop — visible idle chrome publishes immediately.
- Herdr **reversed its own hooks decision** for Claude/Codex (screen+OSC won; hooks kept only for session-id) — and its hook install writes user configs (exactly Vellum Command's banned move). The target design could use per-invocation hooks without user-config writes; current Vellum Command ships no per-harness hook injection and relies on OSC/grid.
- Herdr typing has **no gating, no chunking, no dialog avoidance** — a prompt sent while blocked goes into the dialog. Vellum Command's state-gated typing is strictly stronger. Take the 5s `agent_prompt_stalled` check.
- OSC titles are untrusted model output: sanitize (256-char cap, strip controls), clear retained evidence on agent change.
- Skip: config writing, remote unsigned manifest auto-update, literal pattern strings (re-derive from our own e2e captures).

From [`tui-horizons.md`](tui-horizons.md):
- **Vellum Command currently registers zero OSC/CSI handlers** — every structured signal above arrives and is discarded. Largest cheap win.
- **The emulated grid is renderer-lifetime-bound** (`TerminalSurface.tsx:207/266`) — state detection must move to a main-process grid (`@xterm/headless`, not yet a dependency). The one real architecture prerequisite.
- `bracketedPasteMode` (CSI ?2004) is a protocol-level "input box live" gate; `?2026` synchronized-output marks exact repaint boundaries — both already parsed by xterm, read by nothing.
- Nonce discipline for any future OSC-133-style marks (children can forge marks); alt-buffer has no scrollback; wide-char/resize grid pitfalls documented with citations.
- Cheap-after-agent-driving: exit-code→task state, title/progress rail, notification→attention, terminal macros. Medium: dev-server node, log-watcher. Two operator taste rulings deferred: shell-integration injection into plain terminals; command palettes.

## Open residue (non-blocking)

1. Grok leader-lane steering of a live TUI (`session/prompt`): plausible, unexecuted — typing already covers steering.
2. Codex approval-behavior confound (Groundwork hooks hypothesis) not fully ablation-closed; operative mechanism verified.
3. Hermes HERMES_HOME auth handling: copied `auth.json` risks consuming a rotating refresh token (source-read `auth.py:3605-3612`) — design choice needed before shipping the effort lever.
4. Hermes TUI self-exit anomaly: bounded non-reproducible (5/5 survived) — QA watch.

## PTY-factory campaign re-smoke (A/B/C)

Campaign: claim contract (A) - seat truth (B) - mid-turn cyan honesty (C).
Not a product surface — operator / QA checklist after seat/drive changes.

### Thresholds (code)

| gate | constant | default | meaning |
|---|---|---|---|
| paste → turn-start | `DEFAULT_PROMPT_STALL_MS` | 5s | no turn-start after paste → `prompt-stalled` attention |
| mid-turn silence | `DEFAULT_TURN_STALL_MS` | 90s | working with no progress fingerprint → `turn-stalled` attention |

Progress fingerprint: PTY `seq` + OSC title/osc9 + bounded grid text + hook key (`turn-progress-watch.ts`). Stall publishes **attention**, never idle (no managed queue drain / re-paste).

### Automated

```bash
bunx vitest run tests/turn-progress-watch.test.ts tests/activity.test.ts \
  tests/managed-terminal-drive.test.ts tests/seat-truth-replay.test.ts \
  tests/factory-claim-prompt.test.ts
```

### Live (Grok + Claude managed seats)

1. **Happy path** — idle seat, factory claim or manual paste: cyan working → settles idle (or green ready/complete). No double paste. Claim text includes sink `target` + task id (A).
2. **False idle (B)** — permission / dialog chrome must refuse paste (`isSeatIdle` false); sticky OSC hooks clear on null same tick.
3. **Mid-turn stall (C)** — after turn-start, freeze progress (no PTY/title change for ≥90s, or lower `turnStallMs` in a test build): seat → **amber** attention, reason/subtitle `stalled — needs operator look`, not cyan. Queued prompts stay queued until a real idle.
4. Record pass/fail in the slice commit message or a short note; name residual risk if a harness cannot be frozen safely.

### Residual

- Live freeze is hard to force without hanging the model; unit/integration covers the transition. Prefer watching a naturally stuck Thinking seat when available.
