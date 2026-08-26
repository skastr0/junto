# Capability and revocation matrix (Phase 5)

**Status:** audit of implementation truth vs Phase 5 target  
**Date:** 2026-07-23  
**Governs:** Linux production critical path item 4 (Phases 4–5); pairs with
[`fleet-station-architecture.md`](./fleet-station-architecture.md) revocation plane
and [`security-doctrine.md`](./security-doctrine.md).

**Doctrine (target):** edges + ports + process-bind; no client-supplied
identity; edge delete revokes the **next action**; page delete closes the owned
session; actor delete revokes then terminates **OwnedProcess only**.

**Companion north stars:**

| Doc | Plane |
|------|--------|
| [`architecture-factory-physics.md`](./architecture-factory-physics.md) | who may wield a seat |
| [`architecture-machine-safety.md`](./architecture-machine-safety.md) | how host power is held |
| [`local-control-trust-boundary.md`](./local-control-trust-boundary.md) | socket / token transport |

---

## Legend

| Symbol | Meaning |
|--------|---------|
| **Met** | Product path enforces the target property |
| **Partial** | Core path correct; policy default, coverage, or side-effect lag |
| **Gap** | Target not implemented on the authoring/lifecycle path |
| **N/A** | Not applicable to that surface |

---

## 1. Process-bind identity

| Property | Target | Current | Status | Evidence |
|----------|--------|---------|--------|----------|
| Identity source | Unix peer PID (+ ancestor walk) of a main-registered process | Work + browser control call `admitProcessIdentity` → `readUnixPeerPid` + `resolveInTree` | **Met** | `src/main/vellum/process-identity.ts`, `work/control.ts` (~901–923), `browser/edge-grant.ts` `admitSocket` |
| Who may bind | Main registers ACP child / native terminal | Chat binds local ACP `childPid`; term binds native PTY | **Met** | `chat/service.ts` `bindLocalProcess`, `term/local-host.ts` |
| Client nodeRef | Never identity | Token + peer PID only; `VELLUM_COMMAND_NODE_REF` is not an identity claim on control | **Met** | `work/control.ts` comments; `cli/core/socket.ts`; env still named for other tooling, not admit |
| PID reuse | Start-key epoch rejects recycled PID | `readProcessStartKey` / `lstart` stored at bind; resolve unbinds on mismatch | **Met** | `process-identity.ts` `bind` / `resolveLive` |
| Work caller resolution | Map principal → unique agent card | `resolveCallerAcrossCanvases` / `resolveCallerOnDoc`; ambiguous → ScopeError | **Met** | `work/caller-resolve.ts` |
| Browser caller resolution | Same process-bind; only agents wield browser | Terminal principals denied; agent → edge pages | **Met** | `browser/process-bind.ts` |
| Transport token | Shared secret for socket membership, not principal | Bearer token at `~/.vellum-command/work/token` (work) / browser control token; checked before process-bind | **Met** | `work/control.ts` `workTokenMatches`; not a substitute for PID |

**Verdict:** process-bind is the live identity plane for both work and browser
protected routes. No product path treats client-supplied nodeRef as the seat.

---

## 2. Edge / port authorization (work ops)

| Property | Target | Current | Status | Evidence |
|----------|--------|---------|--------|----------|
| Per-call graph admit | Fresh canvas + undirected edge + port | `dispatchOp` reads canvas via `CanvasesService`, then `admitWorkTarget` → `admitPure` + `portForWorkOp` | **Met** | `work/control.ts`, `work/authz.ts`, `shared/physics/*` |
| Port facets | Op requires matching port on sink | KindSpecs offers ∩ role law ∩ compiled verb grant (`compileVerb`) — ports are no longer authored, only compiled from the edge's verb | **Met** | `physics/kinds.ts`, `physics/view.ts`, `physics/verbs.ts` |
| Region membership | Visibility only, never host power | `regionVisibility` / co-members listed; admit returns `not_connected` without edge | **Met** | `work/authz.ts` `visibilityOf`, `admitPure` |
| Meta ops | ping / doctor / capabilities / onboard without edge | Explicitly not ported; still require process-bind | **Met** | `work-ports.ts`, `requiresConnection` |
| Kind ops surface | Agent may only exercise ops sink offers | `OPS_BY_KIND` + physics offers; wrong kind → ScopeError | **Met** | `work/authz.ts` |
| Discovery for agents | Onboard lists connected grants | `capabilities` / `onboard` return connected nodes, roles, held ports | **Met** | `work/control.ts` capabilities/onboard handlers |

