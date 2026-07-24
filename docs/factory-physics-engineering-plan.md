# Factory physics — engineering plan (agent handoff)

Companion to [`architecture-factory-physics.md`](architecture-factory-physics.md)
(doctrine) and the product story it implements. Doctrine wins on conflict;
[`security-doctrine.md`](security-doctrine.md) wins over both.

**Sovereign-model conformance (2026-07-24):** this plan is bound to the
security doctrine's single-sovereign / Command-Center-and-Stations model.
The capability physics below is the *intra-runtime* half of the engine; the
doctrine adds a **placement plane** (actor classes, runtime tiers, station
assignment, CC-only routing) that is equally constitutive — see invariants
I18–I22 and slice S11. Two doctrine decisions remain operator-open (sink /
scheduler taxonomy and projection contents); no slice may resolve them by
accident.

This document is a **handoff brief**: each slice is self-contained — verify
reality first, implement, gate, commit. You do not need the authoring
conversation to execute a slice.

**Status legend:** every slice starts with a *reality probe* — commands whose
output must match the stated expectation. If a probe fails, the baseline moved:
**stop, report the drift, do not improvise a merge of visions.**

---

## 0 · Reading order (before any slice)

1. `docs/architecture-factory-physics.md` — the three planes, laws, PR test.
2. `src/shared/physics/` — the capability kernel (schema → kinds → laws → admit → view).
3. `src/shared/occupancy/`, `src/shared/impact/cone.ts` — attention-plane pure modules.
4. This plan's §1 invariants and §2 decision register.
5. The slice you were assigned. Nothing else is required context.

**Mission in one line:** the map is the authority — drawn edges are the only
capability, live data is the only phase, derived occupancy is the only
attention, and org trust claims are graph-derivable, never asserted.

---

## 1 · Invariant table (the physics, as executable gates)

Ratchet direction: prose < lint < test < type < construction. Every invariant
lists its current enforcement and its target. A slice that moves an invariant
left is wrong by definition.

| # | invariant | enforcement today | target |
|---|---|---|---|
| I1 | roles derive from kind; `ether.role` unrepresentable | construction (`satisfies Record<WellKnownKind, KindSpec>`, no schema field) | keep |
| I2 | attenuation never expands (`PortGrant.attenuate`) | construction (`schema.ts:136`) | keep |
| I3 | no edge → no capability; region co-membership → visibility only | test + runtime denial (`admit.ts:131–152`) | keep |
| I4 | admit requires port ∈ target offers | construction (`allows`, `schema.ts:146`) | keep |
| I5 | every target work op maps to exactly one port | construction (`work-ports.ts` `satisfies`) | keep |
| I6 | wield requires process-bind (peer PID); client identity claims ignored | runtime + test | keep |
| I7 | multi-edge port masks combine as **union** (two keys open both doors) | ✗ today: intersection (`view.ts:63–97`) | construction (S2) |
| I8 | actor→actor default is **discovery-only**; inbox is explicit edge ports | ✗ today: Full (`laws.ts:50`) | type + test (S3) |
| I9 | one membership definition; kernel, renderer truth, rollup, digest agree | ✗ today: three (`kernel/cycle.ts:80`, `renderer/lib/geometry.ts:55`, `shared/graph.ts:35`) | construction by deletion (S1) |
| I10 | edge delete revokes in-flight sessions riding that edge | ✗ today: node delete only (`3f1e550`, `9123f9d`) | test (S4) |
| I11 | occupancy is derived, never document truth; no pid/clock in canvas file | construction (no schema fields) — but module has zero consumers | keep + wire (S5) |
| I12 | harness "waiting on input" ≠ graph "line stopped" ≠ "stalled" — three words, never one badge | prose | UI contract + test (S5) |
| I13 | empty seats appear in design digests, never completion claims | prose | test (S8) |
| I14 | scheduler pulses route via edges; geometry never mints a route; manual region pulse = operator action over eligible members | doc claim, unverified in code | test (S9) |
| I15 | criteria is a phase filter on edges; never folded into `KindSpec.offers` | module boundary | keep |
| I16 | proof stamps written only via `artifact.publish` by a process-bound principal; trust chips derived only | absent (plane not built) | test (S8) |
| I17 | strip `ether.*` → valid JSON Canvas | test | keep |
| I18 | placement is physics: every executable node resolves to a runtime (CC · station · external · facility); admit verifies the target belongs to the expected runtime/host and the route is CC↔Station only — Station↔Station is denied, never representable as a grant | type + test (`placement.ts`, `admit.ts` route denial, `tests/physics`) | type + test (S11) ✓ |
| I19 | actor class + runtime tier constrain creatable edges and admittable ports; each port carries a tier floor; facility (tier 4) never admits and never wields | type + test (`PORT_TIER_FLOOR`, facility denial, class×tier×port table) | type + test (S11) ✓ |
| I20 | revocation honesty: receipts are per reachable runtime; an unreachable Station is shown stale/unreachable — Vellum never manufactures a revocation receipt it cannot prove | prose (doctrine) | test (S4) |
| I21 | agents never author the canvas; physics consumes projections; any migration stamp (S3) commits only through the app-owned canvas-authority store (`~/.vellum/state/canvas-authority-v1`) | doctrine + in-flight canvas-authority lane | construction (S3 lands on that path) |
| I22 | doctrine-open decisions are operator-closed only. **#4 closed 2026-07-24** (§4.5: D1 sink residency + honest deny, D2 split scheduler residency, D1x parked). **#5 (projection contents) remains open, fleet-lane owned** — a slice that quietly resolves it is wrong regardless of code quality | — | process gate, every slice |

