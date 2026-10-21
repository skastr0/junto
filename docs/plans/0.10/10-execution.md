# 10 Execution

Status: started 2026-10-21. Owner: product-lead. This file is the work
breakdown; 01 to 09 are the design. product-lead keeps this file current;
everyone else reports by mail and on the needs-you feed.

## How we work

- **Everything starts now, in parallel.** No phase waits on another. A track
  that needs another track's code builds against its shared contract and a
  local stand-in, then switches over when the real one lands.
- **Contracts first, within hours.** Each contract below lands as types plus
  tests in `src/shared/` before its layers build on it. Its owner mails every
  consumer when it lands. A consumer that needs a change mails the owner; the
  owner decides.
- **Single machine first.** Every resource write goes through
  `ResourceCommand` (02) from day one. Until remote's channel lands, the local
  core is the editing machine and rules locally. Nothing else changes when
  the channel arrives.
- **The old path dies with the new one.** A track is done when its old code,
  flags, tables, docs and tests are gone and `bun run verify` passes.
- **Commit in small atomic pieces, as you go.** Your own files only, by
  explicit path. Never touch another agent's uncommitted change.
- **Proof is types first** (operator, 2026-10-21). Contracts are typed so
  misuse fails `tsc`: closed unions, branded ids, exhaustive matches,
  type-level tests where a shape matters. Unit tests on pure modules and
  reducers. `bun run typecheck` and the unit tests gate every commit. Real-app
  and e2e runs are expensive: they come later, batched per milestone, not per
  change.
- **Review.** Every change gets a review from a seat that did not write it.
  Tokens, type or shared UI components also go through product-typography.
- **The operator reviews through the needs-you feed, with pictures.** Every
  UI change is reported with `junto feedback` carrying screenshots
  (`--attach`), before and after (`--compare`) or a video (`--video`), and
  the commit (`--commit`). Every decision goes as `junto escalate` with the
  options and a recommendation. Blocked work goes as `junto blocked`. Never
  ask the operator anything inside mail.
- **Leads mail product-lead** when a contract lands, a track finishes, or a
  dependency slips. product-lead updates the tracker below.

## Contracts (land first)

| Contract | File | Owner | Consumers |
|---|---|---|---|
| Region reach | `src/shared/region-reach.ts` | canvas | cli, pty, product, remote |
| Resource command and ruling, local ruler | `src/shared/resource-command.ts` | remote | canvas, cli, product |
| Error types (`Stale`), general candidates, ref resolution, node ref `item` | `src/shared/work-control.ts`, `src/shared/node-ref.ts` | cli (cli-protocol) | everyone |
| Mention ref, thread subject, anchor | `src/shared/mention.ts`, `src/shared/mail-threads.ts` | product (product-feed) with pty | cli, canvas |
| Task model: states, assignment, stamps, number, `flows` | `src/shared/task.ts`, `src/shared/work-model.ts` | canvas | cli, product, pty |
| Artifact model and edits | `src/shared/artifact.ts` | product (product-shell) | cli, remote, canvas |
| Automation model | `src/shared/automation.ts` | canvas | cli, product, pty |
| Seat since | `src/shared/seat-since.ts` | pty | cli |

## Tracks

### canvas (canvas-lead)
- C1 Region reach contract, `admitPure` reach branch, `connectedCapabilities`
  seats only, resolver reach input with cli. Physics doctrine rewrite with
  remote (`architecture-canvas-physics.md`, `security-doctrine.md`).
- C2 Deletions: requests node, bulletin board (after pad drops `BoardAuthor`),
  factory tick and claim prompt, task edge roles and admission, `cron`,
  `relay`, `watcher`, `timer`, Region Pulse, legacy edges, `from-legacy-row`
  (floor v13), pad and sheet node kinds. Blocked mark moves to the seat ring.
- C3 Migration chain: v26 deletions now; every other step numbered when it lands, from canvas-model's slot list.
- C4 Task model, state machine, assignment invariants, stamps on the verdict
  tables, task numbers, `flows`, state remap. Tests for state machine, rules
  and flow graph.
- C5 Automation model and runner on the editing machine, claim slots renamed,
  loop limits, firing history. Seat-state rules from pty.
- C6 With remote: 02 queued writes section.

### remote (remote-lead)
- R1 With canvas: 02 queued writes design (pending state, ruling order,
  refusal after the fact, invariants under partition).
- R2 `ResourceCommand` contract and the local ruler (day one), then the
  `commands` channel, rulings keyed by sending installation, facts with
  opId, exchange filter opening, byte-aware paging, read your writes, the
  queue.
