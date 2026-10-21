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
- **Commit in small atomic pieces, as you go**, by the private index method
  in `docs/machines.md` ("Committing in the shared checkout"). Never a bare
  `git commit`, `git commit -a` or `git add -A`. Never touch another agent's
  uncommitted change.
- **Heavy runs** (operator, 2026-10-21): full typecheck, `test` or `verify`,
  vitest over more than 3 files, e2e. At most 10 machine-wide, in the shared
  checkout, none while the one-minute load is above 40. Team shares: product
  2, remote 2, canvas 2, pty 1, cli 1, performance 1, pi 1; each lead grants
  its team's. No worktrees.
- **Proof is types first** (operator, 2026-10-21). Contracts are typed so
  misuse fails `tsc`: closed unions, branded ids, exhaustive matches,
  type-level tests where a shape matters. Unit tests on pure modules and
  reducers. `bun run typecheck` and the unit tests gate every commit. Real-app
  and e2e runs are expensive: they come later, batched per milestone, not per
  change.
- **Review.** Every change gets a review from a seat that did not write it.
  Tokens, type or shared UI components also go through product-typography.
- **The operator reviews through the needs-you feed, with pictures.** Every
  new or changed UI is reported with `junto feedback` carrying screenshots
  (`--attach`), before and after (`--compare`) or a video (`--video`), and
  the commit (`--commit`). Every decision goes as `junto escalate` with the
  options and a recommendation. Blocked work goes as `junto blocked`. Never
  ask the operator anything inside mail. Deletions get no screenshots and
  no before and after (operator, 2026-10-21): report them with the commit only.
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
- C3 Migration chain: the deletions step now; every step numbered when it lands, from canvas-model's slot list.
- C4 Task model, state machine, assignment invariants, stamps on the verdict
  tables, task numbers, `flows`, state remap. Tests for state machine, rules
  and flow graph.
