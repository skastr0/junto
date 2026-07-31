# Ship gates — the line in the sand

Source: 8-angle Opus audit swarm + adversarial prune, 2026-07-31 (74 findings → 30 gates → the ~35 boxes below after dedup; four angles independently found the same Test-channel default and the same workers.dev feed, so corroboration is high). Receipts were verified against the worktree at audit time.

**The rule: when every box below is checked, you charge. Nothing is added to this list.** Anything that surfaces while working it goes to the "Below the line" section, not into a phase.

## Two clocks

- **2026-08-06** — the Electron freshness review pin expires (6 days).
- **2026-08-18** — every beta binary in the wild self-bricks (Dodo Test fuse, `src/main/vellum/license/config.ts:14-16`). The production build and the beta-transition decision must land before this.

## Phase 0 — Freeze (5 minutes)

- [ ] **Name the feature-freeze commit.** New features and a v6 schema migration landed the day of the audit — the freeze is the zero-engineering move that keeps this list from regrowing. From that commit forward: only work on this file's boxes.

## Phase 1 — Cut (subtraction; shrinks every phase after it)

- [ ] Turn Remote/fleet deploy **off** for v1 and label the Fleet surface beta (`release-capabilities.ts` all-true today; its own docs say no two-host run was ever qualified). This removes the sudo-password-to-a-second-machine path — the largest blast radius in the product.
- [ ] Hide the Linux Remote deploy affordance (its stable channel 404s) and defer the whole Linux lane from the v1 paid line.
- [ ] Hide the herdr surface (add-item palette entry + help hotkeys) — dead without a third-party binary, same treatment ACP chat already got (`src/shared/legacy-surfaces.ts:8`).
- [ ] Cut the Box cloud-VM button from the Fleet header.
- [ ] Cut the Tailscale Serve catalog from Settings → Hosts.
- [ ] Cut the usage rail (codexbar-only; invisible for every customer).
- [ ] Cut the ocap-doctrine primer paragraphs from the in-app help panel.
- [ ] Delete dead Settings rows: the inert "Show minimap" toggle, dev-only rows, the dead `commandCenterTransfer` flag.
- [ ] Drop the open-source-repo posture: delete or reframe SECURITY.md / CONTRIBUTING.md / README + package.json repo links for a closed-source product (keep a real security contact).

## Phase 2 — Code (the only real engineering on the list)