---

## 2 · Decision register (closed — do not re-litigate)

| decision | rationale (one line) |
|---|---|
| mask union, not intersection | each edge is an independent capability; possession is additive (ocap) |
| actor→actor = discovery default, `msg.*` by explicit edge ports | inbox is a deliberate wire; default topology must not enable manager-agent patterns |
| one-time document stamp preserves existing actor↔actor behavior | stamp `ports:["msg.list","msg.send"]` where absent; idempotent; no dual semantics after |
| mailboxes are sinks | task/requests carry `msg.*`; actors act, sinks store |
| membership = full-rect containment, in `shared/graph`, single function | kernel's stricter rule wins; renderer keeps interaction hit-testing under a non-membership name |
| criteria final vocabulary: none · glyphs · wip · tasks · proof · approval | proof/approval are phase modes, not ports |
| stall → derived `stalled` + *suggest* park; auto-park only behind explicit policy | operator-set state is never silently mutated |
| occupancy spectrum: empty · idle · working · attention · activity_blocked · stalled · parked · gone | already shipped pure in `shared/occupancy` |
| fs/git/desktop-surface are sink kinds with sealed ports; computer-use is an actor wired to a surface sink | new kinds are skins; **no fourth role, ever** |
| gates = criteria; monitors = watcher+sink composition; trust = proof plane; routers = actors | forcing these into roles is the model's named break condition |

