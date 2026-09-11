# Managed terminal — end-to-end plan to beta

Status: plan of record. Authored 2026-07-26 after the ACP/terminal decision arc and a 63-item executed-probe verification pass. Updated for the shipped stock Prime Agent 0.7.1 harness.
Evidence: [`managed-terminal-verification.md`](managed-terminal-verification.md) (per-harness verified facts + traps) - the 2026-08 probe reports (retired from the repository)
Supersedes for v1: the retired ACP-first and remote-client proposal preserved at
[`factory-harness-integration.md`](factory-harness-integration.md). The current
factory model has one actor runtime and one work admission path: a
Vellum Command-spawned managed terminal using owner-local process-bind.

---

## 1 - The product sentence

**Vellum Command is the canvas for the coding agents you already run.** Not a new agent UI — the terminals you know, on a factory floor you author, driven by a factory you can watch.

The enemy is friction. Every design call below resolves toward: fewer ways to do one thing, fewer installs, fewer hoops, nothing hidden from the operator's eye.

## 2 - The acceptance loop (the definition of beta-ready)

Verbatim from the operator; this is the test:

1. Create an agent node. Open it. Use the picker. **It opens fine and I can talk to it.** (Standalone terminal-with-a-harness works, connected to nothing.)
2. Open an unconnected agent node → the **base doctrine** is injected (Vellum Command intro, seat doctrine, worker loop, base CLI contract) with no edge contracts; detached terminals (no canvas node) get **silence**. Edge contracts are compiled from the node's edge reality at spawn, and injected per-edge as new edges connect (rising-edge slot injection).
3. Create a Claude Code node, connect it to a tasks node, add a task, **start the simulation.**
4. The task is **claimed by the agent**, which **starts working autonomously.**
5. Double-click the node → **the already-running TUI**, live, mid-session.
6. Among its first messages: **`vellum-command onboard`** via the station CLI — it worked, and it injected the **task data and metadata**.
7. Work **continues until the task is complete.**
8. **Blocked states are visible** on the canvas.

Nothing ships as beta until this loop runs on all five covered harnesses, including the shipped Prime Agent extension (with per-harness state fidelity as specified in §9).

## 3 - Settled rulings (do not relitigate)

| ruling | consequence |
|---|---|
| **Managed terminal is the only v1 agent surface** — full interactive TUI in a Vellum Command-owned PTY | no headless worker drive (`claude -p`, `codex exec`) — that would be "a different UI leveraging their harness", which the operator's ToS line forbids |
| **The terminal node IS the actor — there is exactly one actor kind.** | a terminal is not something a node *has*; it is what the node *is*. One way to build a worker: variation lives in the node's *properties* (harness/profile/model/effort/permission mode), never in a second actor kind and never in *modes* of the action. An **unbound** terminal (no binding yet) is geography, not a second kind. Corrected 2026-07-26: an earlier revision of this row said "Actor = command template. Terminal = geography," which inverted the labels and read as licence for an `agent` kind distinct from `terminal`. See [`factory-consolidation-plan.md`](factory-consolidation-plan.md). |
| **Zero writes to the user's harness config, ever** | injection is flags + env + project-local files + typed input only |
| **Synthetic homes (`CODEX_HOME`/`HERMES_HOME`) VETOED** | no symlinked auth, no shadow config trees |
| **`--dangerously-bypass-hook-trust` BANNED** | it would run the user's own unreviewed hooks. Codex PreToolUse deny is dropped; blocking is enforced by CLI-returns-Blocked + Ctrl+C |
| **Any harness prompt is a product state, not an engineering problem** | permission prompt, hook-trust modal, directory-trust modal, un-runnable CLI → all surface as *attention* on the node. One mechanism, all harnesses, all prompt types. Never allowlist around it — that silently loosens the user's security posture |
| **Tool surface is the station CLI, not MCP** | bash is universal → no per-harness MCP parity hole; process-bind identity already law |
| **ACP is hidden, not removed** | dormant code, revives with the embedded-Worker/native-chat timeline (§14) |
| **Covered harnesses: Claude Code, Codex, Grok, Hermes, Prime Agent. OpenClaw out.** | Prime Agent is the stock 0.7.1 CLI behind one app-owned daemon per binding. OpenClaw's agent runs in a shared Gateway daemon, so process-bind, interrupt, and injection still break by construction. |
| **Herdr is a GEOGRAPHY node** (ruling 2026-07-26 — not "legacy", not deleted; just Herdr). Learn from, never fork/vendor. | it keeps its agent-state display for people who want panes without the factory. It holds no seat, no ports, no inbox, and no effort will be made to make it participate. Its detection design is portable; its config-writing installer is not |
| **No tiers — a node is an ACTOR or it is GEOGRAPHY** (ruling 2026-07-26, supersedes Tier 1/2/3) | actor = a Vellum Command-spawned template terminal, the covered harnesses, full stop. Everything else — raw terminals the user opens, herdr, pages, regions, notes — is geography. **Kind is fixed at node creation and never derived from what process happens to be running.** If answering "is this an actor?" would require runtime inspection, the design is wrong |
| **A dead agent process never degrades to a clean shell** | an actor terminal whose harness exits goes to an explicit error/restart state. Otherwise an actor silently becomes geography — the exact ambiguity the no-tiers ruling removes. Process is mortal; kind is permanent |

