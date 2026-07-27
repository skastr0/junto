# macOS Remote station — end-to-end (terminals + browser plane)

Command Center (this Mac) deploys the **same** `Vellum Command.app` to a **macOS**
remote (e.g. Mac mini), starts it under LaunchAgent, and uses SSH unix-forwards
for capability sockets.

Linux is **out of scope** for this path (separate Electron/Linux station track).
Darwin managed deploy remains release-gated; this checklist qualifies the path
before that capability may be enabled.

## Prerequisites

1. **Command Center** is macOS, role `command-center`, with a local app bundle:
   - `/Applications/Vellum Command.app`, or
   - packaged self, or
   - `release/mac-arm64/Vellum Command.app`
2. **Remote** is macOS, SSH works (`ssh <endpoint>` BatchMode), user can write
   `/Applications` (or admin once), GUI session available for LaunchAgent/`open`.
3. Remote host registered in Settings → Hosts with capabilities including
   `terminal` (and later browser routing).

## Operator flow

1. Settings → Hosts → add remote (`id`, SSH endpoint).
2. Install/start the app on the Remote so its owner-local Station control
   socket is available.
3. **Configure as Remote** — Command Center invokes fixed `vellum-station`
   over SSH and completes `status → pair → configure`. No remote file is read
   or written.
4. **Deploy Remote** (only when the release capability is enabled) — stage the
   app bundle + LaunchAgent, start it, configure through Station API, and wait
   for:
   - `~/.vellum/term/control.sock`
   - `~/.vellum/browser/control.sock` (best-effort; term alone still succeeds)
   - the Station API status to report database/work/simulation readiness
5. Canvas → New terminal → **Host** = remote → Start → Open.
6. CC quit does **not** kill remote PTYs (local quit only). Explicit Kill does.

## Architecture

```text
CC TerminalRouter(hostId)
  → SSH forward remote ~/.vellum/term/control.sock
  → TermControlClient (NDJSON + token)

CC (future) browser host routing
  → SSH forward remote ~/.vellum/browser/control.sock
  → WebContentsView lives on Remote (needs BrowserWindow — deploy starts GUI app)

CC fleet coordination
  → SSH fixed command vellum-station
  → owner-local Station control socket
  → Remote main process
  → ~/.vellum/state/vellum.db
```

## Why not `--vellum-headless` on deploy

`WebContentsView` is parented under `BrowserWindow.contentView`. Headless skips
`createWindow()`, so host-local browser automation cannot attach. Deploy starts
the normal app so the browser plane can run. A future offscreen window can restore
true headless Remote.

## Smoke checklist

- [ ] `status → pair → configure` returns the expected installation identity
- [ ] Station status reports database/work/simulation ready
- [ ] Complete projection generation/hash persists across Remote restart
- [ ] `ssh remote 'test -S ~/.vellum/term/control.sock && echo ok'`
- [ ] Remote terminal create/type/resize from CC
- [ ] Quit CC → remote shell still running (ssh/process list)
- [ ] Reopen CC → reattach same binding
- [ ] Kill from card ends remote process
- [ ] Browser: open a page surface on Remote when host routing is wired
- [ ] No settings, host, status, projection, manifest, ACK, or seal file appears

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
| Fixed SSH client | `src/main/vellum/station/remote-client.ts` |
| Station control | `src/main/vellum/station/control-server.ts` |
| Term control UDS | `src/main/vellum/term/control-*.ts` |
| Router | `src/main/vellum/term/router.ts` |
| IPC | `hostsDeployRemote` in `src/shared/ipc.ts` |
| UI | Settings → Deploy Remote |