- [ ] **Fix the schema-identity gate.** Database recognition hashes the raw TypeScript schema source text; a comment edit permanently rejects every installed customer's healthy database — reproduced on your own live `~/.vellum/state/vellum.db` (user_version 4 fails the byte-hash check).
- [ ] **Show a dialog when the database cannot open.** Today: `console.error` + `exitAfterDetach(1)` (`src/main/index.ts:1728-1730`) — customer sees a bouncing icon and a vanished app. Dialog names the problem and points at the restore doc.
- [ ] **Get `bun run test` green** (3 files red at audit; one failure is the schema-identity defect above; the suite also opens the live DB via the hard-bound path — fix that binding as part of this).
- [ ] **Schedule the verified backup that already exists.** `VACUUM INTO` + witness verification runs only on schema advance today → most installs hold zero backups. Run it periodically; write the manual restore procedure the error dialog points at.
- [ ] **Legible missing-harness failure.** Spawn failure must read "Claude Code is not installed on this machine", not a node that says stopped. Cheapest scope only — no per-station detection matrix.
- [ ] **Render the capability badges.** Codex/Hermes lose their session on app restart with no warning; the badge data already exists in the model, it just isn't drawn.
- [ ] **EULA / Terms / Privacy reachable in the install→activate flow**, and fix the LICENSE sentence claiming the EULA ships with the app (it verifiably doesn't — `build.files` ships only `out/`, `station/`, `package.json`).
- [ ] **One first-run card naming the three moves** (add an agent → draw an edge → play). One card or one docs link. Explicitly not a tour.

## Phase 3 — Release lane

- [ ] **Production as the default and enforced channel.** `scripts/build-app.sh:87` defaults to `beta` (Dodo Test + 08-18 fuse); `publish-mac-release.ts` has zero channel awareness. `app:build:ship` defaults to production; publish hard-fails unless the packed binary audits as channel `production` / env `live`.
- [ ] **CNAME `releases.vellumcommand.com` to the update feed and compile that URL in.** The feed hostname is a disposable workers.dev deploy hash, baked into every binary — a one-way door; four auditors flagged it independently. (The domain currently points at Vercel.)
- [ ] Refresh the Electron freshness pin (expires **2026-08-06** — one command before cutting the build).
- [ ] **Sign, notarize, and staple the DMG itself**, then prove a quarantined install on a clean Mac. Current served DMG: `codesign` → "not signed at all", `spctl` → rejected. The worktree also holds an "Accepted" receipt beside un-notarized bytes — the publish gate must catch exactly this drift.
- [ ] Point the download page at the current release (serves 0.1.0; feed is at 0.1.5).
- [ ] **Prove auto-update once, from a real previous version, against the real feed.** It's the only route post-launch fixes reach customers.

## Phase 4 — Commerce & legal (no code)

- [ ] **Record a receipt of the Dodo Live product's license-key config**: keys enabled, activation limit set, expiry tied to the subscription, Live business/product IDs stored where the production build reads them. (No Live IDs exist anywhere in the repo today.)
- [ ] **Set the activation limit to match the terms** (terms promise 3 machines; product enforces 1; a wiped `~/.vellum` consumes a slot forever). Limit of 3 + a support step to release a dead machine's slot.
- [ ] **Reconcile the published Terms with reality**: seats, and the "every subscription starts with a 14-day trial" line (trial is only real "where configured in Dodo" — make the copy match what Dodo actually grants).
- [ ] **Open the purchase path**: price + Dodo checkout live at vellumcommand.com (all pricing routes 404 today; homepage still says private beta), and the in-app "Start the 14-day trial" link (`LicenseGate.tsx:429`) lands on it.
- [ ] Send one test email to support@ and confirm it arrives; publish the response promise. It's the published channel for refunds and data-rights requests.
- [ ] Write the **"I paid and no key arrived" runbook** (4 steps: look up key in Dodo dashboard, resend, release an activation instance, what to say).
- [ ] **Decide the beta-install transition** before publishing production: 0.1.0/0.1.5 Test-fused installs will auto-update into a Live binary and silently deny. Either invalidate cleanly with "beta ended, here's where to buy" copy, or break their update chain on purpose and email them.
- [ ] Exercise (or lower) the **minimum-macOS claim** — site says macOS 13+; nothing has ever launched below your machine's version.

## Phase 5 — Proof (one afternoon; this IS the line)

- [ ] **Clean Mac, full loop.** A Mac that isn't your dev machine (no Xcode CLT, no harness CLIs, fresh PATH): download → Gatekeeper-clean install → activate → add an agent → watch it run a command → task appears on the board. This one pass independently settles the missing-harness copy, the peer-PID/python3 helper fragility, and first-run guidance.
- [ ] **Buy your own product with a real card** on the Live Dodo product: key arrives by email → survives copy-paste into the activation field → activates against live.dodopayments.com → seat limit behaves as the terms say → customer-portal link resolves. **Then refund it** and watch what the app does when the refund lands.
- [ ] **Confirm a refunded/cancelled customer can still read and export** their canvases and work history (denied/maintenance custody states). If not, make it so and say so in the terms — otherwise the 30-day guarantee manufactures chargebacks and LGPD/GDPR complaints.

---

## The line

When Phase 5 passes, you announce and you charge. Every future "shouldn't we also…" goes below this line, after revenue.

## Below the line (deliberately post-launch)

Crash reporter / telemetry / log file (founder blindness, not customer harm — the startup dialog covers the one fatal case); terminal-reattach 50k-line serialize (measure before capping — never measured); bounding the provider-outage grace (customer must actively cheat to exploit); keychain storage for the license key; notarization-receipt automation (the clean-Mac test catches the drift for free); per-station harness detection + picker filtering; SQLite growth compaction (~1GB/yr at observed rates); onboarding beyond the one card; maintenance-mode station teardown polish; perf budgets in CI. Full audit detail: workflow run `wf_58323cee-6b1`.
