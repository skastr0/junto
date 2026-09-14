# tests/pty-e2e — PTY repro harness (keystone)

Deterministic, byte-driven reproduction of Vellum Command's PTY-system defects. **Repro-first:
every red test asserts CORRECT behavior (the product law) and fails on current code —
that failure is the proof. Fixes must turn tests green WITHOUT editing them.**

## Run

```bash
bunx vitest run tests/pty-e2e                 # full harness
bunx vitest run tests/pty-e2e/scenarios/drive-law.test.ts   # drive-loop repros
node tests/pty-e2e/pty-capture.ts             # regenerate the real-capture corpus (node, NOT bun)
```

## Architecture

```
real TUI bytes (19 captures, 5 harnesses)          P3 receipts (probe docs)       scripted TUI (byte-faithful model)
        │                                                     │                            │
        └───────────────► tests/pty-e2e/runner.ts ◄───────────┘                            │
                              │ fixture loader (P1 > P2/P3)                                │
                              │ chunker: whole / split-at-escapes / split-mid-sequence     │
                              │ canonicality gate (real SessionObserver)                   │
                              ▼                                                            │
                    REAL SessionObserver (@xterm/headless) ◄───────────────────────────────┘ (emits bytes)
                              │ snapshots
                              ▼
                    REAL SeatStateRuntime + rule packs ──► REAL ManagedTerminalDrive ◄── writes (paste/CR/Ctrl+C)
                              │ seat events (working→onTurnStart, idle→onSeatIdle, ipc.ts:1289-1294 wiring)
                              ▼
              scenario assertions (state / isSeatIdle / write log / attention log / receipts)
```

Fakes are allowed ONLY at OS boundaries: PTY spawn (fixture bytes), persistence (recording store),
clock (vi fake timers), and the scripted TUI process model. All logic under test is production code.

## Fixture format (P1 real captures)

`tests/pty-e2e/corpus/<harness>/<scenario>.jsonl` — one JSON per line: `{"t": ms, "b64": base64}`
plus `manifest.json` (observed title/osc9/glyphs/modes, expectedScreen, sanitized flag).
Current captures: Claude, Codex and Devin have `startup-idle`, `type-echo`,
`paste-chip` and `working-turn`; Grok has those four plus
`permission-returns-idle`; Pi has only `startup-idle` and `type-echo`.
Manifest skips are missing evidence, not passing scenarios. The registry has
14 external harnesses; this corpus covers five. See the
[full matrix assessment](../../docs/assessments/pty-matrix-2026-09-14.md).

The corpus exists to feed REAL terminal byte streams through the observer —
escape sequences, prompt markers, OSC titles/9;4 progress, paste chips, and
working-state chrome — not to preserve what a particular operator's harness
said. Sanitized: HOME/USER/HOST/CWD/SESSION/EMAIL/TOKEN → placeholders, plus
post-capture redaction of operator-identifying content (account names, plan
tiers, configured permission modes, hook/plugin text, installed
skill/prompt/extension inventories) documented per-harness in each manifest's
`redactions` list. That redaction is content hygiene, not a completeness
claim: the scrub gate certifies the placeholder classes it checks, and the
manifests record what was neutralized by hand.

The recorder (`pty-capture.ts`, beside this README) runs each harness under an
isolated HOME (`/tmp/vellum-capture-home/<harness>`) and pins per-harness
config-dir env overrides (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`,
`PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`) inside it — pi resolves
`PI_CODING_AGENT_DIR` before HOME, so an inherited override alone would still
load operator config. Harnesses whose credentials only exist under the real
home fail closed and record `blocked` rather than reading operator config;
`PTY_CAPTURE_OPERATOR_HOME=1` opts back in explicitly (parent env inherited
as-is, no pins).

## Add a repro (checklist)

1. Pick the defect from /tmp/vellum-defect-coverage.md (or a new finding).
2. Fixture: prefer P1 real bytes (capture or reuse); else P2/P3 from verified probe receipts; never invent sequences.
3. Feed through the REAL observer; run the canonicality gate; run all 3 chunk modes (must be identical).
4. Assert CORRECT behavior in the test name: `BUG-<id>: <expected>`.
5. It must FAIL on current code (that is the repro) and PASS once fixed — without editing the test.

## Current status

See /tmp/vellum-repro-ledger.md (red tests = reproduced defects) and /tmp/vellum-defect-coverage.md
(46-defect inventory with coverage status).
