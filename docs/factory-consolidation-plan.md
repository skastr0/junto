# Factory consolidation — the canonical plan

Status: **plan of record.** Authored 2026-07-26. Absorbs and replaces the earlier
the earlier `factory-physics` cleanup plan (two live plans for one migration is
the duplicate-v1/v2 this doctrine forbids — it was deleted, not deprecated).

Evidence base — 184 cited findings across two scan rounds, all spot-checked:
[`research/actor-model-scans/`](research/actor-model-scans/) (138) -
[`research/weirdness-hunt/`](research/weirdness-hunt/) (46, read its correction
header first). Verified harness behavior:
[`managed-terminal-verification.md`](managed-terminal-verification.md).
Product plan: [`managed-terminal-plan.md`](managed-terminal-plan.md).

Doctrine applied: **consolidation-engineering** (one canonical end state; preserved
old paths presumed wrong until proven necessary) and **PCMI** (pristine components,
rigorous seams, disposable glue; ratchet invariants rightward on
`prose < lint < test < type < construction`).

---

## 0 - The canonical end state, in one page

Everything below serves this. If a change does not move the code toward this, it
is not in this plan.

```ts
// ── The four roles. Closed. Derived from kind, never stored. ────────────────
type FactoryRole = "actor" | "sink" | "scheduler" | "geography"

// ── The kinds. Closed. One actor. ───────────────────────────────────────────
type ActorKind     = "agent"                                      // Junto-spawned template terminal
type SinkKind      = "task" | "requests" | "artifacts" | "page"
type SchedulerKind = "watcher" | "timer"
type GeographyKind = "note" | "file" | "link" | "region" | "terminal"
//                                                        ↑ geography, not legacy
//                                                                  ↑ raw user-opened terminal

// ── What a node IS. Decided at creation. Never recomputed from runtime. ─────
type NodeSpec =
  | { role: "actor";      kind: "agent"; harness: HarnessId; binding: BindingId }
  | { role: "sink";       kind: SinkKind }
  | { role: "scheduler";  kind: SchedulerKind }
  | { role: "geography";  kind: GeographyKind }

type HarnessId = "claude" | "codex" | "grok" | "hermes"   // closed literal

// ── Where it runs. Data, not a permission axis. ────────────────────────────
type Placement = { host: "local" } | { host: "station"; hostId: string }

// ── Who is calling. One principal, no optional discriminants. ──────────────
type Principal = { binding: BindingId; canvas: string; node: NodeId }
```

**Vocabulary, settled 2026-07-26 (operator).** The one actor kind is `agent`. A
raw user-opened terminal is `geography/"terminal"`. `worker` is **reserved** for a
future native agent UI and must not appear in this migration's code, types, or
tests.

> **ACP is a transport, never a kind.** It is not in the kind vocabulary and never
> was — the `agent` kind that exists today is a node whose transport happened to
> be ACP, and describing it as "the ACP kind" is the conflation this plan exists
> to kill. `agent` now names the Junto-spawned template terminal, whose transport
> is a PTY. In the future ACP is the transport that will carry the `worker` node
> (the native agent UI) — which is why `worker` is reserved and why ACP's removal
> here is a removal of a *hidden node surface*, not a ruling against the protocol.
**The chat UI and the ACP transport are kept, hidden — operator ruling 2026-07-26.**
This reverses D3 as originally written. They are unshipped product, not debt: the
UI is built and will be refined, and ACP is the transport that will carry `worker`.
Consolidation doctrine targets *preserved old paths*; this is a *future path*, and
the operator has ruled it product. So the deletion narrows to the coupling:

> **ACP is severed from the factory, not removed from the repo.** The chat surface
> keeps no kind, no seat, no principal, no ports, no inbox, and no work claim. It
> holds no row in the kind vocabulary and appears in no capability decision. D11
> still dies in full — binding an ACP child PID as an actor seat principal is
> runtime-derived identity, the worst class in this plan, and it is precisely the
> coupling that made ACP look like a kind. When `worker` ships, it is authored as
> a kind then, deliberately, against its own spec.

