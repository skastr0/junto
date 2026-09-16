# macOS Remote station — end-to-end (terminals + host-local browser)

**Status:** required operator qualification; clean Mac mini available, no
recorded two-host pass for the next packaged build

Capture and interpret every run through
[Fleet observability and qualification](fleet-observability.md).

Command Center (this Mac) deploys the **same** `Junto.app` to a **macOS**
remote (e.g. Mac mini), starts it under LaunchAgent, and uses SSH for the
Station API and for terminal capability sockets.

Linux is **out of scope** for this path (separate Electron/Linux station track).
Darwin managed deploy is enabled in the ship release profile. This checklist
qualifies the exact packaged pair before release promotion.

Browser automation is host-local on the Remote. Command Center does not forward
or relay browser control sockets; a page on the Remote is driven only by actors
on that installation when the host declares the `"browser"` capability.
All actors and physical runtimes follow the same locality law. Stable projected
task/request/artifact sinks may be addressed across placement, but every
mutable row and event has one installation authority home.

## Prerequisites

1. **Command Center** is macOS, role `command-center`, with a local app bundle:
   - `/Applications/Junto.app`, or
   - packaged self, or
   - `release/mac-arm64/Junto.app`
2. **Remote** is macOS, SSH works (`ssh <endpoint>` BatchMode), user can write
   `/Applications` (or admin once), GUI session available for LaunchAgent/`open`.
3. Remote host registered in Settings → Hosts with capabilities including
   `terminal` (and `browser` when that Remote should host pages locally).

## Operator flow

1. Settings → Hosts → add remote (`id`, SSH endpoint).
2. Install/start the app on the Remote so its owner-local Station control
   socket is available.
3. **Configure as Remote** — Command Center invokes `vellum-command station-stdio`
   over SSH and completes `status → pair → configure`. No remote file is read
   or written. The packaged helper carries the same strict Station session
   frames when invoked over SSH or directly by the operator account: its
   owner-local socket handoff is trusted containment, not proof of the
   original SSH peer. Remote main validates pairing, target, verb, transition,
   and work authority on every frame.
   Command Center owns this connection and every reconnect. The Remote needs
   no callback route and never connects to another Remote.
4. **Deploy Remote** (only when the release capability is enabled) — stage the
   app bundle + LaunchAgent, start it, configure through Station API, and wait
   for:
   - `~/.vellum-command/term/control.sock`
   - `~/.vellum-command/browser/control.sock`
   - the Station API status to report database/work/simulation readiness
5. Canvas → New terminal → **Host** = remote → Start → Open.
6. CC quit does **not** kill remote PTYs (local quit only). Explicit Kill does.

## Architecture

```text
CC TerminalRouter(hostId)
  → SSH forward remote ~/.vellum-command/term/control.sock
  → TermControlClient (NDJSON + token)
  → operator terminal surface only; does not bind a CC actor to a Remote seat

Remote host-local browser (same installation as page + actor)
  → ~/.vellum-command/browser/control.sock on the Remote only
  → WebContentsView on that Remote (needs BrowserWindow — deploy starts GUI app)

CC fleet coordination
  → SSH fixed command vellum-command-station
  → owner-local Station control socket
  → Remote main process
  → ~/.vellum-command/state/vellum-command.db
```

Station API verbs remain `pair`, `configure`, `project`, `report`, and
`status` only. Browser ops and terminal control never use that wire. Tailscale
may make the enrolled SSH endpoint reachable, but is optional and supplies no
Station authority.

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
- [ ] A CC-home submitted task starts on one Remote actor only through a live
      synchronous claim exchange; it is immediately `working`, with no queued
      backlog
- [ ] With CC closed, that exact claimed task and Remote-home work continue
      from the Remote SQLite database; no new CC-home task is claimed
- [ ] Permitted Remote-home request/artifact creation persists offline and
      reconciles idempotently by logical cursor after CC returns
- [ ] `ssh remote 'test -S ~/.vellum-command/term/control.sock && echo ok'`
- [ ] Remote terminal create/type/resize from CC
- [ ] Quit CC → remote shell still running (ssh/process list)
- [ ] Reopen CC → reattach same binding
- [ ] Kill from card ends remote process
- [ ] Host-local browser: open a page on the Remote when that host declares `browser`
- [ ] No settings, host, status, projection, manifest, ACK, or seal file appears
- [ ] No browserTrust / commandCenterRef / Station-browser protocol residue
- [ ] Remote opens no callback connection to CC and no peer connection to
      another Remote

Passing source tests, package audit, or a single installed app is not this
proof. Record the two-installation result against the exact source commit and
packaged app digest before treating the path as qualified.

## Failure modes

| Symptom | Likely cause |
|---------|----------------|
| no local Junto.app | Install/package on CC first |
| remote not Darwin | Linux host — use Linux station track |
| SSH warm failed | ControlPath too long, host key, keys, or `~/.ssh/config` — read the OpenSSH detail on the deploy step |
| TERM_SOCK_TIMEOUT | App didn’t start; check remote logs under `~/Library/Logs/Junto/` |
| browser sock missing | Activation is incomplete; check the Remote error log and browser composition readiness |

## Code map

| Piece | Path |
|-------|------|
| Deploy | `src/main/vellum-command/hosts/deploy-remote.ts` |
| Pair/configure | `src/main/vellum-command/hosts/configure-remote.ts` |
| Station API | `src/main/vellum-command/station/api.ts` |
| Enrollment identity bootstrap | `src/main/vellum-command/station/openssh-bootstrap.ts` |
| Persistent OpenSSH peer exchange | `src/main/vellum-command/station/openssh-peer-exchange.ts` |
| Fleet session supervisor | `src/main/vellum-command/station/fleet-propagation.ts` |
| Station control | `src/main/vellum-command/station/control-server.ts` |
| Term control UDS | `src/main/vellum-command/term/control-*.ts` |
| Router | `src/main/vellum-command/term/router.ts` |
| IPC | `hostsDeployRemote` in `src/shared/ipc.ts` |
| UI | Settings → Deploy Remote |