## 4 - What already exists (verified by code read, 2026-07-26)

This is why the plan is short. Most of the factory is built.

| subsystem | state | files |
|---|---|---|
| PTY ownership, spawn, byte journal, resize, exit, sealed kill plane | **built** | `src/main/vellum-command/term/local-host.ts` (single data hook at `observeData:698`), `plane.ts`, `router.ts`, `sessions.ts`, `release-fence.ts`, `shell-policy.ts` |
| Remote terminals over SSH | **built** | `term/remote/`, and `hermes --profile X -m Y` over `ssh -t` verified working (R1–R3) |
| Renderer terminal surface (xterm) | **built** | `src/renderer/components/terminal/{TerminalSurface,TerminalCard,TerminalWizard,TerminalInventory}.tsx` |
| Work-control server: all ops + scopes + process-bind identity | **built** | `src/main/vellum-command/work/{control,authz,caller-resolve,live-seat,service}.ts` — ops include `ping doctor capabilities onboard tasks.create tasks.list tasks.show tasks.rules tasks.check tasks.claim tasks.update msg.list msg.send request.escalate artifact.publish` |
| **Station CLI, agent-native** | **built** | `src/cli/` — `vellum-command onboard \| doctor \| capabilities \| tasks list\|claim\|update \| msg list\|send \| escalate \| artifact publish \| browser \| schema \| examples`; JSON-in/JSON-out, batch-capable, `dist/vellum-command` via `bun run cli:build`; browser commands retain their host-local control socket behind the one agent-facing command |
| **Mailbox with transport abstraction** — pending-until-live, deliver-on-append + deliver-on-attach, pause-aware | **built** | `src/main/vellum-command/work/message-delivery.ts` (`MessageDeliveryTransport`) — today: ACP `chatPrompt` + herdr control stream |
| Kernel tick / pulse: claim routing, pulse composition, armed/paused state, execution snapshots | **built** | `src/main/vellum-command/kernel/{cycle,evaluate,service}.ts` — incl. `composePulseMessage`, `MIN_LIVE_PULSE_SPACING_MS` |
| Factory physics: tasks pull queue, seats, blocking as worker-state, on-fire/on-ice, claim contract | **built** | see `architecture-factory-physics.md`, `vellum-factory-simulation-model` |
| Attention/alert surfaces | **partially built** | `alert-attention.ts`, `alert-queue.ts` exist |
| vellum prism plugin (7 tools + session-start hook + global rule + skill) | **built, to be pruned** | `packages/vellum-plugin/` |

**The gap is exactly four things:** (a) main has no idea what any terminal's screen says, (b) no managed-terminal transport on the mailbox, (c) no templates/picker, (d) instruction injection is a global-config hook instead of per-session.

---

## 5 - Phases

Each phase ends in a commit. Phases 1–2 are the bulk; 3–7 are wiring to surfaces that exist.

### Phase 1 — The observer (main-process grid + signal parsing)

**Why:** every drive decision (is the input box idle? is a dialog up? did the title flip to working?) needs the screen, and today the only interpreter of the byte stream lives in the renderer and is disposed on unmount (`TerminalSurface.tsx:207/266`). Autonomous workers run with windows closed — exactly when the interpretation must exist.

