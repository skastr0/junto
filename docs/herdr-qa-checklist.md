# Herdr work-surface — manual TUI QA checklist (HN-011)

Automated gates: `bun run typecheck` · `bun run test` (no live ssh required).

## Product locks (do not regress)

- Work surface, not hermes — no ACP, no pulse target, no EntitySource herdr
- One interactive modal; takeover OK
- Detach default on card delete; kill pane/tab explicit
- **Quit / relaunch / launchd unload detaches control only — never mass-kills herdr panes/sessions**
- Kitty graphics out of scope (ANSI re-blit only)

### Quit / reinstall smoke

1. Attach a live agent pane in Vellum; leave it working in herdr
2. Quit Vellum (Cmd-Q) or `bun run app:install:fast`
3. `herdr pane list` still shows the pane; agent still running
4. Re-open Vellum and re-attach — same pane, work preserved

## Manual local

1. Add → herdr → host **local** → default session → pick space/tab/pane with a coding agent TUI
2. Open modal — type, Enter, resize window — TUI responds (acceptable SSH-like jank)
3. Close modal — pane still running in native herdr (`herdr pane list`)
4. Kill pane from card — pane gone from herdr list; card detaches
5. Re-attach; delete card (default detach) — pane still in herdr
6. Stream drop / reconnect UI: close stream mid-modal → degraded → reconnect or failed actions
7. Create path: wizard “+ create” workspace with cwd, or create tab/pane — ids from herdr JSON only

## remote-a (when reachable)

1. Host **remote-a** → ensure server / list hierarchy
2. Attach existing or create; modal over ssh BatchMode

## Known fidelity limits

- No Kitty graphics protocol
- Cell-grid ANSI re-blit; multi-pane herdr chrome out of scope
- One global control stream (opening another takes over)

Record results in tower work submit notes when marking HN-011 done.