**Verdict:** work mutations and full target reads are edge+port gated on every
request against the live document. Soft relates (no claimed blocking item)
still mint capability reach; stoppage remains phase-only.

---

## 3. Edge delete → next action

| Surface | Target | Current | Status | Notes |
|---------|--------|---------|--------|-------|
| Work control | Immediate next op fails closed | Canvas re-read every op; missing edge → `ScopeError` | **Met** | No long-lived work capability secret beyond process seat |
| Browser control (new request) | Immediate next HTTP protected route denied | `canvases.subscribeChanges` → `edgeGrant.invalidateCanvas` revokes cached grants; next `admitSocket` re-resolves edges | **Met** | `src/main/index.ts` wiring; `edge-grant.ts` change sequence blocks mid-admit races |
| Browser control (in-flight lease) | Aborted when ocap revoked | `capabilities.revoke(handle)` terminates records / aborts leases | **Partial** | Revoke is best-effort on invalidate; generation checks on session ops add a second gate, but in-flight handlers that already passed admit can race until terminate |
| Soft phase only | Edge delete must not leave phantom phase | Phase is derived; edge gone → no stoppage evaluation | **Met** | Factory physics phase plane |

**Verdict:** work path is pure next-action. Browser path is next-request +
cache revoke; treat residual in-flight races as hardening debt, not a second
identity model.

---

## 4. Page node delete / browser session close

| Property | Target (Phase 5) | Current | Status |
|----------|------------------|---------|--------|
| Delete page → close owned session | Always close Vellum Command-owned session for that page ref | Default `ether.browser.onDelete` is **`kill-session`** (Phase 5); operators may author `detach` | **Met** (default) |
| Detach path | (if kept) must not leave automatable session under deleted ref | Detach: `closeDockBrowser` removes dock surface; warm session may remain until explicit stop / pool policy | **Partial** |
| Kill path | Exact-handle stop before document mutation | `stopDockBrowser` → `browserStop`; failure **blocks** node delete | **Met** when policy is `kill-session` |
| Edge revoke vs session | Edge delete denies control; session may still exist until page policy | Edge revoke is independent of session close | **Partial** (by design for edge-only; Phase 5 wants page delete stronger) |
| Authz after page gone | No automate without page node + edge | Process-bind resolve drops non-page / missing targets; page-target `not_found` | **Met** for **next** control action |

**Product code:** `src/renderer/lib/mutations.ts` `deleteNodesInternal` +
`resolveBrowserOnDelete` in `src/shared/canvas.ts`.

**Verdict:** default page delete is **kill-session** (stop-before-delete). Detach remains an explicit operator field.

---

## 5. Actor delete → revoke then terminate OwnedProcess

| Actor kind | Target | Current on node delete | Status |
|------------|--------|------------------------|--------|
| **agent** (ACP) | Unbind process-bind + revoke tools + terminate OwnedProcess (tier 1/2 Vellum Command-owned) | Node delete calls `closeChat(agentKey)` → unbind + ACP client teardown | **Met** (delete path) |
| **terminal** (native) | Same as machine-safety OwnedProcess | Default detach while app lives; quit path uses process plane | **Partial** |
| Process-bind on chat close / exit | Unbind so CLI cannot retain seat | `unbindLocalProcess` / `unbindAgentKey` on close and lifecycle exit | **Met** (lifecycle path, not node-delete path) |
| Termination mechanism | OwnedProcess only — never bare pid | `app-process-plane` → `signalOwned` / `signalOwnedGroupLeader` | **Met** when terminate is invoked |

**Verdict:** agent card delete awaits verified `chatClose` teardown before
document mutation. Residual: terminals still default detach.

---

## 6. Bare PID kill paths

| Call shape | Allowed? | Where | Status |
|------------|----------|-------|--------|
| `process.kill(-pid, TerminatingSignal)` | Only via OwnedProcess group authority | Sole site: `process-signal.ts` `signalOwned` | **Met** |
| `child.kill(signal)` | Only via admitted OwnedProcess | Same module + opaque child handle | **Met** |
| `process.kill(pid, 0)` | Liveness probe only | `process-identity.processAlive`, `probeProcessAlive` | **Met** (non-terminating) |
| Ambient `kill(pid)` from work/browser/authz | Forbidden | Grep: no product terminating bare-pid outside process-signal | **Met** |
| Tests | May probe exit with `process.kill(pid, 0)` | `tests/*` fixtures | N/A |

