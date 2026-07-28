# macOS Remote station — end-to-end (terminals + host-local browser)

Command Center (this Mac) deploys the **same** `Vellum Command.app` to a **macOS**
remote (e.g. Mac mini), starts it under LaunchAgent, and uses SSH for the
Station API and for terminal capability sockets.

Linux is **out of scope** for this path (separate Electron/Linux station track).
Darwin managed deploy remains release-gated; this checklist qualifies the path
before that capability may be enabled.

Browser automation is host-local on the Remote. Command Center does not forward
or relay browser control sockets; a page on the Remote is driven only by actors
on that installation when the host declares the `"browser"` capability.

## Prerequisites

1. **Command Center** is macOS, role `command-center`, with a local app bundle:
   - `/Applications/Vellum Command.app`, or
   - packaged self, or
   - `release/mac-arm64/Vellum Command.app`
2. **Remote** is macOS, SSH works (`ssh <endpoint>` BatchMode), user can write
   `/Applications` (or admin once), GUI session available for LaunchAgent/`open`.
3. Remote host registered in Settings → Hosts with capabilities including
   `terminal` (and `browser` when that Remote should host pages locally).

## Operator flow

1. Settings → Hosts → add remote (`id`, SSH endpoint).
2. Install/start the app on the Remote so its owner-local Station control
   socket is available.
3. **Configure as Remote** — Command Center invokes fixed `vellum-station`
   over SSH and completes `status → pair → configure`. No remote file is read
   or written. The packaged helper carries the same strict Station session
   frames when invoked over SSH or directly by the operator account: its
   owner-local socket handoff is trusted containment, not proof of the
   original SSH peer. Remote main validates pairing, target, verb, transition,
   and work authority on every frame.
4. **Deploy Remote** (only when the release capability is enabled) — stage the
   app bundle + LaunchAgent, start it, configure through Station API, and wait
   for:
   - `~/.vellum/term/control.sock`
   - `~/.vellum/browser/control.sock` (best-effort host-local plane; term alone still succeeds)
   - the Station API status to report database/work/simulation readiness
5. Canvas → New terminal → **Host** = remote → Start → Open.
6. CC quit does **not** kill remote PTYs (local quit only). Explicit Kill does.

## Architecture

```text
CC TerminalRouter(hostId)
  → SSH forward remote ~/.vellum/term/control.sock
  → TermControlClient (NDJSON + token)

Remote host-local browser (same installation as page + actor)
  → ~/.vellum/browser/control.sock on the Remote only
  → WebContentsView on that Remote (needs BrowserWindow — deploy starts GUI app)

CC fleet coordination
  → SSH fixed command vellum-station
  → owner-local Station control socket
  → Remote main process
  → ~/.vellum/state/vellum.db
```

Station API verbs remain `pair`, `configure`, `project`, `report`, and
`status` only. Browser ops never use that wire.

## Why not `--vellum-headless` on deploy

`WebContentsView` is parented under `BrowserWindow.contentView`. Headless skips
`createWindow()`, so host-local browser automation cannot attach. Deploy starts
the normal app so the browser plane can run on that installation. A future
offscreen window can restore true headless Remote without inventing remote
browser RPC.

## Smoke checklist

- [ ] `status → pair → configure` returns the expected installation identity
- [ ] Station status reports database/work/simulation ready
- [ ] Complete projection generation/hash persists across Remote restart
- [ ] `ssh remote 'test -S ~/.vellum/term/control.sock && echo ok'`
- [ ] Remote terminal create/type/resize from CC
- [ ] Quit CC → remote shell still running (ssh/process list)
- [ ] Reopen CC → reattach same binding
- [ ] Kill from card ends remote process
- [ ] Host-local browser: open a page on the Remote when that host declares `browser`
- [ ] No settings, host, status, projection, manifest, ACK, or seal file appears
- [ ] No browserTrust / commandCenterRef / Station-browser protocol residue

## Failure modes

| Symptom | Likely cause |
|---------|----------------|
| no local Vellum Command.app | Install/package on CC first |
| remote not Darwin | Linux host — use Linux station track |
| SSH warm failed | VPN/Tailscale/keys/`~/.ssh/config` |
| TERM_SOCK_TIMEOUT | App didn’t start; check remote logs under `~/Library/Logs/Vellum Command/` |
| browser sock missing | App still starting; or composition failed — check remote main log |

## Code map

| Piece | Path |
|-------|------|
| Deploy | `src/main/vellum/hosts/deploy-remote.ts` |
| Pair/configure | `src/main/vellum/hosts/configure-remote.ts` |
| Station API | `src/main/vellum/station/api.ts` |
| Enrollment identity bootstrap | `src/main/vellum/station/openssh-bootstrap.ts` |
| Persistent OpenSSH peer exchange | `src/main/vellum/station/openssh-peer-exchange.ts` |
| Fleet session supervisor | `src/main/vellum/station/fleet-propagation.ts` |
| Station control | `src/main/vellum/station/control-server.ts` |
| Term control UDS | `src/main/vellum/term/control-*.ts` |
| Router | `src/main/vellum/term/router.ts` |
| IPC | `hostsDeployRemote` in `src/shared/ipc.ts` |
| UI | Settings → Deploy Remote |
