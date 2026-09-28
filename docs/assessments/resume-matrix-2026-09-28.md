# Resume matrix: real harness CLIs, 2026-09-28

Suite: `e2e/scenarios/real-harness-resume.spec.ts` (opt-in, spends tokens).

```
JUNTO_FEATURE_PROFILE=all-on npx electron-vite build
JUNTO_HARNESS_KIMI=1 JUNTO_REAL_RESUME=1 scripts/run-e2e.sh e2e/scenarios/real-harness-resume.spec.ts
```

Each run seats the harness through the operator's authoring factory, plays the canvas, and sends a code word as operator prompt mail. It waits for the arithmetic ack, reads the session id off the node, and kills the PTY. A second prompt then cold-wakes the seat. A pass needs three things: the host reports the new generation `resuming`, the reply contains `RECALL-<code word>`, and the node still holds the same session id. Harness CLIs run on the real HOME and its logins. Junto state is a throwaway `JUNTO_HOME` with `JUNTO_HOME_OWNS_SESSIONS=1`. Per-run verdicts, screens and delivery traces go to `/tmp/junto-resume-matrix/`.

Scope is the operator's top six. Amp, Hermes, Muse, fx, OMP, Devin, Antigravity and Prime Agent were not run.

## Matrix

| harness | version | dial | result | cause |
| --- | --- | --- | --- | --- |
| Claude Code | 2.1.284 | `--model haiku` | pass | Resumes the pinned `--session-id` with `--resume`. Needed the mail readiness fix below. |
| Codex | 0.157.1, 0.158.0 | effort low | pass | Needed the rollout capture fix below. 0.157.1: 3 of 4 runs passed. In the miss, the resumed `codex resume <id>` exited with code 1 after 9s (`host.exit code 1`), cause not reproduced. 0.158.0: 1 of 1. |
| Grok | 1.0.41 | effort low | pass | Pin plus `-r`. 2 of 2. |
| Cursor Agent | 2026.09.23-86fc751, 2026.09.26-dd393fe | `composer-2.5` | pass | Pin plus `--resume`. 2026.09.26 dropped `--new-session-id` from `--help`, but it still honors it (the pinned chat exists under `~/.cursor/chats/<ws>/<id>`). On its default model (Grok 4.7 High Fast) one run failed: the chat held both turns (`store.db`), but after the re-typed seat doctrine the model answered "No code word was given earlier in this conversation." |
| Pi | 0.85.1 | `--thinking off` | pass | Pin plus `--session`. 2 of 2. |
| Kimi Code | 2.1.1 | default | blocked | Delivery lands, then the model call fails with `403 Your current subscription does not have access to Kimi Code right now`. No reply means no session, so capture and resume are unproven on this account. |

## Bugs found and fixed

- **A cold-woken seat lost its first mail** (`71a6b15cb`). The first-ready gate took seat state `idle` plus bracketed paste as ready. Claude 2.1.284 sets both about 370ms after spawn, before its composer exists. The mail was pasted and submitted into nothing, and the seat sat at an empty prompt. Trace: `delivery.begin` at +376ms, then `composer: empty`. The gate now also needs confirmed idle. This is the real-Claude half of the cold wake recorded as failing in `docs/brief.md`.
- **Codex never captured its thread id** (`2f2732f3f`, `c09e06019`). The TUI never prints it, and PTY capture only matched hook or notify echoes a plain seat never shows. So every cold wake opened a fresh thread. The seat now reads the first line (`session_meta`) of the root rollout it started in its workspace. A thread with `source.subagent` is never taken.
- **An isolated Junto home refused every resume** (`a957d8f03`). `JUNTO_HOME` (dev and this suite) forced fresh pins. `JUNTO_HOME_OWNS_SESSIONS=1` declares that every pin on the tree was minted there.

## Not a resume fault, handled in the probe

- Claude Haiku under seat doctrine once refused a terse "remember this code word, do not use tools" prompt as a prompt injection. The probe is now worded as a memory game (`bcca0a6fc`).
- Claude shows its folder trust dialog with "No, exit" selected. The probe answers it the way an operator would, moving to "Yes" before Enter. Junto does not accept trust prompts by itself.

## Gaps

- The cold path is a PTY kill followed by a mail wake. A full app restart was not exercised. It resumes from the same node session id through the same spawn plan, but that is inference, not a run.
- `e2e/scenarios/mail-wakes-cold-seat.spec.ts` was not changed or rerun. It still runs Claude on the sandbox HOME, which has no login, with a hand-built seat that has no pin, in an untrusted `tmpdir()`.
- A Claude run failed turn 1 once before screens were being saved, so its cause is unknown. 5 of the 7 Claude runs after the readiness fix passed. The other miss was the Haiku refusal above.
