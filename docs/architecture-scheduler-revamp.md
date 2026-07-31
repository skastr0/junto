# Scheduler revamp — cron, gauge, relay

**Status:** architecture (post-pulse purge; pre-implementation)  
**Swarm date:** 2026-07-31  
**Depends on:** [`architecture-factory-physics.md`](./architecture-factory-physics.md), [`AGENTS.md`](../AGENTS.md) kernel section, security doctrine (single-home, expand-not-drop SQLite)

This document is the product + technical architecture for turning today’s husk
schedulers (`timer` / `watcher`) into first-class factory automation, without
reviving region pulse inject.

---

## 1. Product sentence

**Schedulers fire authored edge effects into sinks and (optionally) actors;
actors pull work only through the claim tick.**

Automation fabric (time + predicates) is orthogonal to the pull economy
(sink inventory → free actor → claim → managed-seat wake). Both are load-bearing.
Neither replaces the other.

---

## 2. Three kinds (closed `SchedulerKind`)

| Product | Entity kind (today → target) | Role | Input | Fire semantics |
|---|---|---|---|---|
| **Cron** | `timer` → **`cron`** (rename) | scheduler | schedule (`everyMinutes` v1; calendar later only with full contract) | Durable home-scoped due → **edge effects** |
| **Gauge** | `watcher` (keep or alias **gauge**) | scheduler | live projection (hermes roster stats v0; richer sources later) | Level + rising-edge → status and/or **edge effects** |
| **Relay** | **new** `relay` (or `watcher` subtype) | scheduler | **another canvas node’s** typed projection | Level / transition → **edge effects** (propagate or mint) |

Physics role remains **`scheduler`** for all three: empty inbound `offers`,
not blockable, actor→scheduler grant = `None`. Kind still derives role;
no authorial `ether.role`.

**Hermes roster snapshot is not the gauge product.** `SnapshotsService` +
`connections.ts` stay as agent fleet join. Gauge may *consume* thin numeric
stats (`running`) but is not justified by roster alone. Prefer shipping
**relay + cron effects** first; keep hermes gauge thin or dormant until
predicate-grade hermes facts exist.

---

## 3. Four planes on one edge (do not collapse)

An edge may participate in multiple planes; each plane has its own fields and laws:

| Plane | Document field | Runtime | Who wields |
|---|---|---|---|
| **Capability** | `ether.ports?` | `admitPure` + process-bind | **Actors only** |
| **Phase / stoppage** | `ether.criteria?` | `blocks` \| `relates` | Generates stoppage on **actors** only |
| **Delivery (human wake)** | `ether.notify?` | board megaphone | Operator / board path (agents never force wake) |
| **Automation effect** | **`ether.effect?` (new)** | kernel home fire → WorkService / inject transports | **Kernel effect principal**, not agent ocap |

**Rejected designs:**

| Idea | Why reject |
|---|---|
| Ports-as-effects (`tasks.create` on a timer) | Wrong plane; forces process-bind + actor caller laws; rewrites emptyOffers |
| Criteria mode `cron` | Criteria is stoppage, not inventory mint |
| Soft relates alone “means fire” | Soft relates never invent side effects today; keep that law |
| Region fan-out inject | Pulse product — dead; geometry is not a router |
| Effect on node only (no edges) | Ambient multi-target risk; multi-sink fan-out needs edges |

**Binding rule (recommended):** directed **source scheduler → target**.
Effect edges are only valid when one endpoint is a scheduler and the other is
an allowed target for that effect mode. Soft undirected capability geometry
unchanged for actor↔sink.

---

## 4. Closed `EdgeEffect` union (v1)

Sibling of `criteria` / `ports` / `notify` on `EtherEdgeExtension`. Strict
decode; unknown modes fail closed.

```text
EdgeEffect =
  | { mode: "enqueue_task"
      brief: string
      reason?: string
      metadata?: WorkMetadata
      dependsOn?: string[]
      finishCriteria?: FinishCriteria
    }                                    // target: task sink
  | { mode: "notify_actor"
      template: string                   // one seat-bound turn body
      // spacing policy: required (turn cost)
    }                                    // target: agent
  | { mode: "post_message"
      body: string
    }                                    // target: agent (mailbox path)
  | { mode: "set_flag"
      flag: "blocker" | "attention" | "parked"
      enabled: boolean | "mirror"        // mirror = level-driven
    }                                    // target: any node; blockability still actor-only for stoppage
```

**v1 ship order (effects):**

