# 07 Automations

Proposed owner: product (UI), canvas (runner and model), pty (delivery).
Reviewers: remote, cli.

## Target

One Automations node replaces cron and relay. Same layout as artifacts: a
sidebar list of automations and a main pane with the selected definition. No
edges. An automation acts on seats and resources in its own region and the
regions below it. Triggers: a schedule, polling with a bounded rate, and
conditions on seats, tasks and artifacts. Webhooks are designed for and not
built.

**Who writes them** (operator ruling, 2026-10-21). Automations are not
resource nodes. Only the operator and overseers create, edit, enable, disable,
archive and run them, as with the canvas. A seat reads (list, show, history)
the Automations nodes in its reach and writes none. The seat writes become
closed overseer ops, replacing scheduler fire, status and configure. A write's
`ResourceCommand` actor is the operator or an overseer seat; the automation
domain refuses every other seat. The stored author is the operator or that
overseer seat.

**A canvas copy leaves them at home.** Copying or cutting a canvas never
carries its Automations nodes: a copy that brought them would fire the same
mail and tasks twice, from a canvas nobody chose to automate. The operator or
an overseer recreates them on the copy.

**Deleting the node archives them; undoing the delete restores them.** The
delete archives every live automation on the node in the same ruling, keeps
their history, and is never refused. Undo of that delete unarchives exactly
the automations it archived, each with the enabled state it had; a schedule
that missed slots meanwhile fires once on return for its latest slot, as after
an away editing machine.

## Today

- No scheduler service; the kernel runs it (`src/main/junto/kernel/cycle.ts`,
  `tick.ts`, `effects.ts`, `evaluate.ts`). `src/main/junto/scheduler/` holds
  only cron claim slots (`scheduler_interval_state` and `_firings`).
- Cron: `{host, expression}`, fires a five-field schedule at most once via
  claim slots, only on its own host (`cycle.ts:349-420`,
  `src/shared/cron-expression.ts`).
- Relay: fed by `announces` edges from tasks, artifacts, board, page and
  seats; fired by `fires`; acts through `wakes`, `enqueues`, `chains`
  (`src/shared/physics/verbs.ts:184-211`, `src/shared/scheduler-effects.ts`).
- Watcher (gauge): thresholds on Hermes snapshots, product-dormant.
- Legacy: Region Pulse tables still wired (`kernel_armed_regions`,
  `kernel_debug_pulses`), the decode-only `timer` kind, legacy edge
  inference, the v12 row reader.

## Contract: `src/shared/automation.ts` (new)

```ts
type Automation = {
  readonly automationId: string;
  readonly nodeId: NodeId;
  readonly name: string;
  readonly enabled: boolean;
  readonly trigger: Trigger;
  readonly when?: ReadonlyArray<Condition>;   // all must hold at fire time
  readonly then: ReadonlyArray<Action>;
  readonly limits: { readonly minIntervalMs: number; readonly maxPerHour: number };
};

type Trigger =
  | { readonly kind: "schedule"; readonly cron: string; readonly timezone: string }
  | { readonly kind: "poll"; readonly everyMs: number }            // floor, e.g. 60_000
  | { readonly kind: "change"; readonly on: Watch }
  | { readonly kind: "webhook"; readonly endpointId: string };     // reserved, refused in 0.10

type Watch =
  | { readonly kind: "seat"; readonly seat: MentionRef; readonly becomes: "idle" | "working" | "attention" | "gone" }
  | { readonly kind: "task"; readonly task: MentionRef | { readonly node: NodeId }; readonly becomes: TaskState }
  | { readonly kind: "artifact"; readonly artifact: MentionRef; readonly event: "edited" | "commented" }
  | { readonly kind: "signal"; readonly from?: MentionRef; readonly signal: "escalate" | "blocked" | "feedback" };

type Condition = Watch & { readonly holds: true };                  // a state, checked when fired

type Action =
  | { readonly kind: "mail"; readonly to: MentionRef; readonly text: string }
  | { readonly kind: "create-task"; readonly node: NodeId; readonly title: string; readonly assign?: MentionRef }
  | { readonly kind: "assign-task"; readonly task: MentionRef; readonly to: MentionRef }
  | { readonly kind: "comment"; readonly on: ThreadSubject; readonly text: string };
```

Targets are `MentionRef`s (03), picked with `MentionCombobox`, limited by
`automationTargets` (01): below the node and within the author's reach,
rechecked at fire time; an automation the operator wrote gets everything
below. An overseer author keeps the intersection with its own reach, so an
edit by one overseer still fits the targets of both.

## Runner

- **One runner: the editing machine.** It evaluates every automation for the
  canvas, so nothing fires twice and nothing depends on which machine is
  awake. Actions are resource commands (02) and mail; mail reaches seats on
  any machine as today.
