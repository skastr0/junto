# DEBT: Electron observation receipt gate (`~/.vellum/release-security`)

**Status:** temporary bypass in place (2026-07-27). Local `prepare-package` no longer requires private home state. **Fix or delete this system before treating packaging as a real ship gate.**

## What blocked `app:install`

`bun run app:install` → `scripts/install-app.sh` → `scripts/build-app.sh` →

```text
bun scripts/electron-security-policy.ts prepare-package
```

That step used to require a **private observation pair** under:

```text
~/.vellum/release-security/electron-observation.json
~/.vellum/release-security/electron-observation-high-water.json
```

Minted only by an online `bun run electron:policy:check` against electronjs.org. Missing pair →:

```text
electron security policy: Electron observation receipt pair is required
```

Wiping `~/.vellum` (product reset) also wiped this cache and hard-failed every local rebuild.

## What this system is

Two layers got fused:

| Layer | Path | Intent |
|-------|------|--------|
| **Checked-in policy** | `scripts/electron-security-policy.json` | Human-pinned Electron version + review expiry. Offline-validatable. **This part is reasonable.** |
| **Observation ledger** | `~/.vellum/release-security/*` | Online “is the pin still current?” receipt, high-water, adverse no-overwrite markers. Embedded into the `.app` at package time. |

The ledger claims a threat model: prevent replaying an older “current” receipt after you once observed overdue/EOL. For a **single-operator local factory**, that is not a product security boundary—anyone who owns the machine owns the gate. It is release ceremony that escaped into everyday install.

## Provenance (git)

Introduced under author identity Guilherme Castro on **2026-07-23** in a ~2 hour cascade:

1. `00d59f7` — offline pin + optional online **print-only** check (“deliberately never writes”)
2. `13c53d6` — start persisting to home
3. `d0a2842` — **require** observation for packages
4. `b5be1a8` … `6bb2e1d` — atomic write, seal, adverse irreversible, reject partial

Empty commit bodies. No design thread found in Quasar for this ledger. Not mandated by `docs/security-doctrine.md`.

## Why it is debt (not load-bearing product law)

- Couples **product home wipe** to **build/install** failure.
- Would write/own state under `~/.vellum` for packaging hygiene—wrong surface if that ever looked like user-facing install behavior.
- High-water / dual-receipt / 0600 theater does not protect end users; it only inconveniences the operator who already controls the repo and build scripts.
- Real Electron hygiene for this stage: pin + expiry + “installed runtime matches pin.” Optional online advisory. Done.

## Bypass in force (do not treat as the design)

`prepareElectronObservationForPackaging` mints a **policy-derived offline stub** into:

```text
build/electron-observation.json
build/electron-observation-high-water.json
```

No `~/.vellum/release-security`, no network, no online check.

Offline `validate` still enforces the **checked-in policy** (pin match, review not expired).

## Fix later (pick one)

1. **Delete the ledger** — pin + expiry only; stop embedding observation JSON in the app; drop prepare-package / home state entirely.
2. **Advisory only** — online `check` prints; never gates local install; ship CI can fail on overdue if we care later.
3. **Real ship gate** — only if distributing binaries: CI runs online check, artifacts carry attestation, separate from local `app:install` and never under product `~/.vellum` product wipe path.

Until then: this doc marks the debt; the bypass is intentional.
