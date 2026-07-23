# Fleet topology migration (Phases 4–5)

**Status:** design for implementation after Phase 3 residual  
**Governs:** Command Center ↔ Station intent delivery, actor tiers, revocation  
**Doctrine:** `docs/security-doctrine.md`, `docs/architecture-factory-physics.md`

## Product sentence

One sovereign operator; one factory; Stations apply complete Command Center
intent without negotiation; agents exercise only currently connected
capabilities.

## Actor classes and capability tiers

| Actor | Tier | Authority source |
|---|---|---|
| Command Center actor | 1 | Same CC runtime; full authoring of protected intent |
| Station actor | 2 | Same Station runtime; enact latest complete projection only |
| External actor | 3 | Assigned Vellum CLI/MCP over operator connection + edges |
| External resource | 4 | Visible inventory; cannot execute the graph |

## Fleet invariants

1. Every installation belongs to at most one fleet and one role.
2. A machine is not both Command Center and Station.
3. Fleet identity — not network discovery — defines membership.
4. No Command Center is created through SSH alone.
5. Tier 4 acknowledgement, Tier 3 integration, and Tier 2 Station install are
   separate explicit operator actions.
6. Stations never discover or adopt themselves.
7. No Station-to-Station control plane.

## Intent delivery (target)

```
CC authors protected intent
  -> compile Station-specific complete projection
  -> deliver over authenticated operator path
  -> Station atomically replaces previous projection
  -> Station enacts; never merges/negotiates/vetoes
```

Offline Station continues latest applied projection. On reconnect, newest
complete projection applies immediately. Unreachable Station surfaces as
unreachable/rogue with operator diagnostics — no invented state.

## Migration from current code

| Current | Target |
|---|---|
| `canvas-pull.ts` SSH copy of CC `*.canvas` files | signed/complete projection install into Station cache |
| `settings.json` role + `hosts.json` endpoints | sealed topology + fleet membership document |
| Work/browser control process-bind + edges | retain; make tier/capability visible on nodes |
| Doctor reachability | expose generation, last intent id, last contact |

## Implementation sequence

1. **Projection schema** — versioned complete Station projection (intent +
   assigned resources); not a partial merge document.
2. **CC compiler** — from protected canvas + topology, emit per-Station
   projection with content hash / generation id.
3. **Delivery** — replace ad-hoc canvas-pull with atomic projection replace;
   fail closed on incomplete transfer.
4. **Station enact** — apply projection to local runtime; never author.
5. **Revocation plane** — edge delete → next action denied; page delete closes
   owned session; actor delete revokes then terminates OwnedProcess only.
6. **Migration / recovery** — CC yield transfer; recovery material; explicit
   Station local/SSH reset. No random CC reclaim.

## Explicit non-goals

- Station lease / delegated-offline state machines
- Quorum or peer-to-peer intent
- Absorbing SSH/provider/harness credentials into Vellum
- Same-UID hostile process isolation (doctrine non-claim)

## Exit gate (Phase 4–5)

- Enrollment, offline operation, reconnection, migration, recovery, explicit
  reset all pass.
- Capability matrix: no action across absent edge/port; no bare PID authority.
- No station-to-station protocol in tree.
