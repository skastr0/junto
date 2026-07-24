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

This document is the north star for agent authz, work control, region pulse,
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
agent/herdr seat, admitted by Unix peer PID (+ PPID walk). The document edge is
necessary but not sufficient; the seat must be occupied by a bound process to
exercise host-adjacent ops.

### 2. Roles are derived from kind — never authorial

| Role | Typical kinds | Factory function |
|------|---------------|------------------|
| **Actor** | `agent`, `terminal`, `herdr` | Occupies a seat; wields outbound edges under process-bind |
| **Sink** | `task`, `requests`, `artifacts`, `page` | Receives ops; target of inbound capability |
| **Scheduler** | `watcher`, `timer` | Pulses regions; does not hold user-facing seats |
| **Region** | group + `ether.region` | Geography + pulse briefing container |
| **Furniture** | notes, labels, unknown/open-vocab kinds (incl. retired `project` strings) | Spatial annotation; no seat, no ocap wield |

**Forbidden:** `ether.role` (or any authorial role field) as the source of truth.
Kind → role is derived in code. Wrong kind is fixed by changing entity kind, not
by stamping a role overlay.

**Physics role ≠ work role.** The role above (actor/sink/scheduler/…) is the
*physics* role — derived from kind, never authorial, governs capability. It is
**not** the same thing as a **work role** (e.g. `frontend`, `reviewer`): an
operator-authored label on a node used only by the **simulation** for task
claim-routing. The work role does not touch capability, edges, or ports; it is a
routing tag the tick reads to decide which worker claims which task. Two distinct
fields, two distinct layers. "No authorial role" forbids authoring the *physics*
role — it does not forbid the work-routing label.

### 2a. Blockability is a role property — never a per-kind list

"Blocked" is defined at the **physics-role level**, derived, never a
hand-maintained per-node/per-kind allowlist:

| Role | Can be blocked? |
|------|-----------------|
| **Actor** | **Yes** — an actor is a worker; it is blocked when it holds claimed work it cannot proceed on and cannot abandon (a claimed task in `input-required` / `auth-required`, or an open request against it). |
| **Sink** | No — sinks are inventory, never in a "blocked" state. |
| **Scheduler** | No. |
| Region / Furniture | No. |

A per-kind exclusion table (the old `isBlockableNode` shape) is the anti-pattern
the actor/sink/scheduler split exists to kill: node rules **must** live at the
physics/role level or the product becomes impossible to balance. Blockability is
`role === "actor"`, full stop.

**Blocking is worker-state, not a queue cascade.** A block is *not* generated by
an open task queue. `submitted` / `working` tasks never paint a block — that is a
factory humming. Stoppage is attention only: `input-required` / `auth-required`
on a tasks edge, or pending input on a requests edge, generates **blocks** on
the **direct `toNode` actor**. Manual `blocker` flags mark that actor only.
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

- **Seat** — stable document locus (usually an actor node) where a process may
  bind. Survives restarts; authored by humans.
- **Occupant** — live bound process (ACP agent, herdr pane, registered CLI
  descendant). Ephemeral; process-bind admits it.

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

### 5. Trust (org) vs attention (operator)

| Signal | Owner | Scope | Does it grant edges? |
|--------|-------|-------|----------------------|
| **Trust** | Org / station policy | Who may run as which profile, which hosts exist | No — only who can occupy seats that already have edges |
| **Attention** | Operator | Where the human is looking / what needs them | No — only prioritizes UI and pulse delivery |

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

Region `instruction` supplies briefing context. Watcher/timer pulses deliver
only to edge-connected eligible agents; geometry does not mint a route. A
manual region pulse remains an explicit operator action over eligible members.

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
| **Ambient region grants** | Region is geography + pulse, not a security domain |
| **Authorial `ether.role`** | Role is derived from kind; mirrors stay derived |
| **Client-supplied identity** | Process-bind only; no `VELLUM_NODE_REF` claims |
| **Encoding occupancy in the canvas file as authority** | Occupancy is live; restart re-baselines seats |
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
| Region `instruction` + watchers/timers | Briefing context + edge-routed scheduler pulse |
| Digest / render | Read-only projections; no capability mint |

Vocabulary note: schema may still name historical sources (`tower`, `quasar`,
`booth`). Live adapter plane is hermes-only; offline bindings degrade without
inventing grants.

---

## Related code

| Area | Module |
|------|--------|
| Document + criteria | `src/shared/canvas.ts` |
| Derived graph / phase | `src/shared/graph.ts` |
| Work control authz | `src/main/vellum/work/authz.ts` |
| Control socket + ScopeError | `src/main/vellum/work/control.ts` |
| Process-bind identity | `src/main/vellum/process-identity.ts` |
| Kernel pulse / watchers | `src/main/vellum/kernel/` |
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
