# Architecture north star: factory physics

**The canvas is a factory floor, not an ACL spreadsheet.**

> **Governing trust model:** read
> [`security-doctrine.md`](security-doctrine.md) first. Factory Physics enforces
> operator intent throughout Vellum-owned tooling. It is not a claim that
> Vellum confines a malicious process already running as the operator. If this
> document admits a stricter interpretation, the security doctrine wins.

Authority, work phase, and operator attention are three distinct planes. Edges
are object capabilities. Roles are derived from entity kind. Occupancy is live
state of a seat, never authored as a permanent grant.

This document is the north star for agent authz, work control, region geography,
and any surface that lets a process act on host-adjacent resources through
Vellum.

Companion: machine safety ([`architecture-machine-safety.md`](architecture-machine-safety.md))
seals *how* host power is held. Factory physics seals *who may wield a seat*
that reaches that power.

---

## Three planes

| Plane | Question it answers | Lives in | Mutated by |
|-------|---------------------|----------|------------|
| **Capability** | What may this principal reach? | Drawn edges + ports + process-bind | Human draw/delete; admit/release of bound process |
| **Phase** | Is work blocked or free to proceed? | Derived edge phase (`blocks` \| `relates`) from criteria + live worker/trust state | Recomputed; never authorial `ether.kind` input |
| **Attention / occupancy** | Is the seat empty, busy, or needing a human? | Live runtime state on seats | Process lifecycle, task status, operator focus |

Laws of plane separation:

1. **Capability does not imply phase.** An open edge lets you reach a sink; it
   does not mean work is unblocked.
2. **Phase does not imply attention.** Cleared criteria do not mean the
   operator is looking.
3. **Attention does not mint capability.** Focusing a node never grants edges.
4. **Cross-plane leakage is a bug.** Do not encode occupancy in document
   grants, or ACL lists in phase labels.

```text
human draws edge ──► capability (ocap exists)
criteria + live data ──► phase (blocks | relates)  // no depends / no cascade
bound process + live work ──► occupancy (empty…gone)
operator trust / focus ──► attention (org vs personal)
```

---

## Laws

### 1. Edges are object capabilities (ocaps)

An edge is a capability from `fromNode` toward `toNode`. No ambient graph walk.
No “same region ⇒ power.”

| Action | Effect |
|--------|--------|
| Human **draws** edge | Mint ocap (document records the capability) |
| Edge **ports** | Attenuate what the ocap may do (access filter) |
| Human **deletes** edge | Revoke ocap immediately |
| Soft edge (no criteria) | Capability to *relate*; never invents stoppage |

Wielding requires **process-bind**: a live registered descendant process of the
host-local actor seat, admitted by Unix peer PID (+ PPID walk). The document
edge is necessary but not sufficient; the seat must be occupied by a bound
process on that installation to exercise host-adjacent ops.

### 2. Roles are derived from kind — never authorial

| Role | Typical kinds | Factory function |
|------|---------------|------------------|
| **Actor** | `agent` only | Vellum-spawned template terminal; occupies one host-local seat and wields outbound edges under process-bind |
| **Sink** | `task`, `requests`, `artifacts`, `page` | Receives ops; target of inbound capability |
| **Scheduler** | `watcher`/`gauge`, `timer`/`cron`, `relay` | Sensors/clocks that fire **edge effects** (enqueue/set_flag); no seats, no region inject |
| **Region** | group + `ether.region` | Geography + optional briefing text |
| **Geography / furniture** | raw `terminal`, notes, labels, unknown/open-vocab kinds (incl. retired `project` strings) | Spatial or operator surface; no actor seat, inbox, work claim, or ocap wield |

**Forbidden:** `ether.role` (or any authorial role field) as the source of truth.
Kind → role is derived in code. Wrong kind is fixed by changing entity kind, not
by stamping a role overlay.

`worker` is reserved for a future native-agent surface and must not appear as a
current entity kind. ACP, terminal transport, SSH, and a provider harness are
transports or facilities, never additional actor kinds.

**Physics role ≠ work role.** The role above (actor/sink/scheduler/…) is the
*physics* role — derived from kind, never authorial, governs capability. It is
**not** the same thing as a **work role** (e.g. `frontend`, `reviewer`): an
operator-authored label on a node used only by the **simulation** for task
claim-routing. The work role does not touch capability, edges, or ports; it is a
routing tag the tick reads to decide which actor may claim which task. Two distinct
fields, two distinct layers. "No authorial role" forbids authoring the *physics*
role — it does not forbid the work-routing label.

### 2a. Blockability is a role property — never a per-kind list

"Blocked" is defined at the **physics-role level**, derived, never a
hand-maintained per-node/per-kind allowlist:

| Role | Can be blocked? |
|------|-----------------|
| **Actor** | **Yes** — an actor is blocked when it holds claimed work it cannot proceed on and cannot abandon (a claimed task in `input-required`, or a request it raised that is still pending — requests are claimed by their raiser at creation). |
| **Sink** | No — sinks are inventory, never in a "blocked" state. |
| **Scheduler** | No. |
| Region / Furniture | No. |

