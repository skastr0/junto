# macOS privacy and filesystem access

Last audited: 2026-09-16.

Junto is a developer workstation, not a file indexer. It does not
scan the whole home folder, Photos library, Music library, Downloads,
Documents, Desktop, mounted volumes, contacts, calendars, camera, microphone,
or screen. Sensitive content access outside app-owned state must follow an
operator action or persisted opt-in and stay within the surface needed for
that action. Narrow startup metadata/network exceptions are listed below.

## macOS permission posture

- The signed app uses Hardened Runtime. That protects code execution; it is
  not macOS App Sandbox and does not grant privacy access.
- The Electron signing profile contains `com.apple.security.cs.allow-jit`,
  required by Electron's JavaScript engine, and
  `com.apple.security.device.audio-input` for Live conversations. The custom
  signer assigns this profile only to its existing Electron roles. The CLI
  and native libraries keep the empty profile and inherited plist.
- The package declares only `NSMicrophoneUsageDescription`. Electron's
  template Info.plist also carries camera, Bluetooth, and audio-capture
  purpose strings; the afterPack hook strips them before signing
  (`scripts/mac-info-plist-policy.mjs`), and the packaged-app audit refuses
  a bundle that still declares one. Live conversations
  are behind `JUNTO_LIVE_OVERSEER`, off in the shipping profile.
  Microphone access begins only when the operator starts a call in an enabled
  build, and its tracks stop when the call ends. The runtime has no camera,
  screen capture, location, contacts, calendar,
  reminders, Photos, media-library, Bluetooth, Accessibility, Input
  Monitoring, Apple Events, or Full Disk Access request API.
- App Transport Security keeps electron-builder's loopback updater
  exception: `NSAllowsLocalNetworking`, `localhost` and `127.0.0.1`
  exceptions, and `NSAllowsArbitraryLoads`. ATS governs only Foundation
  networking, not Chromium or Node traffic. Junto's only Foundation client
  is Squirrel.Mac, which installs an update by fetching it from
  electron-updater's `http://127.0.0.1` proxy. The audit pins this exact
  dictionary so it cannot widen.
- The trusted renderer may write the clipboard and, in Live-enabled builds,
  request audio-only microphone access. Third-party browser
  pages are denied media, display capture, devices, downloads, filesystem
  access, popups, and every ambient Chromium permission.

Junto is not App Sandboxed because its core product includes local
terminals and operator-selected agent CLIs. Those children intentionally run
with the signed-in user's normal authority. Treat opening a terminal or agent
as the same trust decision as opening Terminal.app in that directory.

**TCC attribution.** macOS bills every descendant's file access to Junto's
responsible-process identity: a permission dialog that names Junto may be
raised by an agent's own tooling — Grok's vendored `rg`, a harness's `find`,
a computer-use client's Apple Events — not by Junto code. This is observable
in the TCC log as `accessing=<child binary>` with `responsible=com.skastr0.junto`.
The seat inherits Junto's granted folders until the seat's own process tree
ends; Junto cannot disclaim responsibility from pure Node/Electron, so the
only mitigations are scoping which seats run and saying so. The first-run introduction tells the operator, before
any agent starts, that agents run with their permissions, that macOS may name
Junto when one reads a protected place, and that each prompt can be allowed
or denied.

**Launch.** A canvas never played starts paused, and no agent seat on it wakes
until the operator presses play. A canvas the operator has played comes back
playing at every Command Center launch; its seats start when work arrives for
them (mail, a connection change, a task), so a seat with waiting mail can
start right after launch. A shell terminal starts only when the operator opens
one. `tests/launch-permission-surface.test.ts` holds both.

## Access inventory

| Surface | Trigger | Filesystem or system scope | Retention and limits |
|---|---|---|---|
| Product state | App start | `~/.junto` only | Durable app state, content, sockets, and logs |
| Live conversation | Starting a call in a Live-enabled build | Microphone audio sent to OpenAI; selected canvas context and transcript sent to the controller | Audio is not recorded locally; transcript, requests, and operation receipts remain in product state; microphone tracks stop on call end |
| Spawn PATH | App start | Inherited `PATH`, optional operator tool directories, enumerated version-manager install roots (`~/.nvm`, `~/.local/share/mise`, `~/.asdf`, `~/.local/share/fnm`, `~/.volta`, `~/.pyenv`, `~/.rbenv` `bin` dirs), and fixed executable directories such as `~/.local/bin` and `~/.bun/bin` | Shell startup files are never executed: rc files are arbitrary operator code and every path they touch is billed to Junto's TCC identity. The directory reads are dotdir listings under the operator home, never protected folders |
| Supervisor status | Packaged app start | Current-user launchd job metadata | No content-library access and no permission prompt |
| Provider usage | Per-provider toggle in Settings | Only the enabled provider's disclosed credentials, cache, session data, process data, and network endpoints | All sources default off; usage sources refresh every five minutes; Hermes host snapshots poll every minute when separately enabled; revocation clears the row immediately and stops future polls |
| Working-directory browser | Opening an agent, Git, or region folder picker | One shallow page at a time, beginning at the shown path; hidden folders are suppressed until typed | No recursive walk, watcher, Spotlight query, glob, or background index |
| Git surface | Creating/opening a Git node for an operator-chosen directory | Repository and Git metadata through read-only status/log/show commands | No untracked-file content scan in status; runs only for the authored Git surface |
| Terminal or attached agent | Explicitly creating or activating the seat, or, once the operator presses play, waking a seat whose work is waiting | The selected cwd and whatever the launched shell/CLI accesses | Broad by design; ends with the owned process unless a separately disclosed supervised service is installed. A managed agent seat must name a working directory and is refused when it resolves to the operator home |
| Browser page | Explicitly opening a page node | Junto-owned persistent browser profile and public network destinations; managed-page downloads are denied outright, and the app's own session download path is pinned under app state so it never resolves `~/Downloads` | Site cookies/storage persist until the operator wipes that profile; hostile web permissions are denied |
| SSH/Remote | Explicit enrollment, then reconnect/sync while Command Center runs | OpenSSH configuration/credentials plus app paths on that enrolled Remote | No tailnet-wide file walk; managed package installs default off and stay in disclosed Junto app/service paths |
| Backup export | Export action and native save dialog | One operator-selected destination | Creates a verified copy and never overwrites an existing file |
| Login item | Settings checkbox | macOS Login Items state | Off until explicitly enabled; no hidden launch |
| Updates | Automatic release check after startup; download/install actions remain explicit | Release feed plus staging in temporary/app install paths | No home-content access; launchd shutdown avoids Apple Events and Automation prompts |

