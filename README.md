<p align="center">
  <img src="assets/brand/vellum-command-icon.png" alt="Vellum Command" width="128" height="128" />
</p>

# Vellum Command

A desktop workspace for agents, terminals, browser pages, and shared work on a
spatial canvas. You draw the relationships; attached agents use the tools those
relationships allow.

Vellum Command is free, open-source software under [Apache-2.0](LICENSE). It is
actively developed by a solo maintainer. Reports and proposals go through
[issues](https://github.com/skastr0/vellum-command/issues); see
[CONTRIBUTING.md](CONTRIBUTING.md) and [SUPPORT.md](SUPPORT.md).

## Status and downloads

| Surface | Status |
| --- | --- |
| macOS desktop | Primary platform, macOS 13 or later, Apple silicon. Official builds are signed and notarized. |
| Linux desktop | Alpha, initially Ubuntu 24.04 x86-64 with glibc 2.39 and an X11 or Wayland desktop. Official archives use signed release metadata. |
| Fleet management and Remote stations | Experimental, disabled in the default build. |
| Windows | No supported build or release lane. |

The [official download page](https://vellumcommand.com/download) lists available
builds, signed Linux metadata, and corresponding source downloads. Official
automatic updates use the maintainer-run release feed. Updates download
in the background and offer an explicit restart when ready. The source repository
is not an npm package, and GitHub Releases are not the application update feed.
A separately attested Linux first-install bootstrap may be published on GitHub
Releases; it is not an update channel.

For Linux, follow [the desktop alpha installation guide](docs/linux-command-center-alpha.md)
and the [bootstrap guide](docs/linux-desktop-bootstrap.md). First install is
authenticated by an independently obtained bootstrap or a reviewed source
checkout, not by extracting the archive's bundled CLI. The managed installation
stays inside your account and maintains a launcher across updates. Its installer
and updater do not ask for administrator credentials; any required host
preparation is documented separately. An extracted source build can run without
becoming a managed installation.

The default `ship` feature profile is defined in
[feature-catalog.ts](src/shared/feature-catalog.ts). Browser pages are enabled;
Fleet, Remote management, Hermes integration, audio, and schedulers remain
experimental. Opening the source does not change those defaults.

## Build from source

Requirements:

- Bun 1.3.13, as recorded in `package.json`.
- Node.js 24.10 or later for the test and build tools, including `node:sqlite`.
- macOS or Linux. Linux needs an interactive X11 or Wayland session to run the GUI.
- Git and the platform's native build tools when a dependency needs compilation
  (Xcode Command Line Tools on macOS, a C/C++ toolchain and Python 3 on Linux).

```sh
git clone https://github.com/skastr0/vellum-command.git
cd vellum-command
bun install --frozen-lockfile
bun run dev
```

The development app uses `~/.vellum-command-dev/`. When compatible production
state exists, the development launcher can seed a separate development copy.
The packaged application uses `~/.vellum-command/`.

No payment account, activation key, private source checkout, or maintainer signing
credential is required. Install any external agent harness you want to use
separately; its authentication and provider costs are managed by that harness.

To compile and package locally:

```sh
bun run build              # package locally, skipping source checks
bun run app:build:mac      # local macOS package, run on macOS
bun run app:build:linux    # local Linux desktop package, run on Linux
```

Local packages are development builds. Official signing and publication are
separate maintainer operations described in
the maintainer's private distribution repository, which holds the signing,
notarization and publication tooling. This repository builds, and it can also
publish the independently attested Linux first-install bootstrap on GitHub
Releases. That bootstrap is not the application update feed.
macOS source packages start without a signing identity. Automatic updates and
Remote package admission require the expected official signing identity compiled
into an official build; a source package without that policy refuses admission.
Linux automatic installation requires a managed desktop installation and a
release admitted by the independently pinned signing key. Unmanaged source
packages keep the ordinary manual source-build workflow.

## Use the workspace

1. Open Vellum Command and choose the local Command Center role when prompted.
2. Add agent seats, terminals, pages, tasks, and notes to the canvas.
3. Connect nodes with the relationship you want, such as an agent contributing to
   a task queue or navigating a page.
4. Open a terminal or agent surface to work. Ordinary agents act through the
   connected work and browser tools. A human-toggled overseer may author
   through closed `overseer` commands without those edges.

The app owns its durable SQLite state at
`~/.vellum-command/state/vellum-command.db`. JSON Canvas is an explicit export
format, not a file that agents edit to change the running application.

Local terminal processes belong to the application and stop when it quits. Remote
execution is part of the experimental Fleet feature, not a promise of persistent
local terminals.

## Agent tools

Build the CLI with `bun run cli:build`; the result is `dist/vellum-command`.
Packaged applications include the same CLI as `bin/vellum-command`.

```sh
dist/vellum-command doctor
dist/vellum-command capabilities
dist/vellum-command onboard
```

Protected operations require the CLI to run under an agent process registered by
the running app. Identity comes from that process, and access comes from the
operator's connected edges and ports. There is no client-supplied identity or
separate browser grant token.

Operator projection tools use the running application's control socket:

```sh
bun run canvas:ls
bun run digest
bun run render
```

They produce readable canvas projections without opening the product database.
See [the security doctrine](docs/security-doctrine.md),
[the Work and Station contract](docs/vellum-protocol.md), and
[the pad guide](docs/pad.md) for the detailed boundaries.

## Development checks

```sh
bun run verify             # lints, typecheck, tests, ship-profile checks, compile
bun run test:e2e           # all-on GUI smoke: startup spec only
bun run test:e2e:fast <spec>  # targeted GUI spec against an existing build
bun run test:e2e:audit     # design-audit capture (explicit tool, not routine)
bun run test:e2e:full      # full GUI regression suite (all specs; not routine)
```

E2E uses an existing desktop session on Linux and can fall back to Xvfb in headless
environments. It seeds application fixtures; discovery and provider views may
still observe the host environment. Keep generated screenshots, application state,
secrets, and scan reports out of commits, and isolate inputs for public media.

## Security and license

Report suspected vulnerabilities privately through [SECURITY.md](SECURITY.md).
The trust model is one operator with trusted but fallible attached agents; the app
enforces its own process, edge, peer, and update boundaries.

Project-owned source is licensed under [Apache-2.0](LICENSE). Third-party software
and separately identified assets retain their own notices; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