A per-kind exclusion table (the old `isBlockableNode` shape) is the anti-pattern
the actor/sink/scheduler split exists to kill: node rules **must** live at the
physics/role level or the product becomes impossible to balance. Blockability is
`role === "actor"`, full stop.

**Blocking is actor-state, not a queue cascade.** A block is *not* generated by
an open task queue. `submitted` / `working` tasks never paint a block — that is a
factory humming. Stoppage is claimed attention only: an `input-required`
item **claimed by** the direct `toNode` actor generates
**blocks** on that actor alone. Tasks are claimed by the actor that started
them; requests are claimed by the actor that raised them, at creation. An
unclaimed attention item is inventory for a human — it stops nobody. Claims
address the vellum node id (names are display labels, roles are routing tags).
Manual `blocker` flags mark that actor only.
There is **no** `depends` phase, **no** actor→actor relay, and **no** multi-hop
dependency cascade. Clear criteria → soft **relates**.

**Retired (do not reintroduce):** well-known `project` kind; edge criteria
modes `glyphs` / `wip`; `depends` phase; dependency cascade/relay between
packet-sinks or actors.

### 3. Ports vs criteria

Two filters on the same edge geometry; different jobs.

| | **Ports** | **Criteria** |
|---|-----------|--------------|
| Plane | Capability (access) | Phase (stoppage) |
| Question | May this actor invoke this op on this sink? | Does live work still block progress? |
| Absence | No port match → no access (fail closed on protected ops) | No criteria → soft **relates**; never generates blocks |
| Modes (criteria) | — | `tasks`, `proof`, `approval` (see document contract) |
| Authoring | Attenuation of the ocap | Phase filter on the ocap’s *progress semantics* |

Criteria **stay on edges**. They do not become node-local ACLs. Ports never
substitute for process-bind identity.

### 4. Seats vs occupants

- **Seat** — stable `agent` node where one host-local process may bind. Survives
  occupant restarts; authored by humans and compiled to one installation.
- **Occupant** — live Vellum-spawned agent process and its registered
  descendants in that seat. Ephemeral; process-bind admits it.

Occupancy spectrum (live, derived — not stored as permanent document truth):

| State | Meaning |
|-------|---------|
| `empty` | Seat exists; no bound process |
| `idle` | Bound; no active work item |
| `working` | Bound; active task / session in flight |
| `attention` | Needs operator input (permission, review, focus) |
| `activity_blocked` | Bound but phase plane says blocked (criteria stoppage on this seat) |
| `stalled` | Expected progress missing (timeout / heartbeat gap) |
| `parked` | Intentionally held (flag / operator park) |
| `gone` | Former occupant exited; seat vacant until rebind |

Seat without occupant ⇒ no wield. Occupant without edge ⇒ `ScopeError`. Both
required.

### 4a. Placement, sinks, and claims

Placement is execution locality, not a capability tier. An actor process,
browser page, terminal process, watcher, or timer runs only on its compiled
host installation. Logical task, requests, and artifacts sink identities may
appear in every complete Station projection, so a permitted actor can address
them across installation placement. Mutable rows do not become shared:

- each work entity and event has one authoritative installation home;
- a Command Center-home task may be claimed by a Remote actor only through a
  live synchronous Command Center-opened claim exchange;
- claim is task start (`submitted → working`), never a separate assignment,
  reservation backlog, or future work delegation;
- one actor has at most one pending claim attempt or active task;
- after the accepted claim, that exact task is Remote-homed and may advance
  there while Command Center is closed;
- a Remote-home task may be claimed locally by an eligible local actor;
- permitted requests and artifacts are created at the creating actor's home;
- browser page control is the locality exception: actor and page must share an
  installation because the page is a physical runtime.

Edges and ports authorize each operation. Projection visibility, matching
placement, or network reach alone authorizes nothing.

### 5. Trust (org) vs attention (operator)

| Signal | Owner | Scope | Does it grant edges? |
|--------|-------|-------|----------------------|
| **Trust** | Org / station policy | Who may run as which profile, which hosts exist | No — only who can occupy seats that already have edges |
| **Attention** | Operator | Where the human is looking / what needs them | No — only prioritizes UI |

Trust admits *people and hosts* into the factory. Attention routes *human
scarce time*. Neither rewrites the ocap graph.

### 6. Impact cones

An action’s **impact cone** is the set of seats and sinks reachable under
current capabilities and whose phase or occupancy will change.

- Cone root = principal seat (process-bound actor).
- Cone edges = outbound ocaps (attenuated by ports).
- Cone depth for phase = direct generating edges + blocked seats they mark
  (no multi-hop relay cascade).
- Cone never includes “everything in the region” without edges.

Region `instruction` is optional operator briefing text on geography.
Region pulse inject is retired; agents receive turns via factory claim, work
messages, board notify, and the managed-terminal seat UI.

### 7. Fail closed (authz)