**What becomes unrepresentable** (construction-level, the far right of the
gradient — not policed, structurally impossible):

| impossible after | today's shape that permits it |
|---|---|
| an actor that is not an `agent` | 3 kinds carry `role: "actor"` (`physics/kinds.ts:38-40`) |
| an actor with no binding or no harness | `harness`/`bindingId` optional (`canvas.ts:103`) |
| a harness with no template | `harness: Schema.String` (`canvas.ts:103`) |
| geography holding ports, a seat, or an inbox | a geography kind once offered `msgOffers` |
| a node whose role depends on a live process | `managed = Boolean(harness) \|\| launch?.kind === "harness"` recomputed per open (`term/local-host.ts:381`) |
| an actor silently becoming a shell | `argv.length === 0` → `defaultShell()` `-l` (`term/local-host.ts:311-317`) |
| a caller principal that resolves to nothing | 3 kinds × 3 optional ids (`process-identity.ts:19-32`) |
| a port gated by a tier number | `PORT_TIER_FLOOR` / `tierAllowsPort` (`physics/placement.ts:63-81`) |
| a second work-admission path | route tokens (`work/route-tokens.ts`) |

## 1 - Strata — where abstraction effort goes

PCMI's question, answered for this codebase. Investment posture per stratum; a
change whose posture does not match its stratum is a review failure.

**Pristine — domain capabilities.** Full type-system power. These are the
attention anchors; every downstream line is cheap because its correctness is
decidable against them.
- `src/shared/physics/` — roles, kinds, the `NodeSpec` sum, placement, laws.
  **One resolution site**: `resolveSpec`. Nothing else may derive a role.
- The actor seat: `(node, binding, harness, placement)`.
- The work vocabulary: sink kinds × ops (`OPS_BY_SINK` as a total
  `Record<SinkKind, ReadonlyArray<Op>>`, not an if/else chain).

**Pristine — seams.** Schemas, authorization, failure semantics. Never glue.
- Canvas document decode (`shared/canvas.ts`) — the document is the product; its
  decoder is a seam, and **it must not rewrite meaning** (see §2, D2).
- Work-control protocol (`work/control.ts` + `shared/work-control.ts`) — one
  admission path, process-bind only.
- Edge admission (`physics/admit.ts`) — role-pair law × kind-declared offers ×
  authorial mask. Three inputs, one decision.
- The PTY drive contract (`term/drive/`) — paste+CR, idle gate, interrupt
  spacing. Already well-shaped; keep it there.

**Plastic — glue.** Local, repetitive, disposable. Repetition is *licensed*.
- Per-harness spawn argv/env/injection (`term/templates/`) — four near-identical
  recipes. Do **not** build a framework over them; each harness's quirks are
  vendor facts (verified per harness in `managed-terminal-verification.md`).
- Per-harness state rule packs (`term/agent-state/rules/`) — pattern data.
- Renderer presentation by kind (colour, icon, label) — genuinely incidental.

**Never glue** (interaction invariants, per PCMI): admission, port masking,
delivery ordering, idempotent claim, seat identity. Every one of these is a seam
contract in the list above, and every one currently has at least one hand-rolled
copy in glue — that is the substance of §2.

## 2 - The consolidation ledger

Consolidation doctrine: preserved old paths are **presumed wrong**. Each row
names what dies. The three allowed exception classes are **destructive state
transition**, **unavoidable runtime skew**, and **external control boundary**.

**Finding: zero rows qualify for an exception.** Documented rather than assumed —
(a) no destructive state transition: the operator has ruled the current document
data unimportant and stale ACP-era nodes worthless; (b) no runtime skew: one
desktop app, no fleet of clients requiring atomic update, station apps ship
together; (c) no external control boundary: the four harnesses are spawned as
children, never coexisted with. **Therefore nothing here gets a compatibility
layer, a flag, or a dual path.** Anything that later claims one must supply the
full proof standard (canonical end state named, exact old paths listed, why
direct consolidation is unsafe *now*, objective retirement trigger, explicit
owner).