**Do-not-touch register** (standing rulings, not this plan's to change):
herdr is third-party — never fork/patch/bundle; regions never grant; no
`ether.role`; no pid/session state in the canvas document; input-required is
human-only; criteria never merges into offers; occupancy never becomes
document truth.

---

## 3 · Baseline reality map (verified 2026-07-24)

| surface | state | anchor |
|---|---|---|
| capability kernel | live, pristine | `src/shared/physics/*` (commit `a438d2e`) |
| work admit | live via physics | `src/main/vellum/work/authz.ts:240` |
| browser admit | live via physics | `src/main/vellum/browser/authz.ts:140` |
| onboard role + held grants | live, additive | `src/main/vellum/work/control.ts:329–357` |
| edge ports attenuation (document) | live | `f8c44c4`; `view.ts` mask |
| impact cone + impact mode | live in UI | `src/renderer/lib/impact-mode.ts` ← `App.tsx`, `Canvas.tsx:1301` |
| capability inspector (read-only) | live | `InspectorFields.tsx:101` (edge), `:176` (holds-keys / who-can-reach) |
| digest physics section | live | `src/shared/digest.ts:140–170` |
| occupancy | pure module + tests, **zero consumers** | `src/shared/occupancy/`, `tests/occupancy.test.ts` |
| `setEdgePorts` | API only, no UI caller | `src/renderer/lib/edge-mutations.ts` |
| RTS blast-radius ranking | absent | — |
| proof plane | absent | — |
| actor→actor law | Full (pre-flip) | `laws.ts:49–54` |
| mask combine | intersection (pre-fix) | `view.ts:63–97` |
| membership definitions | three | `kernel/cycle.ts:80` · `renderer/lib/geometry.ts:55` · `graph.ts:35` |

**Hot concurrent lanes (check before every slice):** PTY subsystem
(`src/main/services/process.ts`, terminal/herdr planes, activity sources) and
Linux/fleet (`src/main/vellum/hosts/`, `ssh/`, `settings/`, deploy scripts).
Probe: `git status` + `git log --since=1.day --oneline -- <your files>`. If a
hot lane owns a file in your slice scope, **pause the slice and surface it** —
do not merge around live foreign work.

---

## 4 · Slices

Common gates for every slice (in order, all required before "done"):

```
bun run typecheck
bun run test
pulsar score --diff <base>..WORKTREE --changed-only --agent-view   # paste verdict in report
git commit  # your files only; conventional message; never leave the slice unstaged
```

Type-touching slices additionally run `quartz diagnostics` on edited files and
`quartz verify-contract` where a cross-module contract changed. Every slice's
report states which invariants (§1) it moved and to which enforcement level.
No slice adds tests that exist only to prove a past mistake stays gone.

---

### S1 · One membership definition

**Lane:** `src/shared/` + kernel + renderer (mechanical). Safe now.

**Reality probe:**
```
grep -n "containedNodeIds" src/main/vellum/kernel/cycle.ts src/renderer/lib/geometry.ts
grep -n "groupMembers" src/shared/graph.ts
```
Expect: three implementations. If fewer, S1 may already be done — report.

**Scope:** promote the kernel's full-rect containment to `shared/graph` as the
single membership authority. `groupMembers` derives from it. Kernel imports it;
`cycle.ts:80` local copy dies. Renderer's `geometry.ts:55` is renamed to an
interaction-only helper (hit-testing for drag), clearly not membership, or
deleted if all call sites want membership truth.

**|- acceptance**
- exactly one containment predicate exists in the tree (`grep` proves it)
- kernel pulse membership, region rollup, digest, a2a-work, and renderer
  membership displays all consume it
- a node partially overlapping a region is **out** everywhere (full-rect), and
  one test witnesses the same node classified identically via kernel path and
  rollup path

**Kill obligations:** the diff **deletes** `cycle.ts` local `containedNodeIds`
and the renderer copy (or renames it out of the membership vocabulary). No
wrapper preserving both rules.

**Reviewer brief:** hunt for any remaining geometric membership decision made
outside the shared function (search `intersect`, `contains`, `bounds` near
region logic in kernel + renderer). Any hit = revise.

---

### S2 · Mask union (ocap correctness)

**Lane:** `src/shared/physics/` only. Safe now.

**Reality probe:**
```
grep -n "HashSet.intersection" src/shared/physics/view.ts
```
Expect: intersection inside `pairState` merge. If already union, stop — done.

**Scope:** in `view.ts`, when multiple edges between the same undirected pair
all declare ports, the pair mask is the **union** of their sets. Any edge
without ports still means "no mask" (full offers) — that rule stands.

**|- acceptance**
- edge A grants `{msg.list}`, edge B grants `{tasks.claim}` between the same
  pair → both ports admit
- one masked edge + one unmasked edge → full offers (unchanged)
- attenuation still never expands beyond target offers (I2/I4 untouched)
- table test enumerates: no-mask, one-mask, two-mask-disjoint,
  two-mask-overlap, mask+unmasked

**Reviewer brief:** verify the union cannot smuggle a port the target does not
offer — `allows()` must remain the final intersection with offers. Attempt to
construct a grant exceeding offers; it must be unrepresentable at the call
site.

---

### S3 · Actor→actor discovery default + opt-in inbox

**Lane:** `src/shared/physics/` + document load path in main. Safe now, but
**depends on S2** (union) landing first — opt-in over intersection semantics
would silently zero out multi-edge grants.

**Reality probe:**
```
grep -n "ActorActor: () => PortGrant.full" src/shared/physics/laws.ts
grep -rn "msgOffers" src/shared/physics/kinds.ts
```
Expect: Full default; agent/herdr offer `msg.*`. Also locate the canvas
document load/normalize path in main (where a one-time upgrade can run) and
name it in your report before writing code.

**Algebra note (the trap this slice must not fall into):** today
`defaultGrantBetween` returns a `PortGrant`, and `admit` denies immediately on
`empty` — so flipping ActorActor to `empty` would make edge ports *unable* to
re-enable anything, because attenuation never expands (I2). The law result must
therefore become its own type:

```
GrantLaw = Full | OptIn | None        (Data.TaggedEnum)
admit:  Full  → PortGrant.full, then attenuate by mask
        OptIn → mask present ? PortGrant.subset(mask) : PortGrant.empty
        None  → role_law denial
```

`PortGrant` itself stays untouched — its algebra (never expand) is the
invariant; `GrantLaw` is the selection layer above it. ActorSink stays Full.
ActorActor becomes OptIn. Scheduler/Region/Furniture/Denied stay None.

**Migration (one-time stamp, no dual semantics):** any edge whose endpoints
both resolve to role `actor` and which has no `ether.ports` gets stamped
`ports: ["msg.list", "msg.send"]`. Idempotent by construction (only stamps
when absent). After stamp, exactly one semantics exists; there is no
compatibility flag, no version branch, nothing to retire.

**Landing path (I21):** the stamp is an app-owned generation commit through
the canvas-authority store (`~/.vellum/state/canvas-authority-v1`) — never a
free-form file write. **This slice waits for the canvas-authority lane to
land** and then rides its upgrade path. The stamp preserves existing authority
explicitly; it never creates new reach (doctrine law 2).

**|- acceptance**
- fresh actor↔actor edge, no ports → `msg.send` denied `no_port`; both
  endpoints still see each other on the onboard map (discovery)
- actor↔actor edge with `ports:["msg.send"]` → `msg.send` admits, `msg.list`
  denies
- pre-existing document fixture: unported actor↔actor edge → after load,
  stamped, `msg.*` admits exactly as before the flip
- stamp runs twice → byte-identical document
- `quartz verify-contract` on the physics module: `GrantLaw` exhaustive,
  `Match.tagsExhaustive` fails to compile with a missing arm

**Reviewer brief:** adversarial — try to reach an inbox without explicit ports
(multi-edge tricks, region co-membership, stale mask cache). Try to make OptIn
expand beyond offers. Verify the stamp cannot fire on actor↔sink edges.

---

### S4 · Edge-delete session teardown (revocation completeness)

**Lane:** `src/main/vellum/browser/` + chat/session managers. **Probe hot
lanes first** — recent revocation commits (`3f1e550`, `9123f9d`, `e6d0115`)
show this area is active; coordinate via report if another agent owns it this
week.

**Reality probe:**
```
git log --oneline -5 -- src/main/vellum/browser src/main/vellum/chat
grep -rn "onNodeDelete\|teardown\|revoke" src/main/vellum/browser --include="*.ts" | head
```
Establish: node-delete teardown exists; edge-delete path does not (expected).

**Scope:** deleting an edge severs live sessions that ride it *now*, not at
next op. Per-op admit already fails subsequent calls; this slice closes the
window for long-lived surfaces (browser automation sessions; any streaming msg
subscriptions) and **cancels queued actions** riding the revoked edge
(doctrine: "new actions are denied and queued actions are canceled"). Reuse
the node-delete teardown machinery — same law, second trigger.

**Fleet honesty (I20):** revocation propagates to every *reachable* runtime
immediately; per-runtime receipts. An unreachable Station is reported
stale/unreachable — the UI must not claim the revocation reached it.

**|- acceptance**
- live browser automation session on edge A→page; delete edge → session
  terminated within the same document-commit tick; next op returns
  `ScopeError` naming the missing edge
- queued/in-flight actions on the revoked edge are canceled, not drained
- deleting an *unrelated* edge of A leaves the session alive
- node delete behavior unchanged (existing tests stay green, unmodified)
- unreachable-station fixture: revocation reports "not confirmed on host X",
  never a success receipt

**Reviewer brief:** race the deletion — op in flight while edge deletes must
resolve to denial or clean termination, never a half-applied op. Check the
teardown is keyed by (caller,target) pair, not by caller alone.

---

### S5 · Occupancy wiring — chrome, RTS filters, stall policy

**Lane:** renderer + settings + a **new seam interface** in shared. The PTY
lane owns activity *producers* — this slice must not touch producer code.

**Reality probe:**
```
grep -rln "occupancy" src/renderer src/main --include="*.ts" --include="*.tsx"
```
Expect: empty (zero consumers). Also read `src/shared/occupancy/index.ts`
exports and `tests/occupancy.test.ts` to learn the spectrum contract.

**Scope, in three cuts (commit each):**

1. **Seam:** define `ActivityFeed` and `HostLiveness` as typed interfaces
   (Effect `Context.Tag` services or plain typed ports — match repo idiom) in
   shared. Ship a **null producer** (everything `empty`/host-up). The PTY and
   fleet lanes later bind real producers to these tags without touching
   consumers. Interface only — any implementation beyond null is out of scope.
2. **Chrome:** card visual alphabet per the spectrum — empty = dashed outline,
   occupied fill, working pulse, attention amber ring, activity_blocked
   crimson rim, stall arc meter, parked hatch, gone broken ring. Three
   vocabularies stay distinct (I12): *needs input* (occupant), *line stopped*
   (packet), *stalled* (clock).
3. **RTS + policy:** RTS bar filters (Attention / Empty / Stalled / Parked);
   `stallAfterHours` on region/settings; crossing threshold derives `stalled`
   and surfaces a **suggest-park** affordance. Auto-park ships only behind an
   explicit policy flag, default off.

**|- acceptance**
- with the null producer, every seat renders `empty` and nothing crashes —
  the app is shippable before PTY lands real feeds
- unit: derive transitions for each spectrum state drive the expected chrome
  class (table test, all eight states)
- stall: fixture seat with `lastSeen` beyond threshold → `stalled` + suggest
  affordance; operator park → `parked` flag written; **no path auto-writes
  `parked` without the policy flag**
- no occupancy value is written into the canvas document (I11 — assert the
  document bytes are unchanged by pure occupancy churn)
- `gone` / unreachable chrome is **honest** (I20): it reads as "host
  unreachable — last intent stands", never as "stopped/revoked/compromised";
  no compromise inference from unreachability (doctrine non-goal)

**Reviewer brief:** hunt for occupancy leaking into the document or into
authz. Verify the three "blocked" vocabularies never collapse into one badge.
Confirm zero imports from PTY/fleet lanes.

---

### S6 · Capability authoring UX — attenuator, connect preview, palette

**Lane:** renderer only. Safe now. Depends on S2+S3 (preview must speak
GrantLaw: "will grant: … " for Full, "discovery only — add ports to grant" for
OptIn).

**Reality probe:** `grep -rn "setEdgePorts" src --include="*.tsx"` → expect
only the `InspectorFields.tsx:33` comment (no UI caller).

**Scope:** "Limit this key" port-chip editor in the edge inspector (writes via
`setEdgePorts`; clearing restores full default); connect preview on drag
showing role pair + would-be grant before release; node palette grouped
Actors / Sinks / Schedulers / Geography; draw-time notice on grantless edges
(e.g. actor→project: "reach + phase only — no ports offered").

**|- acceptance**
- toggling chips writes `ether.ports`; clearing removes the field entirely
  (absent ≠ empty — absent means full default)
- preview for actor→actor without ports says discovery, and the edge lands
  with no ports (stamp does not fire on new edges)
- palette groups derive from `roleOf`, not a hand-maintained list

**Reviewer brief:** absent-vs-empty ports is the trap — an empty array written
where the field should be absent silently bricks the edge under OptIn/union
semantics. Prove the editor can never write `ports: []`.

---

### S7 · Attention triage — blast-radius ranking + path-to-seed

**Lane:** renderer + `src/shared/impact/`. Safe now.

**Scope:** RTS ranks seeds by cone size ("1 request · stops 4 · leads: …");
clicking enters impact mode centered on the seed. Inspector "Waiting on…"
walks `reasonsByNodeId` to the seed (reverse cone). Digest gains the impact
section (seed, stops, leads, clear-action).

**|- acceptance**
- fixture with two seeds (cone sizes 4 and 1) → RTS orders them 4-first
- reverse walk from a blocked packet lists the seed and each relay hop
- leads are seats holding capability edges into the cone; an empty lead seat
  is marked unstaffed (consumes S5 occupancy when present, degrades without)

---

### S8 · Proof plane — proof/approval criteria, stamp sink, trust digest

**Lane:** `src/shared/execution-graph` + digest + work control. Safe after
S2/S3. This is the trust story's teeth.

**Scope:** two new criteria modes. `proof`: the edge subscribes to stamps in
the source sink; phase holds until a matching stamp exists. Stamp shape:
`{step, seat, occupant, inputsHash, evidenceRefs, ts}` — written **only**
through `artifact.publish` by a process-bound principal (no renderer or CLI
side-door). `approval`: holds until a human grant recorded via the existing
operator surface (human = external principal; never a node). Digest splits
**design** (topology, empty seats) from **completion** (stamped, cleared) —
I13 becomes a test.

**|- acceptance**
- proof edge with no stamp → downstream phase blocked with reason naming the
  missing step
- stamp published by a bound occupant → phase clears on the next derive; the
  clearing stamp is listed in the digest completion section with its refs
- a stamp written by an unbound path is impossible — the only writer is the
  admitted `artifact.publish` op (test attempts a direct write and fails)
- empty-seat fixture appears under design, never under completion (I13)

**Reviewer brief:** this plane is only worth shipping if it cannot be
theatered — attack it: forge a stamp via document edit (must not clear phase —
stamps live in sink runtime state, not authored canvas fields), replay an old
stamp against new inputs (`inputsHash` must gate), publish from an unedged
actor (ScopeError).

---

### S9 · Scheduler pulse — edge-routing verification

**Lane:** kernel. Schedule when the kernel is quiet (check hot-lane probe).

**Scope:** verify against I14: watcher/timer pulse delivery must route along
edges to eligible actors; region geometry supplies evaluation context and the
*manual* pulse audience only. If code already complies, this slice is a test
that witnesses it; if geometry mints automatic delivery anywhere, fix to
edge-routing. Membership reads must already go through S1's single function.

**|- acceptance**
- watcher fires; actor in-region *without* an edge receives nothing
- actor with an edge receives the pulse (in or out of region)
- manual region pulse reaches eligible members (unchanged operator action)

**I22 deference:** this slice verifies **local-runtime** pulse routing only.
Where fleet-wide schedulers execute, and what a Station's watchers may pulse
while Command Center is unavailable, is doctrine open decision #4 — this
slice must not encode an answer.

---

### S10 · Schema vocabulary consolidation

**Lane:** shared schema + adapters. Safe now; coordinate if fleet lane is in
`settings/`.

**Scope:** historical source names (`tower`, `quasar`, `booth`) in the schema
vocabulary go; live adapter plane is hermes-only; offline bindings degrade
without inventing grants (doctrine already states this — make the schema
match). No aliases kept for internal consumers.

**|- acceptance:** grep for the retired names in `src/shared` returns only
historical-note comments, if anything; load of an old document with retired
source strings degrades cleanly (test fixture).

---

### S11 · Placement plane — actor classes, tiers, runtime routing — **DONE**

**Lane:** `src/shared/physics/` + a typed seam to the fleet lane. Landed on
frozen fleet types (`ether.host`, `resolveNodeHostId`, station-status as
topology inputs). Live CC-reachability liveness is **not** wired here (later
call-site). The §4.5 residency decisions are closed (D1/D2).

**Why this is physics, not fleet plumbing (doctrine, verbatim intent):** actor
classes — Command Center actor · Station actor · External actor · Facility —
and runtime tiers 1–4 "directly impact their ports and edges they can connect
and what sinks / schedulers they can be connected to." Role×role laws alone
are the intra-runtime half; placement is the inter-runtime half of the same
admit decision.

**Scope:**
- `PlacementView` seam: per-node `{runtime: cc | station(hostId) | external |
  facility, tier: 1|2|3|4}` resolved from `ether.host` + station topology —
  produced by fleet-lane types, consumed here; interface + null producer
  first (same pattern as `ActivityFeed`)
- admit gains the placement check, ordered before ports: unknown placement →
  deny; **facility → deny always**; cross-runtime route must be CC↔Station —
  a Station-actor → other-Station-target admit is denied with a denial reason
  naming the missing CC route (never silently relayed)
- port tier floors: each `Port` carries a minimum tier (e.g. host-local
  surfaces tier ≤2; protocol-safe ops available at tier 3 — maximize tier-3
  capability per doctrine); admit intersects as with offers
- canvas + inspector surface class/tier/assignment chips (doctrine: "must be
  visible on the canvas and in inspection overlays")

**|- acceptance**
- station-A actor → station-B page: denied with a route denial (not `no_port`)
- facility node: zero admits, zero wields, visible on canvas as facility
- tier-3 actor admits protocol-safe ports, denied host-local ones; table test
  over class × tier × port
- placement unknown (stale projection) → fail closed, honest denial

**Reviewer brief:** the trap is placement leaking in as a *fourth role* or as
an ACL table. It must stay a view input to the same admit, alongside
connectivity and offers. Hunt for any Station↔Station path that survives via
relays — doctrine law 6 says relays repeat the checks.

---

### §4.5 · Residency decisions — **CLOSED by operator 2026-07-24**

**D1 — Sink residency: DECIDED.** Data sinks (`task`, `requests`,
`artifacts`) are Command-Center plane resources; physical sinks (`page`,
runtime surfaces) are Station-resident, accessible to that Station's actors
and CC actors. When CC is unreachable, a Station actor's **reads** come from
the intent projection; **mutations** (task claim, msg send, stamp publish)
require CC live and fail with an honest "work plane unreachable" denial. No
queue-and-forward machinery. Consequence: mailboxes-are-sinks + CC-owned data
sinks ⇒ every actor↔actor message is CC-routed **by construction** — law 6
holds with zero extra machinery.

**D1x — Station-locked sinks (parked extension, operator-designed).** A data
sink may be locked to a specific Station (`sink[station]`, like pages) and is
then accessible only there, as a local resource. Changing a locked sink's
Station is a **CC-mediated data migration**: a small migration window during
which the sink's edges are set to a `disabled` state, until the connected
nodes are reassigned to the destination Station. Parked as a separate feature
— but the migration/edge-disable mechanics are needed **wholesale for page
nodes anyway** (page relocation already implies session teardown per the
doctrine's revocation section), so design them once, there.

**D2 — Scheduler residency: DECIDED.** Fleet-wide schedulers execute at CC
only. Station-scoped watchers ship inside the Station's intent projection and
keep pulsing Station-local targets under last-received intent while CC is
unavailable (stateless-Station consistent — projection is intent, tick is
runtime).

**A2A shape: CONFIRMED** — discovery default; direct actor↔actor inboxes
survive as explicit opt-in `msg.*` edge ports (S3 as written).

Doctrine open decision **#5** (exact Station projection contents) remains
open and fleet-lane owned; I22 still applies to it.

---

### J-series · New kinds (designed, unscheduled — do not start without operator go)

| kind | role | ports | seal |
|---|---|---|---|
| `fs` / `git` | sink | `fs.read`, `fs.write`, `git.commit`, `git.push` (separate ports) | machine-safety: path-scoped handles, no ambient shell equivalence |
| desktop surface | sink | `computer.use` | actor drives the surface via edge; SSH/RDP is transport, never authority |

Each is one `KindSpec` row + ports + seal + tests. The PR test in the doctrine
doc applies verbatim.

---

## 5 · Sequencing & concurrency protocol

```
S1 ──► S2 ──► S3* ──► S6
              │
              ├────► S8
S5 (parallel from day one, null producers)
S7 (after cone consumers stable; consumes S5 if present)
S4 (probe hot lane, then anytime)
S9 (kernel quiet window; local-runtime scope only — I22)
S10 (anytime; probe settings/)
S11 (contract now; implementation after fleet-lane types + D1/D2 decisions)

*S3 lands on the canvas-authority store path (I21) — waits for that lane.
```

- One slice per agent per branch of work; commit per cut inside a slice.
- Stage and commit **your files only**; unfamiliar dirty files belong to
  another agent — never stash, revert, or "clean up" foreign work.
- No consolidation passes across slices; kill obligations live inside the
  slice that owns them.
- Every report: reality-probe results, invariants moved (§1 row + new
  enforcement level), pulsar verdict pasted, commit hashes.

## 6 · Program definition of done

- [ ] §1 rows I7–I10, I12–I14, I16 at target enforcement, each witnessed by a named test
- [ ] §3 gaps closed: occupancy consumed, attenuator UI live, RTS ranking live, proof plane live
- [ ] kill obligations executed: one membership function, no intersection merge, no ActorActor Full, no retired source names
- [ ] the demo script in the product story runs against the real app without a single "not yet" — draw → grant → attenuate → occupy → pulse → stop → glance → prove → revoke