- C5 Automation model and runner on the editing machine, claim slots renamed,
  loop limits, firing history. Seat-state rules from pty. Admission: automation
  writes only from the operator or an overseer; seats read those in reach;
  `RESOURCE_KINDS` never gains automations (operator ruling, 07). Writes admitted
  only from the operator or an overseer (operator ruling, 07); seats read.
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
- L4 `junto automation`: seats read (list, show, history); writes are closed
  overseer ops replacing scheduler fire, status and configure.
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
| Region reach contract | canvas, 945dc0d1c; property tests by product-automation (200 seeded canvases); open: `atOrBelow` not transitive through a node in two overlapping regions, canvas's call | landed |
| Resource command contract | remote, cc270e4a8; type tests by product-automation, 1f2bd19f3, no defects | landed |
| 02 queued writes, final pass | remote, c56245482 | done |
| remote R2 rows, cap, paging; R3 copy; R5; R6 | 95ed7b998, 3ee4ad729, a194abcc2, 1dd8fdddd, 41db5ad26, 77f7a7134, f65727f16, 2f4c8d022, a530ccc85; facts ride in ruling.applied 387564472 | landed; ruler and replica fold, R4, stub kind next |
| remote R2 to R6 (history) | remote-work, remote-send, remote-seats (R2); remote-cut (R3); remote-core (R4); remote-window (R5); remote-security (R6); doctrine remote-design 659e44833, 52717c3a1 | started |
| Machine build define `__JUNTO_MACHINE_BUILD__` | cli owns, remote-core asserts the bundle | requested |
| Automation domain, tables, runner plan | canvas-automation 9acfdfb16, e8955635b, 20328f683, f929f8afc, 740d7d686; history keeps newest 1,000 (4c771668a); open defects: edit widening reach, edit re-enabling, reassigned reviewer's old approval | landed, defects under fix |
| Automations are operator and overseer only | operator ruling; 01 and 07 (f1a30d748) | decided |
| Automations UI | product-settings 9503999c1, 84c9ed808, 25f16ff54; not mounted until the node kind and IPC land | landed, unmounted |
| Seat-state trigger rules (P5) | pty, f913ccad3, 37 tests | done |
| Mention contract | product-feed, `mention.ts` fb267e17a | landed |
| Thread subject and anchor contract | pty-mail, `thread-subject.ts` 74b442b98; tests by product-feed 1e4c91e0b | landed |
| Visual language v1 | product-typography: ResourceChip, TaskStateMark, StampTally, TwoPane, pending rows; 8888746da to e167586b4; on the feed | landed |
| Ids: `work-ids.ts` owns `ItemId` and `OpId`; others import | cli-protocol | decided, landing |
| Listbox ARIA model | product-accessibility, a07e90e17 | landed |
| Task state machine (pure) | canvas-writers, eeb17e7d3, 34 tests | in review |
| Flow graph tests | canvas-writers, c521f4c56 | in review |
| Migration slots | canvas-model keeps the list; numbers go out as steps land | running |
| Artifact contract | product-shell, 3d9c5facc, 28 tests; shared edit reducer `ruleArtifactEdit` for ruler and pending view | landed |
| Task model contract | canvas, `task-model.ts` d540d3f61, 84897c9aa; reach review fixes 4fd64a703 | landed, ruler migrating |
| Tasks UI | product-modals ebbd76ae2, 470b887f4, Tasks node c0830492a; old board stays until main serves tasks | landed, unswapped |
| Task op wire, TaskView, machine on contract | canvas cd37581ef, 0b55944dd, 50e5d51ea, fa799aec3; numbers #42 293b8e7aa | landed |
| Blocked mark on seat ring; C1 reach in admitPure; C2 factory cuts | canvas ba0efac29; 73bf05d6d, 50a67cd60, dab3240b8, c0eecdae4; 3f359eb4b, 0b0ffe50d, 5f82c5de5 | landed |
| Deletions step | waits on canvas-nodes' pad and sheet batch and the scheduler cut; operator: drop the 4 orphan pads | slipping |
| Artifacts node UI | product-shell 7687e6b27, ed478fd5e, dc920f3b0, 88638ec11; domain e17595829, e1f8be7e5 | landed on stand-in source |
| Requests and board UI; chat toolbar; PromptComposer | product-attention 6ae0b773e, a11ae0f19, a1ee80d50 | deleted |
| Browser contracts: tabs, driver, box | product-attention 6af40a961, 5b35a2a9f; box crop claim with remote-security | landed |
| Mention swaps | product-keyboard f918f4aa0, 31ef5e60f; PadPinThread dies with the pad | done |
| Typecheck toolchain | tsrs swap landed (tech-lead fdc1bd867, 1693ef5b4, 9adfc92de): cold 7 s, 1.0 GiB vs tsc 5.9 160 s, 3.0 GiB; typecheck needs no slot | landed |
| Sweep repair | fdc1bd867 carried six stale staged paths; restored at ca81a0033, stale copies unstaged | done |
| Main typecheck red | 31 errors at b3543a409, routed: canvas (magnifier phase, pad and sheet tests), remote (browser hostId tests), cli (work-ports, pad.read), product-modals (toSorted) | fixing |
| remote R5 Hermes host identity | b3543a409; stand-in removal rides the deletions step | done |
| remote R4 browser out | 255613ef8, 2614f3578, 658827b65; commit 3 page host readers next, deletions step waits on it | started |
| Pinning deletion | product-shell b7aaeeb54, 34dd02699, 3b5841794 (flag out) | done |
| Anchor lock, target resolution tests | product-verify f30bdc9cd, bcd7a9e40 | landed |
| Long mail text over 64 KiB | product-feed 5a299a18e, bound in `mail-text-bound.ts` (48 KiB text); thread composer with product-keyboard; envelope bound confirming with remote-send | landed, confirming |
| Renderer resource IPC (tasks and artifacts sources) | cli-overseer, one generic contract and main side through the ruler | started |
| Box comment screenshots | remote-security: yes; main captures, grant holder only, claimed with the row, 2 MiB and 4096 px, read by reach, on-demand bytes | decided |
| Feed attachments and mentions | product-feed 46408b918, 6ea3aff99, 68eca6caa, 87db4c3fe, 313bc5456 | landed |
| 0.10 notes | product-releases bd15d7b6f; hermesIntegration flag gone 8f01e3e0a | draft |
| MentionCombobox, availability hooks | product-keyboard, 8ea979958, b02bb6f06, 6b8de8cee, 30 tests; accessibility approved with fix f42fbf264; typography approved with 3 CSS changes | landed; replacing old copies next |
| Hermes Providers card | product-settings, 11b9db75b | landed |
| One id source lock | product-verify, `tests/item-id-one-source.test.ts` | passing, commits after the four contracts land |
| cli L4 `junto automation` | cli-external, review cli-overseer | started |
| cli L5 `junto browser` port | 0b8a303cb, b7bce45d9, 207f77db0; out of the machine build; server --tab waits on tabs | landed, in review |
| cli L6 onboard output | cli-skill, review cli-protocol | started |
| 02 queued writes design | canvas, remote | written (da44a4919), remote final pass |
| Verification split | product-automation: deletions, reach, queued writes; product-verify: cli and product surfaces | started |
| Flag removal | product-releases, after each deletion's last consumer | waiting on first deletion |
| pty P1 delete lease | 478ad7409 | done |
| pty P2 Hermes integration | cc98a66b8, 174e80998, c6b87b36c, 8f01e3e0a, 773e5b015; renderer product-attention e430f78ab; no reference left on main | done |
| pty P3 seat since and onboard | 2420e2e80 to ec25735dd; L6 format with cli; onboard mailbox read cost unmeasured | done |
| pty P4 subject threads | 74b442b98, dd4bdf621, d5c91f844, 0d14ddde6; mail-threads and control.ts drops next | started |
| product, all seats | product | started |
