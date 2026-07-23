# Protected topology migration

**Status:** Phase 3 first cut shipped (station + hosts enrollment); full
protected store not yet.

**Doctrine:** [security-doctrine.md](./security-doctrine.md) — *Protected settings*:
station role, Command Center identity, factory membership, and equivalent
topology state must not be minted by editing a plaintext settings file alone.

## Mental model

| plane | fields | ambient plaintext edit | mutation path |
|---|---|---|---|
| **prefs** | appearance, canvas, kernel, browser, audio, advanced | accepted (schema-bounded) | `settingsPatch` |
| **station topology** | `station.role`, `hostId`, `agentHostId`, `commandCenterRef`, `supervisedPreferred` | **not trusted** without app seal | `settingsSetStationTopology` only |
| **hosts enrollment** | `hosts.json` fleet membership (endpoints, capabilities) | **not trusted** without app seal | HostsService / registry app writes only |

Topology still *serializes* into `settings.json` / `hosts.json` for readability
and offline tools. Authority to **admit** that topology at process start is the
seal, not the plaintext fields.

## What shipped (this cut)

### Station topology (`settings.json`)

1. **App-owned seal** next to the settings file (same directory as
   `VELLUM_SETTINGS_PATH` / `~/.vellum/`):
   - `topology.key` — 32-byte machine-local HMAC secret (mode `0600`)
   - `topology.seal` — `{ version: 1, alg: "hmac-sha256", mac }` over a
     canonical topology body
2. **Load admit** (`admitStationTopology`):
   - no key + no seal → **bootstrap** (accept + write seal) — first run and
     post-configure remote
   - key/seal missing asymmetrically, corrupt, or MAC mismatch → **fail closed**
     (strip station to defaults / role unset → `StationRoleGate`)
3. **Write path:** every settings write reseals current station topology.
4. **API boundary:** generic `settingsPatch` rejects any `station` key;
   dedicated IPC `settingsSetStationTopology` merges, validates, persists, seals.
5. **CC configure/deploy:** after stamping remote `settings.json`, deletes
   remote `topology.key` + `topology.seal` so the remote app bootstraps a seal
   for the operator-stamped role on next start.

Code: `src/main/vellum/settings/topology-seal.ts`, `service.ts`,
`settings/ipc.ts`, hosts configure/stamp scripts.

### Hosts enrollment (`hosts.json`)

Parallel seal for fleet membership (same mechanism, separate material):

1. **App-owned seal** beside `hosts.json` (`VELLUM_HOSTS_PATH` / `~/.vellum/`):
   - `hosts.key` — 32-byte machine-local HMAC secret (mode `0600`)
   - `hosts.seal` — `{ version: 1, alg: "hmac-sha256", mac }` over a canonical
     hosts document body
2. **Load admit** (`admitHostsDocument` in `hosts/hosts-seal.ts`):
   - no key + no seal → **bootstrap** (accept + write seal) — first run /
     upgrade
   - key/seal missing asymmetrically, corrupt, or MAC mismatch → **fail closed**
     (local-only default registry; disk rewritten to match)
   - Invalid JSON / schema still surfaces as errors to list/Doctor (unchanged);
     boot routing stays local-only via HostsServiceLive catch
3. **Write path:** every registry save reseals (`atomicWriteAndSeal`).

Shared primitives: `src/main/vellum/document-seal.ts`. Domain tags stay
separate (`vellum-topology-v1` vs `vellum-hosts-v1`).

Code: `src/main/vellum/hosts/hosts-seal.ts`, `hosts/registry.ts`.

## Residual risk (until full protected store)

| risk | status |
|---|---|
| Offline edit of `settings.json` **after** a seal exists | **mitigated** — MAC fail → role unset |
| Offline edit of `hosts.json` **after** a seal exists | **mitigated** — MAC fail → local-only |
| Delete seal only (key remains) | **mitigated** — fail closed |
| Delete key only (seal remains) | **mitigated** — fail closed |
| Same-user deletes **both** key and seal, then edits role / fleet | **open** — bootstrap accepts; same-user file power |
| Same-user deletes `hosts.key` **and** `hosts.seal`, then forges membership | **open** — same residual as station topology |
| Recovery codes / factory transfer ceremony | **not built** |
| Topology in a non-plaintext vault separate from settings | **not built** |
| Multi-machine factory pairing / CC transfer protocol | **open** (doctrine open decisions) |
| Remote stamp over SSH without remote process participation | seal invalidation + bootstrap only — no remote-side operator reauth |

Plaintext is not itself the defect; **ordinary file edits becoming operator
intent without an app-owned write** is. This cut closes the accidental/offline
mint path for anyone who cannot also rewrite the seal material. It does not
claim hostility against a fully privileged same-user attacker.

## First-run and Remote configure

- **First run:** empty role sealed on default create; `StationRoleGate` still
  required; pick → `setStationTopology` → reseal. Hosts registry seeds local
  only and seals.
- **Existing installs:** first load after upgrade bootstraps a seal over the
  current role / hosts membership (no key/seal yet). From then on, offline
  edits fail closed.
- **CC `configure-remote` / deploy stamp:** writes remote settings, removes
  remote topology seal material; remote first start bootstraps. (Hosts seal is
  local to each station's enrollment file; remote hosts.json is not stamped
  by CC in this cut.)

## Next migration steps (not this pass)

1. Move topology out of ambient prefs document into an app-only store (or
   encrypt-at-rest with a key Vellum mints at enrollment).
2. Catastrophic-action reauthentication for CC transfer / factory recovery
   (doctrine open decisions 1–3).
3. Optional: refuse bootstrap when a factory-pairing marker exists (stops
   same-user key+seal wipe re-bootstrap without recovery codes).
4. Remote stamp that plants a seal under a CC-delegated factory key (stronger
   than bootstrap after `rm`).

## Tests

- `tests/settings.test.ts` — topology seal admit / tamper / patch boundary
- `tests/remote-hosts-registry.test.ts` — hosts seal write / bootstrap / tamper
  fail-closed