- Schedules reuse the claim slots (`scheduler_interval_state`, renamed
  `automation_firings`) so a restart never fires a slot twice.
- Change triggers read task changes from the applied task rulings
  (`resource_rulings`, 02) since a per-canvas cursor
  (`automation_ruling_cursors`), one change per ruling in the order rulings
  landed, so open to working to done between two passes fires both. Seat
  state comes from the existing runtime.
- **Seat states are not stable raw** (pty-lead): working to idle holds only
  700 ms for the rings (`src/main/junto/term/agent-state/seat-state-machine.ts:47-55`),
  attention republishes every 800 ms, a fifth state `unknown` exists
  (`src/shared/agent-seat-state.ts:70-76`), and `gone` is published on every
  generation exit, including cache cuts. Runner rules, owned by pty: fire on
  transitions only, keyed by seat and epoch; `unknown` neither fires nor
  resets a hold; `idle` and `working` must hold 30 s; `attention` fires at
  once, once per episode; `gone` fires only when no new generation takes the
  seat within 60 s.
- **Sender.** Mail rows need a seat actor (`src/main/junto/work/state-schema.ts:318-323`).
  Automation mail is sent from the automation's node with no reply command
  (an absent reply target is allowed, `message-delivery.ts:120`); never as
  the operator.
- **Loop safety.** Facts written by an automation's action do not trigger
  automations: a ruling with `actor_kind = automation` fires nothing. `limits` cap every automation; a cap reached disables nothing,
  it skips and records the skip.
- Every firing is recorded (fired, skipped and why, actions ruled), shown in
  the main pane, and listed by `junto automation history`.
  History keeps the newest 1,000 firings per automation; the claim that
  writes a new row prunes the oldest in the same transaction. A slot's claim
  row is never pruned while it is the cursor's latest slot.

## Webhooks, later

A webhook needs a public URL, so a small cloud relay: the provider posts to
the relay, the relay holds it, the editing machine pulls over an outbound
connection it opens. Shape reserved now so nothing in 0.10 blocks it:

- `Trigger.webhook.endpointId`, one secret per endpoint, signature check at
  the relay.
- The provider's delivery id is the idempotency key.
- A payload size cap; the payload reaches actions as text, never as code.
- 0.10 refuses `webhook` triggers with `not_available`.

## Kept, reshaped, deleted

| | |
|---|---|
| Kept | `cron-expression.ts`, claim slots and coalescing; the clock is `AUTOMATION_TICK` (`src/main/junto/automation/live.ts`), a 15 s loop that finds due slots, not the kernel tick |
| Reshaped | Claim slots renamed and keyed by automation; scheduler effects become `Action`s |
| Deleted | `cron`, `relay`, `watcher`, `timer` kinds and tables; verbs `announces`, `fires`, `wakes`, `enqueues`, `chains`; `scheduler-effects.ts` wiring; Region Pulse tables, `PulseRecord`, `pulseLogRetention`; `LegacyEdgeEther`, `inferVerb`; host fields on schedulers |
| New | `automations` kind and node, `automation.ts`, firing history, CLI `junto automation list|show|create|edit|enable|disable|run|history`, UI |

## Questions

- ~~**canvas**: runner~~ Answered: the runner stays single; seat occupancy
  facts start on each seat's own machine. Cost: with the editing machine's
  lid closed, schedules stop for every machine. On return a schedule fires
  once for its latest missed slot, with `when` rechecked and `limits`
  applied. It never fires in a burst; that one firing records how many
  earlier slots were missed (a count, capped at `MISSED_SLOTS_COUNTED`),
  never a row per slot. This is today's cron coalescing
  (`src/main/junto/kernel/cycle.ts:406`). The automation
  node is the mail and ruling principal. Loop safety catches direct facts
  only; a loop through a seat (mail, the seat acts, its fact fires the
  automation) is caught only by `limits`.
- ~~**pty**: seat state triggers~~ Answered: runner rules above.
- ~~**remote**: webhooks~~ Answered: the relay is not a machine (no
  installation id, no link, no build check), or Rule 8 forces a relay
  redeploy on every build. The endpoint secret is a machine secret on the
  editing machine (Rule 9, `docs/machines.md:95-98`): reserve
  `ownerInstallation` on each endpoint and re-mint secrets if editing moves.
  Automation mail needs an `automation` author kind admitted only from the
  editing machine, as signal answers are; Rule 4 otherwise accepts seat mail
  only from the seat's machine (`docs/machines.md:67-69`,
  `work-exchange.ts:62`).
- ~~**cli**: input~~ Answered: one JSON object per create and edit (inline,
  @file or stdin), decoded by the shared `Automation` schema in main, printed
  by `schema show`. Targets accept `@name` and `#42`, resolved in main. Edits
  carry a base version, like artifacts.
