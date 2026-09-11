# macOS privacy and filesystem access

Last audited: 2026-09-11.

Vellum Command is a developer workstation, not a file indexer. It does not
scan the whole home folder, Photos library, Music library, Downloads,
Documents, Desktop, mounted volumes, contacts, calendars, camera, microphone,
or screen. Sensitive content access outside app-owned state must follow an
operator action or persisted opt-in and stay within the surface needed for
that action. Narrow startup metadata/network exceptions are listed below.

## macOS permission posture

- The signed app uses Hardened Runtime. That protects code execution; it is
  not macOS App Sandbox and does not grant privacy access.
- The app entitlement file contains only
  `com.apple.security.cs.allow-jit`, required by Electron's JavaScript engine.
  Inherited helper entitlements are empty.
- The package has no macOS privacy usage-description keys and the runtime has
  no camera, microphone, screen capture, location, contacts, calendar,
  reminders, Photos, media-library, Bluetooth, Accessibility, Input
  Monitoring, Apple Events, or Full Disk Access request API.
- The trusted renderer may write the clipboard only. Third-party browser
  pages are denied media, display capture, devices, downloads, filesystem
  access, popups, and every ambient Chromium permission.

Vellum Command is not App Sandboxed because its core product includes local
terminals and operator-selected agent CLIs. Those children intentionally run
with the signed-in user's normal authority. Treat opening a terminal or agent
as the same trust decision as opening Terminal.app in that directory.

## Access inventory

| Surface | Trigger | Filesystem or system scope | Retention and limits |
|---|---|---|---|
| Product state | App start | `~/.vellum-command` only | Durable app state, content, sockets, and logs |
| Spawn PATH | App start | Inherited `PATH` plus fixed executable directories such as `~/.local/bin` | No login shell and no shell startup files are executed |
| Supervisor status | Packaged app start | Current-user launchd job metadata | No content-library access and no permission prompt |
| Provider usage | Per-provider toggle in Settings | Only the enabled provider's disclosed credentials, cache, session data, process data, and network endpoints | All sources default off; enabled sources refresh every five minutes; revocation clears the row immediately and stops future polls |
| Working-directory browser | Opening an agent, Git, or region folder picker | One shallow page at a time, beginning at the shown path; hidden folders are suppressed until typed | No recursive walk, watcher, Spotlight query, glob, or background index |
| Git surface | Creating/opening a Git node for an operator-chosen directory | Repository and Git metadata through read-only status/log/show commands | No untracked-file content scan in status; runs only for the authored Git surface |
| Terminal or attached agent | Explicitly creating or activating the seat | The selected cwd and whatever the launched shell/CLI accesses | Broad by design; ends with the owned process unless a separately disclosed supervised service is installed |
| Browser page | Explicitly opening a page node | Vellum Command-owned persistent browser profile and public network destinations | Site cookies/storage persist until the operator wipes that profile; hostile web permissions are denied |
| SSH/Remote | Explicit enrollment, then reconnect/sync while Command Center runs | OpenSSH configuration/credentials plus app paths on that enrolled Remote | No tailnet-wide file walk; managed package installs default off and stay in disclosed Vellum Command app/service paths |
| Backup export | Export action and native save dialog | One operator-selected destination | Creates a verified copy and never overwrites an existing file |
| Login item | Settings checkbox | macOS Login Items state | Off until explicitly enabled; no hidden launch |
| Updates | Automatic release check after startup; download/install actions remain explicit | Release feed plus staging in temporary/app install paths | No home-content access; launchd shutdown avoids Apple Events and Automation prompts |

The working-directory browser can navigate to protected folders only when the
operator types or opens those locations. Merely launching Vellum Command does
not enumerate the home directory. The old general-purpose renderer IPC that
could enumerate any path was removed; only the explicit terminal/Git/region
picker remains.

Opening the agent picker checks only executable names on the inherited `PATH`
and a short list of known paths such as `~/.local/bin`; it does not list those
directories. Opening one harness's options may read that harness's one model
cache or run its model-list command. This happens only in the open agent picker,
not at app startup or in the background.

## Provider access disclosures

Provider usage is the only background feature that reads state owned by other
developer tools. Every source is independently disabled by default. Its
Settings card names the access before opt-in:

- Claude: `~/.claude`, macOS Keychain, Anthropic network.
- Codex: `~/.codex/auth.json`, OpenAI network.
- Copilot: configured token or GitHub CLI config/token, GitHub network.
- Cursor: configured cookie or Cursor's local app database, Cursor network.
- Devin: configured token or Chrome profile local storage, Devin network.
- Grok: `~/.grok` credentials and recent session history, xAI network.
- Hermes: `~/.hermes/profiles` and profile state databases.
- Kimi: configured or `~/.kimi-code` credentials, Kimi network.
- Ollama Cloud: configured/environment credentials, Ollama network.
- OpenCode Go: credentials and local usage database, OpenCode network.
- OpenRouter: configured/environment/key-file credentials, OpenRouter network.
- Antigravity: `~/.gemini` conversations plus process command lines and local
  ports used to find its running local service.
- Synthetic: configured/environment credentials, Synthetic network.

Entering a credential does not silently enable its source. Revoking a source
removes its cached row from the live UI and stops future polling.

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