| # | dies | why it was alive | evidence |
|---|---|---|---|
| D1 | today's `agent` + `herdr` as separate actor kinds; one actor kind remains, named `agent`; `herdr` → `role: "geography"` | an ACP-backed node was once the actor | `physics/kinds.ts:38-40` |
| D2 | `sanitizeActorSurfacePorts` — the decoder that deletes an actor's entity | invented to validate "one kind requires another kind's fields" | `canvas.ts:559-592` |
| D3 | ~~ACP subsystem~~ → **kept, severed.** Its factory coupling dies: no kind, no seat, no ports, no participation in any capability decision. The UI and transport stay, hidden and inert. | it was wired into physics to be reachable | `main/junto/chat/` (+ IPC channels, renderer chat dir) |
| D4 | Route tokens + the second admission path | Tier 3 for callers with no local Junto | `work/route-tokens.ts`, `work/live-seat.ts:26,76`, `work/control.ts:194-266` |
| D5 | `RuntimeTier`, `PORT_TIER_FLOOR`, `tierAllowsPort`, `ActorClass`, `External`/`Facility` placements | the retired Tier 1–4 model, gating ports inside physics | `physics/placement.ts:20-30,63-81`; `admit.ts:200-207` |
| D6 | Opt-in prism plugin + its install plane + Fleet UI section | the retired opt-in tier | `packages/vellum-plugin/`, `main/junto/plugin-install/` (12 files), `FleetDetailPanel.tsx:386-418`, `hosts/ipc.ts:562` |
| D7 | `ProcessPrincipalKind` 3 kinds × 3 optional ids → one `Principal` | one per actor kind | `process-identity.ts:19-32`, `caller-resolve.ts:51-53` |
| D8 | `ActorDeliverySurface` 3 tags → 1 | one per actor kind | `shared/actor-surface.ts:50-53` |
| D9 | ~12 parallel kind lists re-deciding participation (they disagree about herdr) | no single resolver to call | `message-delivery.ts:69-71,138`, `region-rollup.ts:88-89`, `digest.ts:85-89`, `station.ts:22-29`, `work/authz.ts:122-127`, `browser/authz.ts:27`, `work-canvas-merge.ts:13-14`, `actor-surface.ts:96-141` |
| D10 | `legacy-surfaces.ts` flag hiding herdr's powers | hiding instead of re-kinding | `shared/legacy-surfaces.ts:9-15` |
| D11 | ACP child PID bound as an `agent` seat principal | runtime-derived identity, the worst class | `chat/service.ts:419-437` |
| D12 | Browser callers as a hand-picked kind subset | ACL table where a role check belongs | `browser/authz.ts:22-27` |
| D13 | Terminal principals refused browser authority; refused route-token mint | bugs, ruled so 2026-07-26 | `browser/edge-grant.ts:174,505`; `work/live-seat.ts:26,76` |
| D14 | Kind inferred from an optional ether key's presence | shortcut | `region-rollup.ts:133` |
| D15 | Clean-shell fallback for an unresolvable actor launch | generic default | `term/local-host.ts:311-317` |
| D16 | Per-open recomputation of managed-ness | identity from call input | `term/local-host.ts:381-382` |
| D17 | `region` + `furniture` roles → `geography` | historical split | `physics/schema.ts:22-28` |
| D18 | Duplicate per-kind actor-inbox declaration | same rule stated at two layers | `physics/kinds.ts:38,40` vs `physics/stamp.ts:9-12` |

## 3 - The gradient ratchet

PCMI's enforcement gradient made concrete: every invariant this migration
establishes, and how far right it can be pushed. **Construction** means the
illegal state cannot be written; **type** means it cannot compile; **test** means
CI catches it; **lint/prose** is policed and therefore weakest.