**PR test (machine safety):** a confused agent or test cannot pass a bare pid
into a host-destructive call without minting OwnedProcess at spawn.

---

## 7. Capability visibility in UI

| Surface | What operator sees | Status |
|---------|-------------------|--------|
| Edge inspector | Derived roles + effective port chips (offers ∩ mask); mask label | **Met** (read-only) — `InspectorFields.tsx` `EdgeCapabilitySection` |
| Edge verb authoring | Bottom-bar sentence picks the verb (`swapEdgeVerb`, `RtsControls.tsx`); ports are compiled from it, not separately edited | **Met** — attenuation is no longer a product surface; ports are all-or-nothing per verb |
| Node inventory | Connected ops summary for work agents via CLI `onboard` / `capabilities` | **Met** for agents; **Partial** for canvas operator view |
| Actor tier / residual risk | Doctrine wants tier + residual risk honest | **Gap** — no unified operator “capability residual” badge on nodes |
| Digest / SVG | Read-only board projection; no process-bind leakage | **Met** by design |

---

## Current vs target matrix (summary)

| Control event | Target effect | Work plane | Browser plane | Process plane |
|---------------|---------------|------------|---------------|---------------|
| Draw edge | Mint ocap | Next op can admit | Next admit can mint edge-grant | Unchanged |
| Delete edge | Revoke next action | **Met** (re-read) | **Met** (invalidate + re-admit) | Unchanged |
| Change edge verb | Narrow/widen next admit | **Met** | **Met** (`browser.automate` gated by the `navigates` verb) | Unchanged |
| Delete page node | Close owned session | N/A (no work ports on page) | **Gap** default detach | Session stop only if policy |
| Delete agent node | Revoke + terminate OwnedProcess | Seat card gone → caller resolve fails (**Partial** revoke) | Same if process still bound until unbind | **Gap** no terminate |
| Close chat / process exit | Unbind identity | **Met** | Edge-grant subscribe revokes cache on principal change | Terminate via chat teardown when owned |
| App quit | Drain OwnedProcess | Socket down | Control stop | **Met** process plane |

---

## Gaps ranked by severity

### S0 — Actor (agent) delete does not terminate OwnedProcess

- **Impact:** Operator believes removing the agent card stops the agent; ACP
  child and process-bind can survive until chat close/quit.
- **Target:** revoke admission → graceful terminate OwnedProcess → verify exit
  (security doctrine tier 1/2 Vellum Command-owned).
- **Slice:** on agent node delete (and optionally agent node unbind from
  canvas), main path: `chatClose(agentKey)` / process-plane terminate for the
  bound local session only; never bare pid. Keep remote ACP honesty (tier /
  external lifecycle).

### S1 — Page delete default does not close owned session

- **Impact:** Deleted page card can leave a warm WebContentsView / automatable
  session until stop or pool eviction; Phase 5 wording requires close.
- **Product choice (pick one and ship):**
  1. **Align to Phase 5:** default `onDelete` to `kill-session` for pages, or
     always stop-before-delete on page card removal regardless of field; or
  2. **Keep detach default** but document residual risk + force UI residual
     indicator + ensure deleted ref cannot be re-automated (edge+target gone
     already helps next action).
- **Slice:** if (1): change `resolveBrowserOnDelete` product default **or**
  hard-wire stop in `deleteNodesInternal` for page kind; keep fail-closed
  delete block when stop fails.

### S2 — Operator residual-risk / tier visibility incomplete

- **Impact:** UI shows edge ports but not “this actor still owns a live process”
  or “page session still warm after detach.”
- **Slice:** occupancy + session badges already partially exist elsewhere;
  wire a single capability residual strip: process-bind live? open ACP?
  warm browser sessions for connected pages? Use live state only (never
  authorial role).

### S3 — Browser in-flight race after edge invalidate

- **Impact:** Low: short window between admit and handle terminate under load.
- **Slice:** on `invalidateCanvas`, await/abort active leases for that canvas’s
  targets; tests for “edge deleted mid-request → completion denied.”