1. **`enqueue_task`** — highest leverage, cheapest, proves sink path  
2. **`notify_actor` or `post_message`** — standing automation; rate law required  
3. **`set_flag`** — relay attention; no claim invent  
4. Later: `deposit_artifact`, `escalate_request` only with explicit system principal design  

**Never an effect:** `claim_task` / assign actor. Factory claim tick remains
sole assigner (`selectFactoryClaims` → `workTaskClaim` → `managedPulseDeliver`).

---

## 5. Runtime architecture

### 5.1 Cycle order (unchanged spine)

```text
runCycle
  |> station scope + actor registry + hermes snapshots
  |> startManagedSeats (actorsNeedingWake — open work only)
  |> runEvaluationCycle   // gauge + relay predicates
  |> checkTimers          // cron durable claim + effects on Firing
  |> runClaimTicks        // sink inventory → claim
  |> deliverWorkingClaims // managed seat wake for working claims
  |> emit kernel snapshot (status / nextFire / optional last effect)
```

Pause plane: freezes **claims + injects**; product choice whether cron still
advances cursors while paused (recommend: **advance cursor, suppress effects**
while `!playing` so catch-up does not dump a backlog on resume — or hold due
without advancing; pick one and test).

### 5.2 Cron path

```text
checkTimers
  |> claimInterval (existing durable home policy, coalesce-latest)
  |> on Firing:
       for each outbound edge with ether.effect from this cron:
         applyEffect(edge, idempotencyKey = timerKey + scheduleId + claimSlot + edgeId)
  |> nextFire UI only as today for countdown
```

Reuse `scheduler_interval_state` / `scheduler_interval_firings`. Extend firings
or add `scheduler_effect_receipts` for per-edge idempotency (expand-only DDL).

### 5.3 Gauge path

```text
detectPulses / evaluateWatcher (rename later)
  |> hermes findFreshEntity + numeric threshold (v0)
  |> status → UI
  |> on rising edge (result.fired) OR level policy per effect:
       applyEffect on outbound effect edges
  |> flagOnUnsatisfied: rehome to set_flag effect OR wire FlagWriterDeps in prod
     (today UI commits flag; main flagWriterDeps is null — fix or delete)
```

### 5.4 Relay path (new)

```text
for each relay node:
  read typed projection of source (edge or bound nodeId)
  evaluate predicate (closed paths — not free JSONPath into authorial doc)
  on transition / level:
    applyEffect on outbound edges
```

**Projection sources (closed, expand deliberately):**

| Source | Paths (examples) |
|---|---|
| task sink item | `item.state`, `item.claimedBy`, attention states |
| actor seat | occupancy, blocked, paused, working claim presence |
| flags | `ether.flags` contains X |
| (later) external | git / API / health nodes as first-class kinds |

**No multi-hop cascade.** One hop per fire. Chains only if operator authors
relay B watching something relay A mutated — never automatic.

### 5.5 Effect application (shared)

```text
applyEffect(edge, key)
  |> pause / license gate
  |> validate endpoints + mode
  |> home: materialize only on item/sink home (Remote enqueues to CC when required)
  |> durable receipt (at-most-once)
  |> dispatch:
       enqueue_task → WorkService.workTaskCreate (system principal, submitted, unclaimed)
       notify_actor → messageDelivery or managed inject with receipt — never region compose
       post_message → workMessageAppend (system identity)
       set_flag     → CanvasesService authoring write (CC)
```

**System / effect principal:** kernel-internal WorkService call — not fake
agent process-bind, not open control socket as a seat. Agents remain
propose-only on `tasks.create` unless product explicitly changes that.

---

## 6. Orthogonality laws (must hold)

1. **Claim tick never reads cron/gauge/relay fire** — only sink inventory + edges + workRole.  
2. **Schedulers keep empty inbound offers** — sensors are not work targets.  
3. **Automation effects ≠ ports ≠ criteria ≠ notify.**  
4. **Schedulers never enter the blocked set.** `set_flag` on a scheduler is display/seed only; stoppage only if flag lands on an **actor**.  
5. **Single-home evaluation** of scheduler nodes (existing host stamp).  
6. **Catch-up:** interval coalesce ≤1 firing per wake; effect receipts prevent double enqueue on retry.  
7. **No absolute calendar cron** until TZ / restart / latent backlog contract is schema + tested (protocol already forbids silent half-implementations).  
8. **Strip `ether` → valid JSON Canvas.**  
9. **SQLite expand-preserve-deprecate** — do not DROP `kernel_armed_regions` / `kernel_debug_pulses` in routine migration; stop using them.  

---

## 7. Naming and UI