| invariant | today | target | mechanism |
|---|---|---|---|
| exactly one actor kind | prose (a doc row) | **construction** | `ActorKind = "agent"` — a single literal; `kindsWithRole("actor")` is typed, not asserted |
| an actor has a harness + binding | runtime validation, then deletion | **construction** | required fields in the `NodeSpec` actor variant; no optionals to check |
| harness names a real template | unchecked string | **type** | closed `HarnessId` literal; decode fails on anything else |
| role derived in one place | ~12 parallel lists | **type** | `NodeSpec` sum + exhaustive `Match`; adding a kind is a compile error |
| geography holds no ports | per-kind hand-typed rows | **construction** | geography variant carries no `offers` field at all |
| one admission path | two (process-bind + route token) | **construction** | delete the second; `Principal` has no token variant |
| no port gated by tier | tier table | **construction** | delete `RuntimeTier`; ports have no tier field |
| kind never runtime-derived | recomputed per open | **type** | spawn takes a `NodeSpec`, not loose `harness?`/`launch?` inputs |
| an actor never degrades to a shell | silent fallback | **type** | `resolveLaunch` returns `Either<LaunchError, Argv>`; the shell path is reachable only from the `geography/"terminal"` variant |
| edge legality is role-pair only | correct already | **type** (hold) | `canonicalRolePair` + exhaustive `grantLawBetween` — the pattern to copy |
| no second actor kind ever appears | — | **test** | `tests/factory-physics-architecture.test.ts`, source-grep in the shape of `ssh-architecture.test.ts` |
| no `entity.kind ===` in capability code | — | **test** | same file; scans `work/`, `browser/`, `kernel/`, `shared/` |
| no invented vocabulary | — | **test** | same file; bans `demote`/`half-agent`/`managed-agent`/tier identifiers |
| the law itself | scattered | **prose, deliberately** | one line in `AGENTS.md`; the negative case in `architecture-factory-physics.md` |

Note the asymmetry: **nine of fourteen invariants land at type or construction.**
The three grep tests exist only for the invariants a type cannot hold (an agent
inventing a *new* branch, a *new* vocabulary word). That ratio is the measure of
whether this migration succeeded.

## 4 - Commit sequence

Ordered so each commit is independently green (`bunx tsc --noEmit` + `bunx
vitest run` + `tests/kernel-headless-probe.test.ts`, which boots the real app).
Type model first; mechanical migration after; deletions last, when nothing
references them.

| # | commit | shape | acceptance |
|---|---|---|---|
| C1 | four roles; `region`+`furniture` → `geography` | ~11 files | `laws.ts` pairs collapse; palette unchanged; existing physics tests pass unmodified |
| C2 | `NodeSpec` sum + `resolveSpec` as the only resolution site | ~15 | every kind list in D9 becomes a `Match`; delivery tests pass **unmodified** |
| C3 | closed `HarnessId`; required `harness`+`binding` on the actor variant | ~8 | a doc with `harness: "banana"` fails decode; `ts-expect-error` fixture proves the optional is gone |
| C4 | `resolveLaunch → Either`; delete the clean-shell fallback | ~6 | unresolvable managed launch errors; the node shows the error/restart state; shell reachable only via `geography/"terminal"` |
| C5 | one `Principal`; delete `ProcessPrincipalKind` + `ActorDeliverySurface` tags | ~8 | work-control transport suite green; browser grant admits actors (fixes D13) |
| C6 | `OPS_BY_SINK` total record; `requireActor`/`requireSink` | ~5 | adding a sink kind without an op row is a compile error |
| C7 | herdr → geography (repoint, not delete) | ~12 | herdr renders + shows state; no seat, no ports; refused by work-control and browser grant |
| C8 | sever ACP from the factory (D3, D11); keep the UI and transport hidden | ~10 | no ACP symbol appears in `physics/`, `work/`, `browser/`, or `kernel/`; the chat surface holds no kind and mints no principal; its own tests keep passing, because the code lives |
| C9 | delete route tokens + tier machinery (D4, D5) | ~14, delete-only | one admission path; no tier symbols remain |
| C10 | delete plugin + install plane + Fleet UI section (D6) | ~26, delete-only | no `plugin-install` references; Fleet detail panel has no install section |
| C11 | the cement | ~4 | each grep test proven **red** against a deliberate violation before landing |