- R3 Canvas copy: every non-host node except notes, geometry and labels;
  page stubs.
- R4 Browser out of Junto Remote: capability bit, station authority, host
  arguments, machine bundle without the browser CLI (with cli's define).
- R5 Hermes host identity out of every core, settings wire field, host
  registry spec for canvas's migration.
- R6 Automation author kind admitted only from the editing machine.

### cli (cli-lead)
- L1 Contracts: `Stale`, general candidates, ref resolution, node ref `item`,
  CLI-minted opId with `--op-id`.
- L2 `junto task` (rename, per-verb schemas).
- L3 `junto artifact`, sheet markdown projection.
- L4 `junto automation`.
- L5 `junto browser` ported to the standard envelope, `--tab`, kept out of
  the machine build.
- L6 Onboard output: order, `commands`, reach section, guidance line,
  `junto since`, signal list paging. Deleted commands removed from discovery.

### pty (pty-lead)
- P1 Cut the chat service delete lease (first, unblocks Hermes removal).
- P2 Hermes integration removal, main side: `hermes/`, `adapters/hermes.ts`,
  `chat/`, snapshots and the kernel subscription (with canvas). Hermes
  terminal harness stays.
- P3 Seat since contract and onboard sections.
- P4 Subject thread delivery: reply header names the subject, the
  `mail-threads.ts` task drop and the `control.ts` refusal go, mention and
  stamp and assignment notices.
- P5 Seat-state trigger rules for automations.

### product (product-lead)

| Seat | Work |
|---|---|
| product-shell | Delete pinning. Then the artifact contract and the Artifacts node (sidebar, editors, comments rail). |
| product-settings | Delete the Providers card and Hermes settings. Then the Automations node UI. |
| product-attention | Delete the chat UI and its hidden entry points (`legacy-surfaces.ts`). Delete requests and board UI with canvas. Then the browser: tabs, chrome, box comments. |
| product-modals | Tasks UI on the new model: backlog, assign, start, finish, reviewers and stamps, layers, numbers. |
| product-feed | Mention, thread subject and anchor contract with pty. Task and artifact attachments in the feed; mentions in `SignalReply`. |
| product-keyboard | `MentionCombobox` on `Combobox`, availability hooks, keyboard. |
| product-typography | Visual language for mention chips, artifact and automation panes; reviews every shared UI change. |
| product-accessibility | Listbox and combobox semantics, every new surface. |
| product-automation, product-verify | Now: contract and type-level tests beside each contract owner, review of tests in every track, quick screenshots of UI changes for the feed. Later: batched real-app and e2e runs per milestone. |
| product-releases | Flags of deleted features out of both profiles; 0.10 notes; version bump when the release cut is called. |

## Tracker

| Item | Owner | State |
|---|---|---|
| Contracts | per table | started |
| canvas C1 to C6 | canvas | started |
| remote R1 to R6 | remote | started |
| cli L1 contracts | cli-protocol, review cli-lead | started |
| cli L2 `junto task` | cli-performance, review cli-identity | started |
| cli L3 `junto artifact` | cli-identity, review cli-performance | started |
| Artifacts main side: read ops, repository, version table, ruler's artifact ops | cli-identity (L3), on product-shell's `artifact.ts`, migration slot from canvas C3 | started |
| Tasks main side | canvas C4 (canvas-writers): model, state machine, ruler (state, assignee, reviewers, stamps, numbers, flows send-on, ResourceCommand handler). cli L2 (cli-performance): control.ts op handlers and `junto task`. Seam: canvas's task contract | started |
| Region reach contract | canvas, 945dc0d1c | landed |
| Ids: `work-ids.ts` owns `ItemId` and `OpId`; others import | cli-protocol | decided, landing |
| Listbox ARIA model | product-accessibility, a07e90e17 | landed |
| Task state machine (pure) | canvas-writers, eeb17e7d3, 34 tests | in review |
| Flow graph tests | canvas-writers, c521f4c56 | in review |
| Migration slots | canvas-model keeps the list; only v26 fixed | running |
| cli L4 `junto automation` | cli-external, review cli-overseer | started |
| cli L5 `junto browser` port | cli-overseer, review cli-external | started |
| cli L6 onboard output | cli-skill, review cli-protocol | started |
| 02 queued writes design | canvas, remote | written (da44a4919), remote final pass |
| Verification split | product-automation: deletions, reach, queued writes; product-verify: cli and product surfaces | started |
| Flag removal | product-releases, after each deletion's last consumer | waiting on first deletion |
| pty P1 to P5 | pty | started |
| product, all seats | product | started |