| Today | Target |
|---|---|
| palette “timer / pulse on an interval” | **cron** / “schedule” |
| TimerCard “next pulse” | **next run** |
| `detectPulses` | rename when convenient (`detectWatcherFires`) |
| `managedPulseDeliver` | keep name or rename separately — **claim wake only**, not scheduler |
| `watcher` | **gauge** (UI) and/or keep kind `watcher` until migration |
| relay | new palette card + inspector |
| `flagOnUnsatisfied` | edge `set_flag` or wire real FlagWriter |

Hermes agent cards still join via snapshots; fix dead `stats.status` read to
`gateway`/`running` is a separate polish, not this revamp’s core.

---

## 8. Build slices (pragmatic)

| Slice | Ship | Proof |
|---|---|---|
| **S0 Law + rename** | Docs, palette copy, kill pulse language; optional kind alias `cron` | No behavior change |
| **S1 `enqueue_task`** | `ether.effect` schema + cron Firing → `workTaskCreate` + receipts | Task appears; claim tick assigns; seat wakes |
| **S2 Gauge fire → enqueue** | Rising edge reuses effect apply | Hermes `running` or fixture source |
| **S3 Relay v0** | Watch task item state → `set_flag` / enqueue | One hop, no cascade |
| **S4 Notify** | `notify_actor` / mailbox with spacing | Rate law tests; pause gate |
| **S5 Rich sources** | git / API / health nodes | Only after S1–S3 earn themselves |

**Demo path stays claim-driven.** Scheduler slices do not block factory demo.

---

## 9. File touch map (from archaeology)

**Core:** `canvas.ts`, `physics/{schema,kinds}.ts`, `kernel/{cycle,evaluate,service}.ts`, `scheduler/{repository,state-schema}.ts`, `scheduler-policy.ts`, `work/service.ts`, new `kernel/effects.ts` (or similar), state migration N→N+1  

**UI:** `node-factories.ts`, `Canvas.tsx` palette, `InspectorFields.tsx`, `TextNode.tsx` cards, `activity.ts`, `mutations.ts`, `kernel-view.ts`  

**Leave alone for roster:** `snapshots.ts`, `adapters/hermes.ts`, `connections.ts` (gauge consumes; roster owns)  

**Do not revive:** region arming product, `agentKeysForWatcher` as implicit delivery, geometry fan-out  

**Docs to supersede/fix after implement:** `docs/research/actor-model-scans/scheduler-surfaces.md` (stale pulse), pulse wording in security-doctrine / managed-terminal-plan / remote-station-checklist / README arming rows  

---

## 10. Open product choices (resolve before S1)

1. **Pause:** advance cron cursor while paused vs hold due? (recommend suppress effects, define cursor policy explicitly)  
2. **Cron→actor default:** require explicit `notify_*` (recommended) vs any soft edge? (reject soft-as-notify)  
3. **Kind rename:** migrate `timer`→`cron` in one schema version vs UI-only label?  
4. **Relay as kind vs watch subtype:** separate `relay` kind (clearer) vs `watch.kind: "node_state"` (fewer kinds)  
5. **System principal audit:** who appears as `createdBy` on enqueued tasks?  

---

## 11. One-line laws

| Surface | Law |
|---|---|
| **Cron** | Home-local schedule fires ≤1 due tick per wake and applies only edge-authored effects. |
| **Gauge** | Derived predicate over a live projection; rising edge may apply edge effects; first sample never fires. |
| **Relay** | One-hop projection of another node; applies edge effects; never multi-hop cascade. |
| **Factory** | Only the claim tick assigns work to actors; schedulers never claim. |
| **Pulse** | Region-wide inject stays dead; `managedPulseDeliver` remains claim-seat transport only. |

---

## 12. Swarm evidence anchors

- Kernel status-only fire: `src/main/vellum/kernel/cycle.ts` (post-purge header + timer Firing no inject)  
- Durable interval: `src/shared/scheduler-policy.ts`, `src/main/vellum/scheduler/*`  
- Empty scheduler offers: `src/shared/physics/kinds.ts`  
- Claim independence: `src/shared/factory-tick.ts`  
- Enqueue API: `WorkService.workTaskCreate` / `src/shared/work.ts`  
- Soft relates ≠ effects: `execution-graph.ts` criteria-only stoppage; `ether.notify` board-only  
- Dead delivery helper: `agentKeysForWatcher` tests-only  
- Hermes stats surface: `adapters/hermes.ts` (`running` 0|1 primary numeric)  
- Roster join independent of gauge: `connections.ts` agent-only  

When implementation starts, open a glyph/PR per slice S0–S5; do not land effects without receipts + pause gates + home rules.