C9–C10 exceed 20 files. Justification, per the >20 rule: both are delete-only webs
whose members import only each other, so no green intermediate exists; review cost
is low because the diff is removed lines with no logic rewritten. C1–C7 land first
specifically to shrink them. (C8 was a third such web until the chat UI and ACP
transport were ruled kept; it is now a small severing commit.)

## 5 - Yield — decisions compressed

PCMI measures design in decisions compressed, never lines generated. This
migration's ledger:

- **"Is this an actor?"** — was answerable only by inspecting a live process
  across ~12 disagreeing call sites. Becomes one field, decided at creation.
- **"May this edge exist?"** — was drifting toward kind×kind. Stays role-pair,
  4×4 bounded, one exhaustive match.
- **"Who is calling?"** — three principal kinds with three optional ids, one of
  which resolved to nothing. Becomes one record with no optionals.
- **"May this caller wield this port?"** — was role check ∧ kind ACL ∧ tier floor
  ∧ per-kind offers. Becomes role-pair law × kind offers × authorial mask.
- **"What happens when the process dies?"** — was an implicit fallback to a
  login shell. Becomes an explicit error state, because the shell is a different
  variant.

Five decisions compressed; ~2,400 lines and four subsystems deleted as a
*consequence*, not as the goal.

## 6 - Risks

- **Browser plane going dark** — C5 must land the D13 fix in the same commit, or
  no principal can hold a browser grant and it fails closed looking like correct
  security. The most likely silent regression in this plan.
- **Delivery** — C2's guard is that the existing delivery tests pass unmodified.
  If a test needs changing, the behavior moved; stop and check.
- **Occupancy / attention feeds** — read liveness for *display*; they must keep
  working after herdr becomes geography (a geography node may still show state).
- **Usage rail** — verified independent: keys on `quota.provider`, zero
  `entity.kind` coupling. No change expected; assert it stays that way.

## 7 - Deliberately out of scope

Station-aware product work, tracked in `managed-terminal-plan.md` so this
cleanup does not foreclose it: station deploy status surfaced with the right
host; host configuration and picking for new actors (follow the existing
`EtherRegionDefaults` precedent — its paths are already host-keyed, innermost
region wins, missing hosts walk outward, `canvas.ts:173-221`); node migration
between stations (close, clean up, reopen with the right template — the seat
survives, the session respawns); per-station harness detection so the picker
offers only what is installed there.

Also untouched: authoring `entity.kind` at creation (role-from-kind is the
doctrine); presentation-by-kind in the renderer; `promote` outside the physics
domain.

## 8 - Settled 2026-07-26

Both former open items are closed by operator ruling; neither is a derivation.

1. **Naming.** Actor kind is `agent`; the raw user-opened terminal is
   `geography/"terminal"`. `worker` is reserved for a future native agent UI and
   is banned from this migration — the cement test bans it alongside the invented
   vocabulary in §3.
2. **State display is not a factory power.** A geography node may display agent
   state; herdr keeps its live badge after re-kinding. The cement test permits
   state *reads* for display in the renderer and occupancy feeds, and bans only
   seat, ports, inbox, and work claim. Written down so the permission is
   deliberate rather than a hole.
3. **The hidden chat surface stays.** The cement test therefore bans ACP symbols
   from `physics/`, `work/`, `browser/`, and `kernel/` — the capability planes —
   rather than from the repo. `main/junto/chat/` and the ACP transport are
   allowed to exist, and must remain unreferenced by any factory decision.
