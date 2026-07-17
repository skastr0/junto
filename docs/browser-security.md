# Browser security contract

Contract status: **FROZEN**
Contract version: **1.0.0**
Credential decision: **BLOCKED**

This contract is the repository authorization boundary for Vellum browser
credentials. Until its canonical gate is approved, development and verification
use synthetic accounts only. Primary Gmail and GitHub credentials must not be
entered into Vellum.

This is not yet a runtime interception guarantee. The current app does not
prevent a human from typing a credential into a page. Runtime controls are part
of the hardening program; this contract prevents agents, CI, release work, and
security claims from treating an unqualified build as approved.

## Security objective

Vellum must provide a trustworthy local environment for persistent authenticated
browser profiles and powerful local automation without giving hostile web
content, an unrelated agent, a network peer, or an unapproved local caller access
to another profile, session, Vellum canvas, operating-system capability, or fleet
machine.

Account classes:

- **Synthetic** — purpose-built test identities with no valuable data. Permitted.
- **Isolated canary** — a low-value real account used only after its explicit
  qualification gate. Currently blocked.
- **Primary** — Gmail, GitHub, and other valuable day-to-day identities. Currently
  blocked.

The eventual security claim is deliberately narrower than Chrome parity: a
signed Vellum build may be approved for configured accounts and scoped local
automation only after every gate below is verified. Arbitrary hostile processes
already running as the same macOS user remain outside the app-level threat
boundary, as they are for other same-user desktop browsers.

## Protected assets

- Passwords, passkeys, recovery factors, cookies, session tokens, local storage,
  session storage, and authenticated application data.
- Persistent Chromium profile partitions and their encryption, lifecycle, and
  deletion guarantees.
- Screenshots, downloads, uploads, evaluated code, evaluated results, and other
  browser automation artifacts.
- The Vellum canvas, renderer, main-process IPC, local files, subprocesses, and
  operating-system permissions.
- Browser-control credentials, job capabilities, audit data, and agent identity.
- Actions performed in authenticated applications and authority reachable across
  the local agent fleet.

## Threat actors and trust boundaries

The design treats these inputs as hostile or fallible:

- Arbitrary pages, frames, redirects, popups, downloads, and permission requests.
- A compromised or prompt-injected local automation agent.
- A stolen, replayed, over-broad, expired, or misattributed control credential.
- Malformed or malicious custom-protocol input.
- Accidental operator action and stale UI state.
- A network peer whenever a TCP listener exists.
- A different process running as the same macOS user. App controls must minimize
  ambient authority, but cannot defend secrets from a fully hostile same-user host
  process.

Security boundaries exist between the public web page and its sandboxed
WebContents, between WebContents and the trusted Vellum renderer, between the
renderer and main process, between browser profiles, between local control
callers and sessions, between agents, and between Vellum-owned storage and the
rest of the filesystem.

## Current blockers

The current source must not be interpreted as qualified for primary credentials:

- `src/main/vellum/browser/control.ts` uses a persistent bearer for the complete
  control surface and does not bind authority to a principal, job, target,
  action, origin, profile, expiry, or revocation generation.
- `src/shared/browser-control.ts` accepts unbounded strings for powerful requests,
  including raw evaluation and screenshot destinations.
- `src/shared/browser.ts` permits every syntactically valid HTTP(S) target,
  including private and loopback destinations.
- `src/main/vellum/browser/view-adapter.ts` creates sandboxed WebContents but does
  not yet install the complete navigation, popup, permission, download, external
  protocol, and private-network policy.
- `src/main/vellum/browser/sessions.ts` can stop waiting for an evaluation timeout
  without terminating the page script, and its session admission is not yet a
  fully atomic capability-bound operation.
- Persistent browser partitions intentionally retain authentication state, while
  packaged at-rest storage, wipe verification, Electron fuse posture, signing,
  update integrity, and adversarial qualification remain unverified.

## Required invariants

Approval requires all of these properties to be backed by reopenable evidence:

1. Browser automation is local Unix-domain-socket only; no Vellum TCP or MCP
   browser authority exists.
2. Every powerful operation is identity-bound, target-bound, action-scoped,
   expiring, revocable, attributable, and rechecked at use time.
3. Profile, session, origin, node, and job ownership cannot collide or be
   substituted across canvases or agents.
4. Navigation, redirects, popups, permissions, private-network access, downloads,
   uploads, external protocols, fullscreen, and untrusted IPC deny by default.
5. Session admission, concurrency, cancellation, shutdown, request bodies,
   results, files, screenshots, and artifact storage are bounded and fail closed.
6. Trusted UI shows live verified origin and cannot be spoofed by page content.
7. Persistent profile storage, logout, revoke, wipe, crash recovery, signing,
   Electron fuses, updater integrity, and patch cadence are verified on the
   packaged app.
8. A synthetic adversarial suite and independent security and verification
   reviews pass with no unresolved credential-boundary finding.
9. An isolated low-value canary passes before any primary account is admitted.

## Canonical credential gate

The JSON object below is the single source of truth. Surrounding prose explains
the decision but does not independently authorize credentials.

<!-- vellum-browser-credential-gate:v1 -->
```json
{
  "schema": "vellum/browser-credential-gate/v1",
  "decision": "blocked",
  "allowed_account_classes": ["synthetic"],
  "primary_account_providers": ["gmail", "github"],
  "evidence": {
    "uds_only_transport": { "state": "unverified", "refs": [] },
    "scoped_revocable_authority": { "state": "unverified", "refs": [] },
    "webcontents_containment": { "state": "unverified", "refs": [] },
    "bounded_execution": { "state": "unverified", "refs": [] },
    "profile_storage": { "state": "unverified", "refs": [] },
    "packaged_runtime": { "state": "unverified", "refs": [] },
    "adversarial_suite": { "state": "unverified", "refs": [] },
    "independent_reviews": { "state": "unverified", "refs": [] },
    "isolated_canary": { "state": "unverified", "refs": [] }
  },
  "approval": null
}
```

Promotion to `approved` is valid only when `primary` appears in
`allowed_account_classes`, every required evidence item is `verified` with at
least one reopenable reference, and `approval` records the operator, independent
security review, independent verification review, and approval timestamp.

The operator and both independent reviewers are required approval authorities.
The contract, evidence references, review receipts, and deterministic tests must
change together. Missing evidence or an ambiguous state always resolves to
blocked.
