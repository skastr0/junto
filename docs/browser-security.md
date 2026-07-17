# Browser security contract

Contract status: **FROZEN**
Contract version: **1.0.0**
Credential decision: **BLOCKED**

Implementation baseline: **BR-016 through BR-019 landed**. This records the
source-level hardening now present; it does not promote any canonical credential
evidence or authorize a non-synthetic account.

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

## Landed hardening baseline

BR-016 through BR-019 close the earlier source-level gaps around local transport,
hostile WebContents, public-target policy, and finite execution. These controls
are implemented and regression-tested, but they are not by themselves approval
evidence for valuable credentials:

- The agent control plane is an HTTP server bound only to an owner-only Unix
  domain socket under `~/.vellum/browser`; its directory is mode `0700`, its
  socket and bearer file are mode `0600`, authentication precedes body parsing,
  and startup fails closed if socket permissions cannot be established. Vellum
  exposes no browser-control listener over TCP or Chrome DevTools Protocol.
  There is no remote-debugging or DevTools control endpoint.
  (`src/main/vellum/browser/control.ts`, `src/shared/browser-control.ts`)
- An open request carries only a canonical `vellum://` page locator. URL, profile,
  and node identity are re-read from the uniquely resolved canvas node; existing
  operations require the current opaque session generation, and cross-document
  navigation rotates that generation. (`src/main/vellum/browser/page-target.ts`,
  `src/main/vellum/browser/sessions.ts`)
- Browser WebContents are sandboxed, context-isolated, have no preload or Node
  integration, and install deny-first frame, redirect, popup, permission, device,
  display-media, download, filesystem-access, webview, and unload policy before
  the first load. (`src/main/vellum/browser/view-adapter.ts`,
  `src/main/vellum/browser/web-policy.ts`)
- Top-level and subresource policy rejects credentials-in-URL, ambiguous or local
  hostnames, non-public IP literals, privileged schemes, and DNS names whose
  current resolved endpoint set is empty, invalid, mixed, or non-public. DNS work
  is deadline- and concurrency-bounded and fails closed.
  (`src/shared/browser-policy.ts`, `src/main/vellum/browser/web-policy.ts`)
- Agent evaluation runs without a synthetic user gesture in a dedicated isolated
  world rather than the page main world. Source bytes and serialized result
  bytes/depth/nodes are bounded; only finite plain JSON crosses the Electron
  boundary, and the main process independently validates the typed result
  envelope. Cancellation or deadline expiry destroys and unregisters the affected
  WebContents session, invalidating its handle. (`src/main/vellum/browser/view-adapter.ts`,
  `src/main/vellum/browser/sessions.ts`)
- Control headers, bodies, handler count, handler time, field sizes, list scans,
  responses, errors, screenshots, and surface geometry have hard ceilings.
  Screenshots have server-owned random destinations beneath an owner-only real
  directory, use exclusive mode-`0600` creation, reject caller paths, and remove
  artifacts if cancellation or generation invalidation wins the race.
  (`src/shared/browser-limits.ts`, `src/shared/browser-control.ts`,
  `src/main/vellum/browser/control.ts`)

### Runtime policy lifetime and login posture

Partition-level policy is installed once per Electron `Session` and intentionally
remains installed for the entire app run. Releasing or destroying the last view
does not remove the partition request, permission, or download handlers: a
service worker can outlive every view and must remain under the same policy.
Only WebContents-local listeners are removed after that WebContents is destroyed.
(`src/main/vellum/browser/web-policy.ts`)

All popup creation is denied and any unexpected child window is destroyed. There
is no Gmail, GitHub, OAuth, or other provider exception. A same-tab redirect flow
may work when every target passes the public-web policy; a popup-only login flow
is unsupported. Any future popup/OAuth broker is a new privileged boundary and
must be explicitly designed, scoped, tested, and reviewed before this deny
posture changes.

“No DevTools control endpoint” means Vellum does not start a remote-debugging
port, expose CDP as browser authority, or bind its browser-control server to TCP.
It is not a claim that Chromium developer tooling has been compiled out of the
application.

## Remaining credential blockers

The credential decision remains blocked on these unresolved boundaries:

- **Scoped, expiring, revocable authority.** The current owner-only socket plus
  persistent bearer authenticates a local caller to the whole control surface;
  it is not a job capability. Authority still needs issuance and use-time checks
  binding a principal and job to an allowed action set, canvas/page target,
  profile, current session generation and origin, with short expiry, explicit
  revocation generation, replay resistance, and attributable audit records.
- **Absolute DNS/socket binding.** The request policy rejects non-public literals
  and preflights DNS names through Electron `resolveHost`, but that approved
  endpoint set is not absolutely bound to the network socket Chromium ultimately
  opens. DNS rebinding, resolver/cache changes, proxy routing, and the gap between
  lookup and connect require either enforceable socket-level public-endpoint
  binding or an equivalently strong packaged network boundary, plus adversarial
  proof. Until then, public-target filtering is a strong fail-closed preflight,
  not a complete private-network isolation claim.
- **Packaged profile storage and release integrity.** Persistent Chromium
  partitions deliberately outlive views and app restarts. The registry's current
  profile wipe removes its Vellum profile record directory; it is not yet proven
  to erase the packaged Electron partition, service-worker state, caches, cookies,
  credentials, or crash remnants. Packaged paths, OS at-rest protection, logout,
  revoke and wipe across restart/crash must be qualified together with Electron
  fuses, code signing/notarization, updater signature and rollback posture, and
  security patch cadence.
- **Adversarial reviews and canary.** The packaged artifact still needs the full
  synthetic hostile-page/network/artifact suite, independent security review,
  independent verification review, and durable reopenable receipts. Only after
  those pass may an explicitly isolated low-value canary be considered; a canary
  must pass before any primary Gmail, GitHub, or other valuable account is
  admitted.

The canonical evidence entries below remain `unverified` until those qualification
receipts exist. Landed source and local regression tests do not silently promote
the credential gate.

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