The working-directory browser can navigate to protected folders only when the
operator types or opens those locations. Merely launching Junto does
not enumerate the home directory. The old general-purpose renderer IPC that
could enumerate any path was removed; only the explicit terminal/Git/region
picker remains.

Opening the agent picker checks only executable names on the inherited `PATH`,
optional operator-configured tool directories, enumerated version-manager
install roots, and a short list of known paths such as `~/.local/bin` and
`~/.kimi-code/bin`; it does not list those directories. Candidates inside a
version-manager `shims` directory must additionally answer a bounded
`--version` probe, so a dead shim cannot shadow a real binary; that probe runs
the shim itself, briefly, under Junto's identity. Detection and launch share
that resolution, so the probe also runs whenever a seat launches; it never
runs as a background scan.
Opening one harness's options may read that harness's one model cache or run
its model-list command, and that happens only in the open agent picker.

## Provider access disclosures

Provider usage is the only background feature that reads state owned by other
developer tools. Every source is independently disabled by default. Its
Settings card names the access before opt-in:

- Claude: `~/.claude` and `~/.claude.json`, macOS Keychain, Anthropic network.
- Codex: `~/.codex/auth.json`, OpenAI network.
- Copilot: configured token or GitHub CLI config/token (`~/.config/gh`),
  GitHub network.
- Cursor: configured cookie or Cursor's local app database
  (`~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`),
  Cursor network.
- Devin: configured token or Chrome profile local storage
  (`~/Library/Application Support/Google/Chrome/*/Local Storage/leveldb`,
  scanned recursively), Devin network.
- Grok: `~/.grok` credentials and recent session history, xAI network.
- Hermes usage: `~/.hermes/profiles` and local profile state databases, read
  through the `sqlite3` CLI. Does not run `hermes` CLI commands or reach
  enrolled hosts. Refreshes every five minutes.
- Hermes host snapshots (separate toggle, Hermes-integration builds only):
  local and enrolled-host SSH `hermes profile list` and `hermes version`, plus
  remote profile metadata. Polls every one minute.
- Kimi: configured or `~/.kimi-code` credentials, Kimi network.
- Ollama Cloud: configured/environment credentials, Ollama network.
- OpenCode Go: credentials and local usage database read through the
  `sqlite3` CLI, OpenCode network.
- OpenRouter: configured/environment/key-file credentials, OpenRouter network.
- Antigravity: `~/.gemini` conversations plus `ps`/`lsof` process and port
  listings used to find its running local service.
- Synthetic: configured/environment credentials, Synthetic network.

Entering a credential does not silently enable its source. Revoking a source
removes its cached row from the live UI and stops future polling. Individual
provider checkboxes write one source against current durable settings, so a
stale concurrent disable cannot reconstruct revoked access.

Managed Remote package mutation (`remoteManagedInstalls`) is off until the
operator explicitly opts in. An upgraded install that still carries the old
default-on value is treated as off, not as consent.

## Gentle-request rules

1. Do not add a macOS usage-description key as a speculative precaution. Add
   one only with the user-facing feature that calls the matching API.
2. Ask at the point of use, after explaining the exact data and purpose. A
   startup prompt is a defect unless startup itself cannot function without
   the access.
3. Prefer app-owned state, explicit files/directories, shallow reads, and
   provider-specific opt-ins over discovery.
4. Do not infer consent from an installed CLI, credential file, browser
   profile, environment variable, or cached login.
5. A terminal/agent is the sole intentionally broad local authority. Do not
   reuse that authority for background product features.
6. Update this inventory and `tests/macos-privacy-policy.test.ts` whenever a
   new entitlement, usage description, permission API, external data root, or
   background probe is introduced.