| Situation | Behavior |
|-----------|----------|
| No edge from actor to target | `ScopeError` naming the missing edge |
| Edge exists, port denies op | Refuse op (no ambient escalate) |
| Edge + port ok, process not bound | Refuse — missing process-bind |
| Client claims `nodeRef` / env identity | Ignored; peer PID only |
| Region membership alone | Not a grant |
| Soft relates edge | Reach/relate only; no invented block phase |

---

## PR test

> Can an agent (or a bad test) obtain a **host capability** without a
> **connected edge**, a matching **port**, and **process-bind** admission?
> If yes, the change is not done.

Host capability here means any work-control or browser-protected op that can
mutate tasks, messages, requests, artifacts, or page control — not merely
reading a digest projection.

Pair with machine safety’s PR test for the sealed kill/path plane: factory
physics decides *whether* the seat may act; machine safety decides *whether*
the act can touch the OS.

---

## Explicit non-goals

| Non-goal | Why |
|----------|-----|
| **ACL matrix** (principal × resource × verb tables) | Ocaps + edges scale with the drawn factory; matrices diverge from the document |
| **Ambient region grants** | Region is geography, not a security domain |
| **Authorial `ether.role`** | Role is derived from kind; mirrors stay derived |
| **Client-supplied identity** | Process-bind only; no `VELLUM_NODE_REF` claims |
| **Encoding occupancy in the authorial document as authority** | Occupancy is live; restart re-baselines seats |
| **Criteria as access control** | Criteria filter phase/stoppage only |
| **Attention as authz** | Operator focus never mints edges |

---

## Mapping to today’s surfaces

| Surface | Factory physics reading |
|---------|-------------------------|
| Human draws edge in Command Center | Mint ocap |
| `ether.criteria` on edge | Phase filter (stoppage) |
| Work control socket + token | Transport; not identity |
| Process-bind (peer PID) | Occupant admission to seat |
| `authz` / `ScopeError` | Capability plane enforcement |
| Derived `blocks` / `relates` | Phase plane (stoppage vs soft relate; no depends) |
| Region `instruction` + watchers/timers | Briefing text + status/clock sensors (no inject) |
| Digest / render | Read-only projections; no capability mint |

Vocabulary note: the live source plane and watcher source schema are
hermes-only. Historical private-source bindings fail strict document decode;
they are not degraded through a compatibility rewrite. Unknown
`entity.kind` strings remain inert furniture and mint no grants.

---

## Related code

| Area | Module |
|------|--------|
| Document + criteria | `src/shared/canvas.ts` |
| Derived graph / phase | `src/shared/graph.ts` |
| Work control authz | `src/main/vellum/work/authz.ts` |
| Control socket + ScopeError | `src/main/vellum/work/control.ts` |
| Process-bind identity | `src/main/vellum/process-identity.ts` |
| Kernel watchers / timers | `src/main/vellum/kernel/` |
| Machine safety (host seal) | `docs/architecture-machine-safety.md` |

---

## Product promise

Vellum is a **premium station**. The factory floor is legible:

- what an agent can do is **what you drew**
- what is stuck is **what criteria + live data say**
- what needs you is **occupancy and attention**, not a hidden ACL
- host power still sits behind machine-safety seals

When in doubt: **draw the edge, attenuate the port, bind the process — or the
op does not exist.**

---

## The negative case — what this model refuses

Consolidated 2026-07-26 ([`factory-consolidation-plan.md`](factory-consolidation-plan.md)).
Each row was real code once; none of it is representable now.

| refused | why it was wrong |
|---|---|
| a second actor kind | three kinds carried `role: "actor"`, and ~12 call sites re-decided which was which — they disagreed about herdr. `ActorKind` is now one literal. |
| an actor whose kind depends on a live process | managed-ness was recomputed per open from `harness \|\| launch.kind`. A node is what it was authored as. |
| an actor that silently becomes a shell | an unresolvable launch fell back to a login shell, so a dead agent looked like a working terminal. It is an error state; the shell is a different variant. |
| a decoder that rewrites the document | `sanitizeActorSurfacePorts` deleted an actor's entity to satisfy a cross-kind rule. The document is the product: it is decoded, never corrected. |
| geography with a seat, ports, an inbox, or a work claim | herdr held message offers while being hidden behind a `legacy-surfaces` flag. Re-kind, never hide. **Display is exempt** — a geography node may show agent state. |
| a second admission path | route tokens minted seat identity for callers with no local Vellum. One path: the work-file token proves reach, process-bind proves who. |
| a port gated by a tier number | `PORT_TIER_FLOOR` crossed a 1–4 scale with each port. Placement is data; admission is role-pair law × kind offers × authorial mask. |
| a principal that resolves to nothing | three principal kinds × three optional ids, one of which matched no node. One shape, at least one anchor, canvas-pinned when it has no agent key. |
| ACP as a kind | ACP is a **transport**. It was wired into physics — an ACP child PID bound as an actor seat — which is what made it look like a kind. The chat surface and transport are kept, hidden, and severed; ACP will later carry the `worker` node. |