- Add `@xterm/headless` (currently absent; only `xterm` + `addon-fit` are present).
- New `src/main/vellum-command/term/observer/`: one headless terminal per live session, fed from `observeData:698` (the single insertion point — every byte already flows through it with a seq).
- Register the handlers Vellum Command currently discards (zero OSC/CSI handlers exist in `src/` today):
  - **OSC 0/2** title — the primary fallback state feed across the covered harnesses.
  - **OSC 9** — Claude's `9;4;3`/`9;4;0` working flag, Codex's `]9;<msg>` turn-complete, Grok's `9;4` binary.
  - **CSI ?2004** bracketed-paste mode — protocol-level "a readline input box is live"; the truest typing gate.
  - **CSI ?2026** synchronized output — exact repaint boundaries, better than a debounce timer.
- Grid region extraction (port herdr's *concept*, not its strings): `prompt_box_body`, `bottom_non_empty_lines(n)`, `footer_line`, `after_last_horizontal_rule`.
- Sanitize titles: untrusted model output — 256-char cap, strip control chars, clear retained evidence on session change.
- Attach path change: renderer gets a **grid snapshot + deltas** instead of byte-journal replay (the 512KB ring can trim mid-escape-sequence and corrupt a replay — `local-host.ts:200,875-880`).

**Acceptance:** unit tests over recorded PTY captures from the probe artifacts; the two trap cases the probes surfaced — **wide-char/CJK column arithmetic** (`getWidth()` returns 0 after a wide cell; `IBufferLine.length` may exceed columns after resize) and **mid-resize disagreement** (`reflowCursorLine` defaults false → last-line rules are *wrong*, not merely stale). Both grids pin the same `unicode.activeVersion`. Mark handling synchronous (async parser handlers have poor throughput per the typings). No consumers yet → zero behavior change.

### Phase 2 — Agent state machine

- Four states: `idle | working | attention | unknown`. (`done` is not a state — it's idle + unseen, computed at presentation, per herdr's design.)
- Three feeds, ranked per harness: **hooks** (Claude via `--settings`, Grok via `.grok/hooks` + `events.jsonl`, Hermes via project plugins) → **OSC/byte signals** → **grid rules**.
- Rules as **data** per harness (a rule pack shipped in-app, updatable without a release), patterns derived from **our own captures** — never herdr's literal strings.
- Debounce, ported verbatim from herdr's tuned values: 300ms tick → 100ms while holding, 3 confirmations, 700ms cap, 800ms sustained-blocker heartbeat, 3s post-change grace. **Debounce only the low-confidence Working→Idle drop** — visible idle chrome publishes immediately.
- `attention` sources per harness (§9) — including the modals that emit no title and must come from the grid (Codex dir-trust + hooks-review; Claude permission prompt).
- Emits seat state into the kernel; feeds `alert-attention`/`alert-queue`.

**Acceptance:** replay-driven tests per harness from recorded captures: idle→working→attention→idle transitions with no flapping; a permission prompt is never read as idle (the failure that would type into a dialog).

### Phase 3 — Node UI: attention and blocked

- Node **requesting attention**: amber + exclamation mark.
- Nodes **blocked behind it**: red. (Consistent with existing physics — blocking is worker-state, not a cascade; see `vellum-factory-simulation-model`.)
- Uniform across every prompt type and every harness. A codex hook-trust modal reads exactly like a Claude permission prompt reads exactly like "the CLI could not run."
- Design from the canvas act inward, grounded in the rendered app — capture with e2e stills before claiming the surface works.

**Acceptance:** loop step 8. E2E: force each prompt type per harness, screenshot the canvas, confirm amber/exclamation + red downstream.

### Phase 4 — The drive channel (typing)

- Add a **managed-terminal transport** to `MessageDeliveryTransport` (`message-delivery.ts`). The mailbox, pause-awareness, pending-until-live, and deliver-on-attach semantics already exist — the new transport's `deliver` is state-gated instead of merely live-gated: **deliver only when the seat is idle.**
- Write recipe (per-harness timings in §9): bracketed paste (`ESC[200~ … ESC[201~`) as **one write**, then a **separate** CR write. Never LF (inserts a newline everywhere). Never payload+CR in one write (verified: Codex silently never submits).
- **Interrupt:** Ctrl+C (0x03) — never ESC (rebindable, context-multiplexed, swallowed by vim mode). Guard rails from the byte-timing probe: a single mid-turn 0x03 is always safe; two 0x03 while **idle** must never be <~1.0s apart (Claude self-exits in the 0.509–1.009s window; Codex exits immediately on idle 0x03 with an empty composer).
- **Delivery ack:** the next state transition (or hook event) is the ack. Stall check: no turn-start within ~5s → retry once, then attention. (Port herdr's `agent_prompt_stalled` concept; herdr has *no* gating at all, so ours is strictly stronger.)
- **Grok clipboard hazard:** pre-flight `osascript clipboard info` before any paste; if an image is on the clipboard, **abort and surface attention** — do not silently clear the operator's clipboard.
- **Hermes readiness:** never gate on a byte-stream quiet-gap — the `Installing TUI dependencies…` window (~1–2s, ssh especially) swallows Ctrl+C and kills the session. Gate on a positive UI signal.

**Acceptance:** loop steps 4 and 7. A typed message lands as one submitted prompt on all five covered harnesses, mid-turn messages queue and drain at the turn boundary, and an interrupt never exits a session.

### Phase 5 — Templates (actor nodes) + the picker

- A template is **data**: `{harness, argv-spec, env-spec, injection-spec, capability-badges}`. The five covered templates.
- **The picker is the authoring act** — progressive specificity, click at any level to accept defaults below:
  `harness → [profile (hermes)] → model → effort`
  Click `Codex` → spawn with defaults. Hover → models → click `gpt-5.6-luna` → spawn with that + default effort. Hover the model → efforts → click → fully specified.
- Enumeration sources (all verified, all cacheable strings — cache with explicit refresh, never block the hover):
  - Claude: `~/.claude.json → additionalModelOptionsCache` + aliases; efforts = 6 levels (`--effort`/`CLAUDE_EFFORT`).
  - Codex: **`codex debug models`** (models + per-model effort lists).
  - Grok: `~/.grok/models_cache.json` (or ACP init); efforts = high/medium/low.
  - Hermes: `hermes profile list` (~1s, parseable, no `--json`) + `~/.hermes/profiles/*/config.yaml`; models from `provider_models_cache.json` — **validate, staleness is proven** (exit 0 with an HTTP 404 body); effort has no flag → typed `/reasoning` (verify session-scoped) or omitted in v1.
  - Prime Agent: `prime-agent model list`; effort is `--thinking off|minimal|low|medium|high|xhigh|max`.
- **Spawn env scrubbing (mandatory):** strip the exact shared traps (`CLAUDE_CODE_CHILD_SESSION`, `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `PI_CODING_AGENT`, `NO_COLOR`, `FORCE_COLOR`) and every `PRIME_AGENT_INTERNAL_*` key. Apply the same predicate after host injection, so an injected value cannot recreate a nested or internal process role.
- Inject `PATH` so `dist/vellum-command` resolves, including its canonical `vellum-command browser` dispatcher; inject seat/socket/token env (verified to reach agent shell subprocesses on the original four; Prime Agent receives them through its isolated binding daemon).
- Session id: pin where possible (Claude `--session-id`, Grok `--session-id`), capture otherwise (Codex: SessionStart hook > `CODEX_THREAD_ID` > notify > rollout; Hermes: `HERMES_SESSION_ID` env; Prime Agent: built-in reporter, with scoped `list --json` as lifecycle evidence). Persisting captured identity on the authoritative seat is required before cold wake; Prime Agent capture is currently process-local diagnostics and no spawn path consumes it.
- **Prime Agent runtime isolation:** the authorial template remains plain stock argv (`--model`, `--thinking`, `--append-system-prompt`, positional prompt, `-r`). At live spawn only, Vellum Command registers its ready reporter route, owns one foreground wrapper generation per binding, requires the separately installed executable to report the exact complete version `0.7.1`, then `exec`s `prime-agent --mode daemon --daemon-socket <unique>` in that same generation, binds the exact daemon and PTY generations, and routes the TUI through that socket after bounded command-first `list --json --daemon-socket` probes. The daemon flags are help-visible stock 0.7.1 low-level mode; upstream still calls the daemon internal infrastructure, so Vellum Command invokes the process and imports no private module or removed command hierarchy. The socket is never persisted authorial config. Teardown revokes both identity generations before async cleanup, validates and stops only top-level roots through public exact-socket list/stop, proves the roster empty, then signals the exact owned daemon lease. Signaling the daemon first is unsafe because detached workers can recover a missing supervisor. A replacement is never bound or PID-signaled; uncertain crash cleanup is non-clean and retains its disposable directory.
- Per-harness spawn traps: Grok **requires a git cwd** (else a modal swallows the prompt); Hermes needs **`chat --tui -q`** (`-z` is headless); Codex resume **does not inherit flags** — re-pass everything; Prime Agent must never fall back to the default shared daemon or global `shutdown`.

**Acceptance:** loop steps 1, 3, 5. Also: template row + capability badges visible in the node UI so a harness with weaker state fidelity is honest about it.

### Phase 6 — Instruction injection + plugin disposition

This is the piece the operator flagged as needing to be strong. **Two tiers, because two covered harnesses have no system-prompt flag.**

- **Tier A — system prompt at spawn** (verified): Claude `--append-system-prompt`; Grok `--rules` (appends) or `--agent <file>` (frontmatter + body appended, and `tools`/`disallowedTools` gating verified enforced); Prime Agent repeatable `--append-system-prompt`.
- **Tier B — first typed message** (Codex, Hermes): the same text delivered as the session's first typed prompt. Costs a little context; gains full visibility in the transcript, which suits the legibility doctrine. (Candidate to check later: a codex `-c` instructions-file key — unverified, do not assume.)
- **Injected payload** (the content the pruned global rule used to carry):
  1. Worker doctrine — factory seat, pull queue, claim-is-factory, requests block, artifacts never block, identity is process-bind, reach is edges.
  2. The CLI contract — call **`vellum-command onboard`** at session start and after compaction; the work op table plus `vellum-command browser` for `browser.automate`; errors (`ScopeError`, `ClaimConflict`, `RuntimeDown`, `Blocked`) are ground truth.
  3. Seat context — seat ref, connected targets.
- **Then the task arrives as a typed prompt** carrying the claim. `vellum-command onboard` returns seat + role + connected targets + claimed task metadata — which is loop step 6 exactly.
- **Plugin: DROPPED entirely** (operator ruling 2026-07-26 — supersedes the earlier "prune to an opt-in tier"). There is no user-installed tool surface in anyone's harness config. `packages/vellum-plugin/` goes away; the doctrine *text* becomes the injected payload and `tools/shared/work-client.ts` folds into whatever needs the socket. Reason: an opt-in tier re-introduces the ambiguity the no-tiers ruling exists to kill — "this terminal has the integration, so is it an actor?" is a question with no good answer. Injection happens **only** through a Vellum Command-spawned template.

**Acceptance:** loop steps 2 and 6. Unconnected agent → nothing injected, nothing typed. Connected agent → onboard called by the agent itself, task metadata in its context, visible in the TUI.

### Phase 7 — Tool surface completion (CLI)

The CLI exists; the deltas are:

- **`vellum-command escalate`** — the sole agent-facing request verb. It emits the durable internal `request.create` fact plus **blocked-seat semantics**: files the request, marks the seat blocked, returns a stop directive. Optional bounded **hold**: block on the socket until the human answers and return the answer in-band, so the agent continues the same turn (bound below the harness's bash timeout; Claude's is settable via injected `--settings` env). Timeout → return the blocked directive.
- **Blocked enforcement in the server**: while a seat is blocked, every work/page op returns `Blocked` with a stop directive. Transport-independent — this is the layer that works even where hooks don't (Codex).
- **Page automation ops** — expose the existing edge-gated page capability to the agent's CLI. Process-bind gives the agent principal; the capability matrix already grants `agent` principals edge pages.
- **`msg.*` revived for agent-to-agent mail** — agents never touch another PTY. An agent sends via the work plane; the **kernel** delivers by typed injection at the recipient's turn boundary, tagged `[factory mail from <seat>]`. Edges gate who may mail whom; the kernel owns pacing (cooldown + per-tick budget), so a mail loop drains at human-visible speed on a visible canvas.
- **Ergonomics for a typing agent:** ops are typed by an LLM into a TUI, so error messages must be instructive and self-correcting, and `vellum-command schema`/`examples` must cover every op. Keep JSON-in/JSON-out (already batch-capable).
- **Broadcast** — same mailbox, N seats, eventually-delivered per seat (a busy seat receives at its turn boundary). Shift-click → type → broadcast.

**Acceptance:** escalate blocks and unblocks cleanly on all five covered harnesses; a blocked seat's tools are dark; broadcast lands on N seats.

### Phase 8 — Usage rail (per station)

Replaces the Codex Bar dependency; per-station, cross-account, and Linux-viable.

| harness | tokens/cost | plan/weekly limits |
|---|---|---|
| Claude | OTEL via injected `--settings {"env":…}` (verified end-to-end) | `~/.claude.json → cachedUsageUtilization` — ⚠ refreshes only when `/usage` is opened, so the rail must trigger it |
| Codex | OTLP export works (verified live sink, per-event token fields) | **not in OTLP** (verified absent) → `/status` grid scrape |
| Grok | per-turn `updates.jsonl` (`costUsdTicks`, tokens); `signals.json` context | `/usage` TUI text scrape |
| Hermes | `state.db` per session (tokens, `estimated_cost_usd`, billing mode); `hermes insights` | subscription-included; no separate limit surface |
| Prime Agent | `/usage`; structured usage and model-cost fields in socket-scoped `list --json` | provider-dependent; no separate plan-limit claim |

**Acceptance:** a per-station usage rail with tokens + cost per seat and weekly-limit state where available. Do not claim "Codex Bar replaced" until the two scrape paths are live and tested.

---

## 9 - Verified harness mechanism matrix (target template spec)

Every row below is backed by harness probes — see
[`managed-terminal-verification.md`](managed-terminal-verification.md) for
receipts. This is not a current Vellum Command implementation matrix. Release truth
lives in `src/shared/managed-terminal-templates.ts`: Prime Agent's built-in
per-session reporter is the sole zero-write hook feed currently on. Codex
captures a thread id and cold-wakes with `codex resume <id>`; Hermes proves a
session in `state.db` and cold-wakes with `-r <id>`.

| | Claude Code | Codex | Grok | Hermes | Prime Agent 0.7.1 |
|---|---|---|---|---|---|
| TUI + auto-fired prompt | `claude "<p>"` | `codex "<p>"` | `grok "<p>"` (needs git cwd) | `hermes chat --tui -q "<p>"` | socket-routed `prime-agent "<p>"` |
| instruction injection | **A** `--append-system-prompt` | **B** first typed msg | **A** `--rules` / `--agent` | **B** first typed msg | **A** `--append-system-prompt` |
| hooks (per-session, zero-write) | ✅ `--settings` (30 events, deny works) | ❌ dropped (trust modal; bypass banned) | ✅ `.grok/hooks` + `events.jsonl` | ✅ project plugins + `HERMES_ENABLE_PROJECT_PLUGINS=1` (21 events) | ✅ stock built-in lifecycle reporter; no config write |
| state feed rank | hooks → OSC → grid | **OSC → grid** (+`notify` turn-complete) | hooks/events.jsonl → OSC → grid | hooks → OSC (`--tui` only) → grid | **built-in reporter → OSC9/133 → grid** |
| attention source | grid (OSC can't distinguish) | **OSC title `Action Required`** + grid for startup modals | events.jsonl `permission_requested` + footer | OSC title `⚠` | built-in blocked events → grid overlays |
| permission mode at spawn | `--permission-mode` | `-a` (template property) | `--permission-mode`/`--allow` | `--yolo` | none; `--autonomous` is not a permission enum |
| session id | pin `--session-id` | capture (hook > `CODEX_THREAD_ID`) | pin `--session-id` | capture (`HERMES_SESSION_ID`) | capture (reporter > scoped `list --json`) |
| cold wake | `--resume <id>` (re-pass flags) | `codex resume <id>` (re-pass flags) | `grok -r <id>` | `chat --tui -r <id>` (re-pass `-m`) | `-r <id>` (re-pass model/thinking) |
| typing | paste + CR, 0ms ok | paste + **separate** CR | paste + CR, ≥1.5s after spawn | paste + CR | positional at spawn; paste + CR live drive not re-probed |
| `/compact` | ✅ + Pre/PostCompact hooks | ✅ | ✅ | via `/` commands | available; live drive not re-probed |
| effort at spawn | ✅ `--effort` | ✅ per-model list | ✅ high/med/low | ✅ `--reasoning` (8 levels) | ✅ `--thinking` (7 levels) |
| daemon ownership | n/a | n/a | n/a | n/a | one foreground daemon per binding; roots stop before exact daemon lease |
| remote (ssh) | — | — | — | ✅ verified end-to-end | ✅ enabled (daemon plane is host-local on the Remote); ssh drive not re-probed |

## 10 - QA plan

The consolidation's whole point: **QA scales with template rows, not with surfaces.** One drive path, five covered templates.

- **Per harness, per template row:** spawn → inject → onboard → claim → work → escalate → block → answer → resume → complete. Plus the trap list from §9 as explicit regressions.
- **Replay tests** (cheap, deterministic, no model spend): recorded PTY captures per harness drive the state machine and the typing gate. This is the bulk of automated coverage.
- **E2E stills** for every canvas state (idle/working/attention/blocked) — never describe the UI from a code read; capture it (`vellum-e2e-capture-recipe`).
- **Live smoke** (costs plan usage, keep minimal): one full acceptance loop per harness before release.
- **Version pinning:** several load-bearing behaviors are undocumented (Claude's `--settings`-as-hook-source; Hermes's hidden `--profile`). Prime Agent support is probed against stock 0.7.1, including foreground daemon mode, socket routing, built-in reporter, and public list/stop. Pin probed versions in the template pack and re-smoke on harness updates.

## 11 - Beta checklist

1. Acceptance loop (§2) green on all five covered harnesses.
2. Zero writes to user harness configs — audited, with a test that fails if a spawn touches `~/.claude`, `~/.codex`, `~/.grok`, `~/.hermes`.
3. Attention/blocked surfaces correct for every prompt type per harness.
4. Escalate → block → answer → resume, incl. cold wake after an app restart.
5. Plugin pruned; nothing lowers into user configs by default.
6. Usage rail live per station.
7. ACP + herdr + hermes-chat hidden behind settings; no dead UI.
8. Capability badges honest per harness.
9. Remote station: hermes over ssh in the loop (the verified remote path).
10. Docs: the four residue items (§13) either closed or documented as known limits.

## 12 - Deferred (explicitly not v1)

- **Embedded Worker (forked Pi)** — tabled until the monotool exists. The dossier (MIT, white-label `piConfig`, `PI_CODING_AGENT_DIR` isolation, injectable credentials, per-message cost) stays valid. This is unrelated to the shipped Prime Agent harness: Vellum Command uses stock stable Prime Agent only and will not fork it.
- **Cloud workers** — the zero-harness answer; Vouch-shaped, keys server-side, no consumer-ToS exposure. Empty-state should point at it to measure demand.
- **ACP revival + native chat UI** — arrives with the Worker, not before. Grok's leader lane (a second ACP client can `session/load` a *live TUI's* session and replay its updates) is a promising future observability path.
- **TUI automation horizons** — dev-server node, log-watcher, exit-code→task state, terminal macros, OSC 133 semantic prompt marks (with nonce discipline: children can forge marks). Cheap once Phases 1–4 land. Two taste rulings deferred: shell-integration injection into plain terminals; command palettes typed into any terminal.
- **Round-robin workers, harness-per-task, model-per-task** — trivial once templates are data and every harness shares one drive path. Post-beta.

## 13 - Known residue (non-blocking, tracked)

1. Grok leader-lane **steering** of a live TUI: plausible, unexecuted. Typing covers steering.
2. Codex approval-behavior confound (Groundwork-hooks hypothesis) not fully ablation-closed.
3. Hermes `/reasoning` persistence: must confirm session-scoped before shipping effort for hermes.
4. Hermes TUI self-exit anomaly: bounded non-reproducible (5/5 clean) — QA watch item.
