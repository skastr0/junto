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

Targets are `MentionRef`s (03), picked with `MentionCombobox`, limited to the
automation's region and below (`targetsBelow`, 01).

## Runner

- **One runner: the editing machine.** It evaluates every automation for the
  canvas, so nothing fires twice and nothing depends on which machine is
  awake. Actions are resource commands (02) and mail; mail reaches seats on
  any machine as today.
- Schedules reuse the claim slots (`scheduler_interval_state`, renamed
  `automation_firings`) so a restart never fires a slot twice.
- Change triggers read the fact stream (02) and seat state from the existing
  runtime.
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
  automations. `limits` cap every automation; a cap reached disables nothing,
  it skips and records the skip.
- Every firing is recorded (fired, skipped and why, actions ruled), shown in
  the main pane, and listed by `junto automation history`.

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
| Kept | `cron-expression.ts`, claim slot logic, kernel tick as the clock |
| Reshaped | Claim slots renamed and keyed by automation; scheduler effects become `Action`s |
| Deleted | `cron`, `relay`, `watcher`, `timer` kinds and tables; verbs `announces`, `fires`, `wakes`, `enqueues`, `chains`; `scheduler-effects.ts` wiring; Region Pulse tables, `PulseRecord`, `pulseLogRetention`; `LegacyEdgeEther`, `inferVerb`; host fields on schedulers |
| New | `automations` kind and node, `automation.ts`, firing history, CLI `junto automation list|show|create|edit|enable|disable|run|history`, UI |

## Questions

- **canvas**: Runner on the editing machine only: any case where an
  automation must run where a seat lives?
- ~~**pty**: seat state triggers~~ Answered: runner rules above.
- **remote**: Cloud relay for webhooks: anything in the link or machine
  identity model that should be reserved now?
- ~~**cli**: input~~ Answered: one JSON object per create and edit (inline,
  @file or stdin), decoded by the shared `Automation` schema in main, printed
  by `schema show`. Targets accept `@name` and `#42`, resolved in main. Edits
  carry a base version, like artifacts.