### S4 — Terminal onDelete defaults vs “actor delete terminates”

- **Impact:** Medium for remote panes (detach is intentional product history).
- **Slice:** treat an attached terminal as often **externally attached** (doctrine tier
  language): revoke Vellum Command capability always; kill only on explicit policy or
  OwnedProcess. Document rather than force-kill remote tmux.

---

## Concrete next implementation slices

Ordered for Phase 5 exit without a rewrite fantasy.

### Slice A — Agent card delete lifecycle (S0)

1. From `deleteNodesInternal` (or main canvas mutate hook), detect
   `entity.kind === "agent"` with `entity.name` (hermes key).
2. Invoke existing `chatClose(agentKey)` (unbind + ACP teardown + process-plane
   terminate for local).
3. Tests: delete agent node → process-identity unbound → work control
   `AuthError` process_unbound; local child exit receipt via OwnedProcess only.
4. Remote agents: close Vellum Command session; report if provider process is external.

### Slice B — Page delete session policy (S1)

1. Decide default (recommend Phase 5: stop owned session on page delete).
2. Implement in one place (`deleteNodesInternal` already has the stop-before-
   delete path for `kill-session`).
3. Tests: page with live session deleted → session list empty for that ref;
   edge-grant cannot mint targets for deleted node.

### Slice C — Revocation matrix tests as CI gate

1. Golden tests (unit + control transport):
   - edge present → work op ok; edge deleted → next op ScopeError
   - edge present → browser admit ok; edge deleted → next admit not_connected
   - process unbound → AuthError
2. Place under `tests/work-control-transport.test.ts` /
   `tests/browser-edge-grant.test.ts` extensions — no new framework.

### Slice D — Residual capability UI (S2)

1. Inspector / node chip: “seat occupied” from process-identity snapshot +
   chat open state; “browser warm” from session list for page refs.
2. No authorial fields; derived only.

### Slice E — Optional mid-flight browser harden (S3)

1. `invalidateCanvas` → registry revoke already present; add test that in-flight
   use sees `revoked_*` / forbidden after edge drop.
2. Only if Slice C shows a real race in product.

---

## Non-goals (this matrix)

- Same-UID hostile process isolation (doctrine non-claim).
- Station-to-station capability.
- Replacing process-bind with capability secrets for agents.
- Making region membership a grant.
- Bare-pid “cleanup helpers” outside process-signal.

---

## Related code index

| Concern | Path |
|---------|------|
| Process-bind map + peer PID | `src/main/vellum/process-identity.ts` |
| Work socket + per-op admit | `src/main/vellum/work/control.ts`, `work/authz.ts`, `work/caller-resolve.ts` |
| Pure physics admit | `src/shared/physics/admit.ts`, `kinds.ts`, `view.ts`, `work-ports.ts` |
| Browser process-bind + edge-grant | `src/main/vellum/browser/process-bind.ts`, `edge-grant.ts`, `authz.ts` |
| Browser capability leases | `src/main/vellum/browser/capabilities.ts` |
| Canvas change → revoke grants | `src/main/index.ts` (`subscribeChanges` → `invalidateCanvas`) |
| Page/agent delete side effects | `src/renderer/lib/mutations.ts`, `dock-state.ts` |
| OwnedProcess signals | `src/main/vellum/process-signal.ts`, `app-process-plane.ts` |
| UI capability chips | `src/renderer/components/InspectorFields.tsx` |
| Chat bind/unbind | `src/main/vellum/chat/service.ts` |

---

## Exit criteria for Phase 5 (capability/revocation)

Linux production contract: *“Agents exercise only currently connected
capabilities; revocation is next-action.”*

| Gate | Check |
|------|--------|
| G1 | Work op after edge delete → ScopeError without restart |
| G2 | Browser protected route after edge delete → admit denial |
| G3 | No terminating `process.kill` outside process-signal (architecture test) |
| G4 | Agent node delete → local OwnedProcess terminate + process-bind unbound |
| G5 | Page node delete → no live owned session for that page ref (once policy chosen) |
| G6 | Operator UI does not claim stronger termination than tier allows |

G1–G3 are largely true today. **G4–G5 are the Phase 5 implementation work.**
G6 is documentation + residual UI (Slice D).
